import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { maxPlugin, initializeBot, getBot } from "./channel.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { unlinkSync } from "fs";
import { writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

function isGroupChat(chatType: string): boolean {
  return chatType === "chat" || chatType === "group" || chatType === "channel";
}

// Deduplication: messageId → timestamp (TTL 5 min)
const seenMessages = new Map<number, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000;

function isDuplicate(messageId: number): boolean {
  const now = Date.now();
  // Clean expired entries
  for (const [id, ts] of seenMessages.entries()) {
    if (now - ts > DEDUP_TTL_MS) {
      seenMessages.delete(id);
    }
  }
  if (seenMessages.has(messageId)) {
    return true;
  }
  seenMessages.set(messageId, now);
  return false;
}

// Groq Whisper transcription
async function transcribeAudio(url: string, token: string, logger: any): Promise<string | null> {
  const tmpPath = join(tmpdir(), `max-audio-${Date.now()}.ogg`);
  try {
    // Download file
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    await writeFile(tmpPath, Buffer.from(buf));

    // Transcribe via Groq
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(buf)]), "audio.ogg");
    form.append("model", "whisper-large-v3");
    form.append("language", "ru");

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      logger.warn("[MAX Plugin] GROQ_API_KEY not set, skipping transcription");
      return null;
    }

    const groqResp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}` },
      body: form,
    });

    if (!groqResp.ok) {
      const errText = await groqResp.text();
      throw new Error(`Groq transcription failed: ${groqResp.status} ${errText}`);
    }

    const groqJson = (await groqResp.json()) as { text?: string };
    return groqJson.text || null;
  } catch (err: any) {
    logger.error("[MAX Plugin] Audio transcription error: " + err.message);
    return null;
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

// Build inbound context from raw message data
async function buildInboundContext(params: {
  api: OpenClawPluginApi;
  messageId: number;
  text: string | null;
  senderId: string;
  senderName: string;
  chatId: string;
  chatType: string;
  attachments?: any[];
  token: string;
}) {
  const { api, messageId, text, senderId, senderName, chatId, chatType, attachments, token } = params;
  const bot = getBot();
  const isGroup = isGroupChat(chatType);

  let finalText = text || "";

  // Process audio attachments (transcription)
  api.logger?.info(`[MAX] Processing ${attachments?.length || 0} attachments`);
  
  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      api.logger?.info(`[MAX] Attachment type=${att.type}, hasUrl=${!!att.payload?.url}, hasToken=${!!att.payload?.token}`);
      if (att.type === "audio" && att.payload?.url && att.payload?.token) {
        const transcription = await transcribeAudio(att.payload.url, att.payload.token, api.logger);
        if (transcription) {
          finalText = finalText ? `${finalText}\n[Voice]: ${transcription}` : `[Voice]: ${transcription}`;
        }
      }
    }
  }

  // Build media context from attachments
  const mediaInputs: any[] = [];
  
  api.logger?.info(`[MAX] Building media context, attachments count=${attachments?.length || 0}`);
  
  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      // MAX API has different payload structures:
      // - image: payload has photo_id, token, and url in 'ls' array (ls[0] = full size)
      // - file: payload has url directly
      // - video: payload has url directly
      let url = att.payload?.url || null;
      if (!url && att.payload?.ls && Array.isArray(att.payload.ls) && att.payload.ls.length > 0) {
        url = att.payload.ls[0];
      }
      api.logger?.info(`[MAX] Attachment type=${att.type}, url=${url?.substring(0, 80) || 'none'}, ls=${JSON.stringify(att.payload?.ls || []).substring(0, 100)}, payload=${JSON.stringify(att.payload).substring(0, 200)}`);
      
      if (att.type === "image" && url) {
        mediaInputs.push({
          kind: "image",
          url: url,
          contentType: "image/jpeg",
        });
      } else if (att.type === "video" && url) {
        mediaInputs.push({
          kind: "video",
          url: url,
          contentType: "video/mp4",
        });
      } else if (att.type === "file" && url) {
        mediaInputs.push({
          kind: "document",
          url: url,
          contentType: att.payload?.filename?.endsWith('.pdf') ? "application/pdf" : "application/octet-stream",
        });
      }
    }
  }

  // Build media payload for ctxPayload
  const mediaPayload = mediaInputs.length > 0 ? {
    MediaUrls: mediaInputs.map(m => m.url),
    MediaTypes: mediaInputs.map(m => m.contentType),
    MediaPaths: mediaInputs.map(m => m.url),
  } : undefined;
  
  api.logger?.info(`[MAX] Media payload built: ${mediaInputs.length} items, urls=${JSON.stringify(mediaPayload?.MediaUrls?.map(u => u.substring(0, 80)) || [])}`);

  api.logger.info(
    `[MAX] inbound: chat=${chatId} type=${isGroup ? "group" : "direct"} from=${senderId} preview="${finalText?.substring(0, 50)}"`
  );

  return {
    channel: "max" as const,
    accountId: "max-account",
    raw: {
      messageId,
      text: finalText,
      senderId,
      senderName,
      chatId,
      chatType,
      attachments,
    },
    adapter: {
      ingest: (raw: any) => ({
        id: raw.messageId,
        rawText: raw.text,
        raw: raw,
      }),
      resolveTurn: async (_input: any, _eventClass: any, _preflight: any) => {
        return {
          cfg: api.runtime!.config.current() as any,
          channel: "max" as const,
          accountId: "max-account",
          agentId: "default",
          routeSessionKey: `max:${chatId}`,
          storePath: `max/${chatId}`,
          ctxPayload: {
            Body: finalText,
            BodyForAgent: finalText,
            RawBody: finalText,
            CommandBody: finalText,
            BodyForCommands: finalText,
            From: senderId,
            To: chatId,
            SessionKey: `max:${chatId}`,
            MessageSid: String(messageId),
            InboundEventKind: "user_request" as const,
            Sender: {
              id: senderId,
              name: senderName,
            },
            Conversation: {
              kind: isGroup ? "group" : "direct",
              id: chatId,
            },
            CommandAuthorized: false,
            ...mediaPayload,
          },
          recordInboundSession: async (_session: any) => {
            // Session recorded
          },
          dispatchReplyWithBufferedBlockDispatcher: async (params: any) => {
            return await dispatchReplyWithBufferedBlockDispatcher({
              ctx: params.ctx,
              cfg: params.cfg,
              dispatcherOptions: {
                ...params.dispatcherOptions,
                typingCallbacks: {
                  onReplyStart: async () => {
                    if (bot) {
                      try {
                        await bot.api.sendAction(Number(chatId), "typing_on");
                      } catch (e) {
                        // ignore typing errors
                      }
                    }
                  },
                  onReplyEnd: async () => {
                    // typing stops automatically
                  },
                },
                deliver: async (payload: any, _info: any) => {
                  if (bot) {
                    if (isGroup) {
                      await bot.api.sendMessageToChat(
                        Number(chatId),
                        payload.text,
                        { format: "markdown" }
                      );
                    } else {
                      await bot.api.sendMessageToUser(
                        Number(senderId),
                        payload.text,
                        { format: "markdown" }
                      );
                    }
                  }
                },
              },
            });
          },
          delivery: {
            deliver: async (_payload: any, _info: any) => {
              // Fallback delivery
            },
          },
        };
      },
    },
  };
}

export default defineChannelPluginEntry({
  id: "max",
  name: "MAX Messenger",
  description: "MAX Messenger channel plugin for OpenClaw",
  plugin: maxPlugin,
  registerCliMetadata(api) {
    api.registerCli(
      ({ program }) => {
        program.command("max").description("MAX Messenger management");
      },
      {
        descriptors: [
          {
            name: "max",
            description: "MAX Messenger management",
            hasSubcommands: false,
          },
        ],
      }
    );
  },
  async registerFull(api: OpenClawPluginApi) {
    const cfg = api.config as any;
    const token = cfg?.channels?.max?.token as string | undefined;

    if (!token) {
      api.logger.warn("[MAX Plugin] No token found, bot not initialized");
      return;
    }

    const bot = initializeBot(token);
    let webhookActive = false;

    // --- Webhook handler (primary) ---
    api.registerHttpRoute({
      path: "/max/webhook",
      auth: "plugin",
      handler: async (req, res) => {
        try {
          const body = await new Promise<string>((resolve, reject) => {
            let data = "";
            req.on("data", (chunk) => (data += chunk));
            req.on("end", () => resolve(data));
            req.on("error", reject);
          });

          const update = JSON.parse(body);

          api.logger?.info(`[MAX] Webhook received update_type=${update.update_type}, hasMessage=${!!update.message}, body=${JSON.stringify(update.message?.body || {}).substring(0, 200)}`);

          if (update.update_type === "message_created" && update.message) {
            const message = update.message;
            const sender = message.sender || {};
            const recipient = message.recipient || {};
            const messageId = message.body?.mid || message.id;
            const numericMessageId = Number(messageId);

            if (isDuplicate(numericMessageId)) {
              res.statusCode = 200;
              res.end("ok");
              return true;
            }

            const inbound = await buildInboundContext({
              api: api!,
              messageId: numericMessageId,
              text: message.body?.text || message.text || null,
              senderId: String(sender.user_id || message.sender_id),
              senderName: sender.name || sender.first_name || "Unknown",
              chatId: String(recipient.chat_id || message.chat_id),
              chatType: recipient.chat_type || "dialog",
              attachments: (message.attachments?.length > 0 ? message.attachments : null) || message.body?.attachments || undefined,
              token,
            });

            if (!api.runtime) {
              api.logger.warn("[MAX Plugin] api.runtime not available, skipping inbound");
              res.statusCode = 200;
              res.end("ok");
              return true;
            }

            await api.runtime.channel.inbound.run(inbound);
          }

          res.statusCode = 200;
          res.end("ok");
          return true;
        } catch (err: any) {
          api.logger.error("[MAX Plugin] Webhook error: " + err.message);
          res.statusCode = 500;
          res.end("error");
          return true;
        }
      },
    });

    // --- Health check + fallback to polling ---
    try {
      // Attempt a lightweight API call as health check
      await bot.api.getMyInfo?.();
      webhookActive = true;
      api.logger.info("[MAX Plugin] Webhook mode active (health check passed)");
    } catch (err: any) {
      api.logger.warn("[MAX Plugin] Webhook health check failed, falling back to polling: " + err.message);
    }

    if (!webhookActive) {
      // Fallback: polling mode
      bot.on("message_created", async (ctx: any) => {
        const message = ctx.message;
        const user = ctx.user;
        const messageId = message.id;

        if (isDuplicate(Number(messageId))) {
          return;
        }

        const numericMessageId = Number(messageId);
        const inbound = await buildInboundContext({
          api: api!,
          messageId: numericMessageId,
          text: message.text || null,
          senderId: String(user.user_id),
          senderName: user.name || "Unknown",
          chatId: String(message.chat_id),
          chatType: message.chat_type || "dialog",
          attachments: message.attachments || undefined,
          token,
        });

        if (!api.runtime) {
          api.logger.warn("[MAX Plugin] api.runtime not available, skipping inbound (polling)");
          return;
        }

        await api.runtime.channel.inbound.run(inbound);
      });

      bot
        .start({ allowedUpdates: ["message_created"] })
        .catch((err: any) => {
          api.logger.error("[MAX Plugin] Failed to start bot polling: " + err.message);
        });
    }
  },
});