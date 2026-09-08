import { timingSafeEqual } from "node:crypto";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { getBot, getMaxFetch, maxPlugin, runOutsideInheritedRootWork, setMaxUpdateHandler, DEFAULT_ACCOUNT_ID, MAX_CHANNEL_ID } from "./channel.js";
import {
  resolveReplyKeyboardButtons,
  toInlineKeyboardAttachment,
  type MaxInlineKeyboardAttachment,
} from "./src/keyboards.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

/** MAX caps message text at 4000 chars. */
const MAX_TEXT_LIMIT = 4000;
// Deduplication: messageId → timestamp (TTL 5 min)
const seenMessages = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000;

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
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

function chunkText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks.length > 0 ? chunks : [""];
}

type InboundFacts = {
  messageId: string;
  text: string;
  senderId: string;
  senderName: string;
  senderIsBot: boolean;
  chatId: string;
  isGroup: boolean;
  timestamp?: number;
  attachments?: any[];
  /** Present on message_callback: id for POST /answers acknowledgement. */
  callbackId?: string;
  /**
   * Full delivery target override (`max:…`) for the reply path. Set on
   * message_callback without a source message: the bare user id is not a chat
   * id (replying into it 404s), so the reply must go to `max:user:<id>`.
   */
  replyTarget?: string;
};

/** Normalize a raw MAX update (webhook or polling) into inbound facts. */
function extractInboundFacts(update: any): InboundFacts | null {
  const type = update?.update_type;

  if (type === "message_created" && update.message) {
    const m = update.message;
    const sender = m.sender ?? {};
    const recipient = m.recipient ?? {};
    const body = m.body ?? {};
    const chatId = recipient.chat_id ?? m.chat_id ?? update.chat_id;
    const senderId = sender.user_id ?? m.sender_id;
    if (chatId == null || senderId == null) return null;
    const senderName =
      sender.name ||
      [sender.first_name, sender.last_name].filter(Boolean).join(" ") ||
      "Unknown";

    // Forwards with visible attribution carry the content in link.message (body
    // is empty); hidden-attribution forwards and replies keep content in body.
    const link = m.link ?? undefined;
    const linkBody = link?.message ?? {};
    let text = body.text ?? m.text ?? "";
    let attachments = m.attachments ?? body.attachments ?? undefined;
    const linkSenderName = link
      ? link.sender?.name ||
        [link.sender?.first_name, link.sender?.last_name].filter(Boolean).join(" ")
      : "";
    if (link?.type === "forward") {
      if (!text && linkBody.text) text = linkBody.text;
      if (!attachments && linkBody.attachments) attachments = linkBody.attachments;
      const marker = linkSenderName ? `[Forwarded from ${linkSenderName}]` : "[Forwarded]";
      text = text ? `${marker}\n${text}` : marker;
    } else if (link?.type === "reply") {
      const quote =
        typeof linkBody.text === "string"
          ? linkBody.text.replace(/\s+/g, " ").trim()
          : "";
      const clipped = quote.length > 200 ? `${quote.slice(0, 199)}…` : quote;
      const marker = clipped
        ? `[Reply to ${linkSenderName || "unknown"}: "${clipped}"]`
        : `[Reply to ${linkSenderName || "unknown"}]`;
      text = text ? `${marker}\n${text}` : marker;
    }

    return {
      messageId: String(body.mid ?? m.id ?? `${chatId}:${body.seq ?? m.timestamp ?? Date.now()}`),
      text,
      senderId: String(senderId),
      senderName,
      senderIsBot: Boolean(sender.is_bot),
      chatId: String(chatId),
      isGroup: (recipient.chat_type ?? m.chat_type ?? "dialog") !== "dialog",
      timestamp: m.timestamp,
      attachments,
    };
  }

  // "Начать" button pressed in a dialog; payload carries the deep-link parameter
  if (type === "bot_started") {
    const user = update.user ?? {};
    const chatId = update.chat_id ?? user.user_id;
    if (chatId == null || user.user_id == null) return null;
    const payload = typeof update.payload === "string" && update.payload ? ` ${update.payload}` : "";
    return {
      messageId: `bot_started:${chatId}:${update.timestamp ?? Date.now()}`,
      text: `/start${payload}`,
      senderId: String(user.user_id),
      senderName: user.name || [user.first_name, user.last_name].filter(Boolean).join(" ") || "Unknown",
      senderIsBot: false,
      chatId: String(chatId),
      isGroup: false,
      timestamp: update.timestamp,
    };
  }

  // Inline keyboard button press: synthesize a regular inbound message from the
  // callback payload (donor `processCallback` pattern). The button label is not
  // echoed by MAX — agents receive the payload, so button payloads should be
  // self-describing (plain strings become payload=text in the send path). The
  // text of the message the button was attached to usually is echoed, so it is
  // quoted after the payload to give the agent the context of the press.
  if (type === "message_callback") {
    const cb = update.callback;
    if (!cb?.user?.user_id || !cb.callback_id) return null;
    const payload = typeof cb.payload === "string" ? cb.payload : "";
    if (!payload.trim()) return null;
    const user = cb.user;
    const msgChatId =
      update.message?.recipient?.chat_id ?? update.message?.chat_id ?? update.chat_id;
    const chatId = msgChatId ?? user.user_id;
    const sourceText =
      typeof update.message?.body?.text === "string"
        ? update.message.body.text.replace(/\s+/g, " ").trim()
        : "";
    const clipped = sourceText.length > 200 ? `${sourceText.slice(0, 199)}…` : sourceText;
    const text = clipped ? `${payload}\n[Button on: "${clipped}"]` : payload;
    return {
      messageId: `callback:${cb.callback_id}`,
      text,
      senderId: String(user.user_id),
      senderName:
        user.name || [user.first_name, user.last_name].filter(Boolean).join(" ") || "Unknown",
      senderIsBot: Boolean(user.is_bot),
      chatId: String(chatId),
      replyTarget: msgChatId != null ? undefined : `max:user:${user.user_id}`,
      isGroup: (update.message?.recipient?.chat_type ?? "dialog") !== "dialog",
      timestamp: cb.timestamp,
      callbackId: cb.callback_id,
    };
  }

  return null;
}

function attachmentContentType(att: any): string {
  if (att?.type === "image") return "image/jpeg";
  if (att?.type === "video") return "video/mp4";
  if (att?.type === "file") {
    return att?.payload?.filename?.endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
  }
  return "application/octet-stream";
}

/** Attachment URLs live on MAX infrastructure and accept the bot/file token. */
function attachmentNeedsAuth(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)max\.ru$/.test(host) || /(^|\.)oneme\.ru$/.test(host);
  } catch {
    return false;
  }
}

async function downloadAttachment(url: string, token?: string): Promise<Buffer> {
  const headers =
    token && attachmentNeedsAuth(url) ? { Authorization: `Bearer ${token}` } : undefined;
  const resp = await getMaxFetch()(url, headers ? { headers } : undefined);
  if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Transcribe a saved audio file through the core media-understanding pipeline.
 * Provider, API key and language all come from the gateway operator's
 * `tools.media.audio` config; returns null when no STT provider is configured.
 */
async function transcribeSavedAudio(
  api: OpenClawPluginApi,
  filePath: string,
  mime: string,
): Promise<string | null> {
  const mu = (api as any).runtime?.mediaUnderstanding;
  if (!mu?.transcribeAudioFile) return null;
  try {
    const cfg = (api as any).runtime.config.current();
    const res = await mu.transcribeAudioFile({ filePath, cfg, mime });
    return res?.text ?? null;
  } catch (err: any) {
    api.logger.warn(`[MAX] audio transcription skipped: ${err.message}`);
    return null;
  }
}

type MediaFact = {
  path?: string;
  url?: string;
  contentType?: string;
  kind: "image" | "video" | "audio" | "document" | "unknown";
  transcribed?: boolean;
};

/** Download attachments into the media store; voice is transcribed by the core media-understanding pipeline (`tools.media.audio`). */
async function buildTextAndMedia(
  api: OpenClawPluginApi,
  facts: InboundFacts,
  token: string,
): Promise<{ text: string; media: MediaFact[] }> {
  const rt = (api as any).runtime?.channel;
  const media: MediaFact[] = [];
  let text = facts.text;

  for (const att of facts.attachments ?? []) {
    const url = att?.payload?.url ?? (Array.isArray(att?.payload?.ls) ? att.payload.ls[0] : undefined);
    if (!url) continue;

    if (att.type === "audio") {
      const audioContentType = att?.payload?.contentType ?? "audio/ogg";
      try {
        const buf = await downloadAttachment(url, att?.payload?.token ?? token);
        if (!rt?.media?.saveMediaBuffer) {
          media.push({ url, contentType: audioContentType, kind: "audio" });
          continue;
        }
        const saved = await rt.media.saveMediaBuffer(
          buf,
          audioContentType,
          "inbound",
          undefined,
          att?.payload?.filename,
        );
        const transcript = await transcribeSavedAudio(api, saved.path, saved.contentType ?? audioContentType);
        if (transcript) {
          text = text ? `${text}\n[Voice]: ${transcript}` : `[Voice]: ${transcript}`;
        }
        media.push({
          path: saved.path,
          url: saved.path,
          contentType: saved.contentType ?? audioContentType,
          kind: "audio",
          transcribed: Boolean(transcript),
        });
      } catch (err: any) {
        api.logger.warn(`[MAX] audio attachment handling failed: ${err.message}`);
        media.push({ url, contentType: audioContentType, kind: "audio" });
      }
      continue;
    }

    const kind: MediaFact["kind"] =
      att.type === "image" ? "image" : att.type === "video" ? "video" : att.type === "file" ? "document" : "unknown";
    if (kind === "unknown") continue;

    const contentType = attachmentContentType(att);
    try {
      const buf = await downloadAttachment(url, att?.payload?.token ?? token);
      if (rt?.media?.saveMediaBuffer) {
        const saved = await rt.media.saveMediaBuffer(buf, contentType, "inbound", undefined, att?.payload?.filename);
        media.push({ path: saved.path, url: saved.path, contentType: saved.contentType ?? contentType, kind });
      } else {
        media.push({ url, contentType, kind });
      }
    } catch (err: any) {
      api.logger.warn(`[MAX] attachment download failed: ${err.message}`);
      media.push({ url, contentType, kind });
    }
  }

  return { text, media };
}

/** Feed one normalized inbound message into the OpenClaw runtime. */
async function runInbound(api: OpenClawPluginApi, facts: InboundFacts, token: string): Promise<void> {
  const rt = (api as any).runtime?.channel;
  if (!rt?.inbound?.run) {
    api.logger.warn("[MAX] api.runtime.channel not available, skipping inbound");
    return;
  }

  const { text, media } = await buildTextAndMedia(api, facts, token);
  const { chatId, senderId, senderName, isGroup } = facts;

  api.logger.info(
    `[MAX] inbound: chat=${chatId} type=${isGroup ? "group" : "direct"} from=${senderId} preview="${text.substring(0, 50)}"`
  );

  await rt.inbound.run({
    channel: MAX_CHANNEL_ID,
    accountId: DEFAULT_ACCOUNT_ID,
    raw: facts,
    adapter: {
      ingest: (raw: InboundFacts) => ({
        id: raw.messageId,
        timestamp: raw.timestamp,
        rawText: text,
        textForAgent: text,
        textForCommands: text,
        raw,
      }),
      resolveTurn: async () => {
        const cfg = (api as any).runtime.config.current();

        // Canonical routing: bindings may map this peer to a specific agent
        const route = rt.routing.resolveAgentRoute({
          cfg,
          channel: MAX_CHANNEL_ID,
          accountId: DEFAULT_ACCOUNT_ID,
          peer: { kind: isGroup ? "group" : "direct", id: isGroup ? chatId : senderId },
        });

        // Default-route DMs get per-peer sessions instead of collapsing into
        // the agent main session (same override the Telegram channel applies)
        let sessionKey = route.sessionKey;
        if (!isGroup && route.matchedBy === "default") {
          sessionKey = rt.routing.buildAgentSessionKey({
            agentId: route.agentId,
            channel: MAX_CHANNEL_ID,
            accountId: route.accountId,
            peer: { kind: "direct", id: senderId },
            dmScope: "per-account-channel-peer",
            identityLinks: cfg.session?.identityLinks,
          });
        }

        const storePath = rt.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });

        const ctxPayload = rt.inbound.buildContext({
          channel: MAX_CHANNEL_ID,
          accountId: route.accountId,
          provider: "max",
          surface: "max",
          messageId: facts.messageId,
          timestamp: facts.timestamp,
          from: isGroup ? `max:group:${chatId}` : `max:${senderId}`,
          sender: { id: senderId, name: senderName, isBot: facts.senderIsBot },
          conversation: {
            kind: isGroup ? "group" : "direct",
            id: chatId,
            label: isGroup ? `MAX chat ${chatId}` : senderName,
          },
          route: {
            agentId: route.agentId,
            accountId: route.accountId,
            routeSessionKey: sessionKey,
            mainSessionKey: route.mainSessionKey,
          },
          reply: { to: facts.replyTarget ?? `max:${chatId}` },
          message: {
            inboundEventKind: "user_request",
            rawBody: text,
            body: text,
            bodyForAgent: text,
            commandBody: text,
          },
          access: { commands: { authorized: false, useAccessGroups: false, allowTextCommands: true } },
          media: media.length > 0 ? media : undefined,
        });

        const sendTyping = async () => {
          const bot = getBot();
          // sendAction needs a real chat id — no chat exists on the user-target path
          if (bot && replyUserId == null) {
            await bot.api.sendAction(Number(chatId), "typing_on");
          }
        };

        // message_callback without a source message: there is no chat to reply
        // into (the bare user id as chat_id 404s), so answer the user directly.
        const replyUserId =
          facts.replyTarget != null
            ? Number(facts.replyTarget.replace(/^max:user:/i, ""))
            : null;
        const sendReplyMessage = (
          bot: NonNullable<ReturnType<typeof getBot>>,
          text: string,
          extra?: Record<string, unknown>,
        ): Promise<any> =>
          replyUserId != null
            ? bot.api.sendMessageToUser(replyUserId, text, extra as any)
            : bot.api.sendMessageToChat(Number(chatId), text, extra as any);

        // --- Draft streaming: cumulative partial replies edit one draft message ---
        const streamingEnabled = (cfg.channels as any)?.[MAX_CHANNEL_ID]?.streaming !== false;
        const STREAM_EDIT_INTERVAL_MS = 800;
        const draft = {
          mid: null as string | null,
          accumulated: "",
          lastEditAt: 0,
          chain: Promise.resolve() as Promise<void>,
        };
        const extractMid = (sent: any): string | null => {
          const mid = sent?.message?.body?.mid ?? sent?.body?.mid ?? sent?.id;
          return mid != null ? String(mid) : null;
        };
        const editDraft = (
          text: string,
          final: boolean,
          attachments?: MaxInlineKeyboardAttachment[],
        ): Promise<void> => {
          draft.chain = draft.chain.then(async () => {
            const bot = getBot();
            if (!bot || !draft.mid) return;
            try {
              await bot.api.editMessage(draft.mid, {
                text,
                format: "markdown",
                ...(attachments ? { attachments } : {}),
              });
            } catch {
              // invalid markdown must not lose the reply
              try {
                await bot.api.editMessage(draft.mid, { text, ...(attachments ? { attachments } : {}) });
              } catch {
                // best-effort preview
              }
            }
            draft.lastEditAt = Date.now();
            if (!final) {
              // MAX clears the typing indicator on edit — renew it
              if (replyUserId == null) bot.api.sendAction(Number(chatId), "typing_on").catch(() => {});
            }
          });
          return draft.chain;
        };
        const onPartialReply = async (payload: any): Promise<boolean> => {
          if (!streamingEnabled) return false;
          const text = typeof payload?.text === "string" ? payload.text : "";
          if (!text.trim()) return false;
          const bot = getBot();
          if (!bot) return false;
          draft.accumulated = text;
          const preview = text.slice(0, MAX_TEXT_LIMIT - 2) + " …";
          if (!draft.mid) {
            try {
              draft.mid = extractMid(
                await sendReplyMessage(bot, preview, { format: "markdown" }),
              );
            } catch {
              draft.mid = null;
            }
            draft.lastEditAt = Date.now();
            return Boolean(draft.mid);
          }
          // Throttle edits; deliver() writes the authoritative final text
          if (Date.now() - draft.lastEditAt < STREAM_EDIT_INTERVAL_MS) return true;
          await editDraft(preview, false);
          return true;
        };

        return {
          channel: MAX_CHANNEL_ID,
          accountId: route.accountId,
          routeSessionKey: sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: rt.session.recordInboundSession,
          record: {
            updateLastRoute: {
              sessionKey,
              channel: MAX_CHANNEL_ID,
              to: facts.replyTarget ?? `max:${chatId}`,
              accountId: route.accountId,
            },
            onRecordError: (err: unknown) =>
              api.logger.warn(`[MAX] session record failed: ${(err as Error)?.message ?? err}`),
          },
          runDispatch: () =>
            rt.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: ctxPayload,
              cfg,
              dispatcherOptions: {
                typingCallbacks: createTypingCallbacks({
                  start: sendTyping,
                  onStartError: () => {
                    // typing is best-effort
                  },
                  keepaliveIntervalMs: 4000,
                  maxDurationMs: 120000,
                }),
                deliver: async (payload: any) => {
                  const bot = getBot();
                  const out = typeof payload?.text === "string" ? payload.text : "";
                  if (!bot) return undefined;
                  // Inline keyboard travels on the payload as opaque
                  // channelData (the core forwards it untouched); it is
                  // attached only to the final authoritative message — never
                  // to streaming draft edits.
                  let keyboardButtons: ReturnType<typeof resolveReplyKeyboardButtons> = null;
                  try {
                    keyboardButtons = resolveReplyKeyboardButtons(payload?.channelData);
                  } catch (err: any) {
                    api.logger.warn(`[MAX] invalid maxInlineKeyboard, sending without keyboard: ${err?.message ?? err}`);
                  }
                  const keyboardAttachment = keyboardButtons
                    ? toInlineKeyboardAttachment(keyboardButtons)
                    : undefined;
                  if (draft.mid) {
                    // The draft exists: edit it into the authoritative final text
                    // (no cursor), then send any overflow chunks as new messages.
                    // The keyboard rides on the final edit of the draft message.
                    const finalText = out.trim() ? out : draft.accumulated;
                    const chunks = chunkText(finalText, MAX_TEXT_LIMIT);
                    await editDraft(
                      chunks[0] ?? "",
                      true,
                      keyboardAttachment ? [keyboardAttachment] : undefined,
                    );
                    const messageIds = [draft.mid];
                    for (const chunk of chunks.slice(1)) {
                      let sent;
                      try {
                        sent = await sendReplyMessage(bot, chunk, { format: "markdown" });
                      } catch {
                        sent = await sendReplyMessage(bot, chunk);
                      }
                      const mid = extractMid(sent);
                      if (mid) messageIds.push(mid);
                    }
                    return { messageIds };
                  }
                  if (!out.trim()) return undefined;
                  const chunks = chunkText(out, MAX_TEXT_LIMIT);
                  const messageIds: string[] = [];
                  for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    // Keyboard goes on the last chunk — the final message.
                    const attachments =
                      i === chunks.length - 1 && keyboardAttachment ? [keyboardAttachment] : undefined;
                    let sent;
                    try {
                      sent = await sendReplyMessage(bot, chunk, {
                        format: "markdown",
                        ...(attachments ? { attachments } : {}),
                      });
                    } catch {
                      // invalid markdown must not lose the reply
                      sent = await sendReplyMessage(bot, chunk, {
                        ...(attachments ? { attachments } : {}),
                      });
                    }
                    const mid = extractMid(sent);
                    if (mid) messageIds.push(mid);
                  }
                  return messageIds.length > 0 ? { messageIds } : undefined;
                },
                onError: (err: any) => {
                  api.logger.error(`[MAX] reply dispatch error: ${err?.message ?? err}`);
                },
              },
              replyOptions: { onPartialReply },
            }),
        };
      },
    },
  });
}

/** Shared update handler for webhook and polling transports. */
export async function handleUpdate(api: OpenClawPluginApi, update: any, token: string): Promise<void> {
  const facts = extractInboundFacts(update);
  if (!facts) return;

  // Loop protection: never react to other bots (or our own echo)
  if (facts.senderIsBot) return;

  if (isDuplicate(facts.messageId)) {
    api.logger.info(`[MAX] duplicate message ${facts.messageId} ignored`);
    return;
  }

  // Inline keyboard callbacks: MAX shows a spinner on the button until the
  // bot answers; acknowledge immediately (empty answer — no notification).
  // The synthesized inbound still runs the full agent turn.
  if (facts.callbackId) {
    const bot = getBot();
    if (bot) {
      try {
        await bot.api.answerOnCallback(facts.callbackId, { message: null });
      } catch (err: any) {
        api.logger.warn(`[MAX] answerOnCallback failed: ${err?.message ?? err}`);
      }
    }
  }

  await runInbound(api, facts, token);
}

export default defineChannelPluginEntry({
  id: MAX_CHANNEL_ID,
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
    const section = cfg?.channels?.[MAX_CHANNEL_ID];
    const token = section?.token as string | undefined;

    if (!token) {
      api.logger.warn("[MAX] No token found, bot not initialized");
      return;
    }

    // The channel gateway lifecycle (gateway.startAccount) owns bot startup;
    // here we expose the inbound handler and the webhook HTTP route.
    setMaxUpdateHandler((update, handlerToken) => handleUpdate(api, update, handlerToken));

    // --- Webhook handler ---
    api.registerHttpRoute({
      path: "/max/webhook",
      auth: "plugin",
      handler: async (req, res) => {
        try {
          if (section?.webhookSecret) {
            const header = req.headers["x-max-bot-api-secret"];
            const provided = Array.isArray(header) ? header[0] : header;
            const expected = String(section.webhookSecret);
            const authorized =
              typeof provided === "string" &&
              provided.length === expected.length &&
              timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
            if (!authorized) {
              res.statusCode = 403;
              res.end("forbidden");
              return true;
            }
          }

          const body = await new Promise<string>((resolve, reject) => {
            let data = "";
            req.on("data", (chunk) => (data += chunk));
            req.on("end", () => resolve(data));
            req.on("error", reject);
          });

          const update = JSON.parse(body);

          // MAX requires a timely HTTP 200; process after ACK. The request's
          // root-work admission ends with the response, so detach the async
          // processing from that context (see runOutsideInheritedRootWork).
          res.statusCode = 200;
          res.end("ok");

          runOutsideInheritedRootWork(() =>
            handleUpdate(api, update, token).catch((err: any) =>
              api.logger.error("[MAX] update handling failed: " + (err?.message ?? err))
            )
          );
          return true;
        } catch (err: any) {
          api.logger.error("[MAX] Webhook error: " + err.message);
          res.statusCode = 500;
          res.end("error");
          return true;
        }
      },
    });
  },
});
