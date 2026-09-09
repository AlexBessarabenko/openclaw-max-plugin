import { timingSafeEqual } from "node:crypto";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
import { getBot, getMaxFetch, maxPlugin, normalizeMaxTarget, runOutsideInheritedRootWork, setMaxUpdateHandler, resolveGroupPolicyWarning, resolveMaxSendOptions, DEFAULT_ACCOUNT_ID, MAX_CHANNEL_ID } from "./channel.js";
import {
  resolveReplyKeyboardButtons,
  toInlineKeyboardAttachment,
  type MaxInlineKeyboardAttachment,
} from "./src/keyboards.js";
import {
  downloadRemoteMedia,
  MAX_ATTACHMENT_BYTES,
  MAX_INBOUND_ATTACHMENTS,
} from "./src/media-access.js";
import { createMaxSendFileTool } from "./src/send-file-tool.js";
import { isDuplicate } from "./src/dedup.js";
import { rememberStickerCode } from "./src/stickers.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { resolveDmGroupAccessWithLists } from "openclaw/plugin-sdk/channel-policy";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";

/** MAX caps message text at 4000 chars. */
const MAX_TEXT_LIMIT = 4000;

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
  /** Present when the message is a reply: the original sender (for reply-to-bot mention). */
  replyToSenderId?: string;
  replyToSenderIsBot?: boolean;
};

/**
 * Mids of our own streaming-draft messages. MAX echoes the bot's edits back as
 * message_edited updates; without this filter every draft edit would re-enter
 * the inbound pipeline and loop the agent.
 */
const ownDraftMids = new Set<string>();
const OWN_DRAFT_MIDS_LIMIT = 1000;

function noteOwnDraftMid(mid: string | null): void {
  if (!mid) return;
  if (ownDraftMids.size >= OWN_DRAFT_MIDS_LIMIT) ownDraftMids.clear();
  ownDraftMids.add(mid);
}

/** Normalize a raw MAX update (webhook or polling) into inbound facts. */
function extractInboundFacts(update: any): InboundFacts | null {
  const type = update?.update_type;

  if ((type === "message_created" || type === "message_edited") && update.message) {
    const isEdit = type === "message_edited";
    const m = update.message;
    const sender = m.sender ?? {};
    const recipient = m.recipient ?? {};
    const body = m.body ?? {};
    const chatId = recipient.chat_id ?? m.chat_id ?? update.chat_id;
    const senderId = sender.user_id ?? m.sender_id;
    if (chatId == null || senderId == null) return null;
    const rawMid = body.mid ?? m.id;
    // Our own streaming-draft edits echo back as message_edited — drop them
    // (a non-bot sender with a known draft mid is still our own edit).
    if (isEdit && rawMid != null && ownDraftMids.has(String(rawMid))) return null;
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
    const replyToSender =
      link?.type === "reply"
        ? { replyToSenderId: link.sender?.user_id != null ? String(link.sender.user_id) : undefined,
            replyToSenderIsBot: Boolean(link.sender?.is_bot) }
        : {};
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

    if (isEdit) {
      // The event carries the full new text (no refetch needed). The unique
      // suffix keeps the edit from being swallowed by mid dedup.
      const editedTs = m.timestamp ?? update.timestamp ?? Date.now();
      return {
        messageId: `${rawMid ?? `${chatId}:${body.seq ?? editedTs}`}_edited_${editedTs}`,
        text: text ? `[Edited]\n${text}` : "[Edited]",
        senderId: String(senderId),
        senderName,
        senderIsBot: Boolean(sender.is_bot),
        chatId: String(chatId),
        isGroup: (recipient.chat_type ?? m.chat_type ?? "dialog") !== "dialog",
        timestamp: m.timestamp ?? update.timestamp,
        attachments,
        ...replyToSender,
      };
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
      ...replyToSender,
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
  // SSRF-guarded; the size limit is enforced before/while buffering.
  const { buffer } = await downloadRemoteMedia({
    url,
    fetchImpl: getMaxFetch(),
    headers,
    maxBytes: MAX_ATTACHMENT_BYTES,
  });
  return buffer;
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

/**
 * Inbound video attachments often carry only a token. Resolve a playback URL
 * via getVideoInfo (best available mp4, hls as fallback); urls === null means
 * the video is not ready/available — the message then keeps the plain marker.
 */
async function resolveVideoPlaybackUrl(
  api: OpenClawPluginApi,
  token: string,
): Promise<string | undefined> {
  const bot = getBot();
  if (!bot) return undefined;
  try {
    const info = await (bot.api as any).getVideoInfo(token);
    const urls = info?.urls;
    if (!urls) return undefined;
    return (
      urls.mp4_1080 ??
      urls.mp4_720 ??
      urls.mp4_480 ??
      urls.mp4_360 ??
      urls.mp4_240 ??
      urls.mp4_144 ??
      urls.hls ??
      undefined
    );
  } catch (err: any) {
    api.logger.warn(`[MAX] getVideoInfo failed: ${err?.message ?? err}`);
    return undefined;
  }
}

/** Download attachments into the media store; voice is transcribed by the core media-understanding pipeline (`tools.media.audio`). */
async function buildTextAndMedia(
  api: OpenClawPluginApi,
  facts: InboundFacts,
  token: string,
): Promise<{ text: string; media: MediaFact[] }> {
  const rt = (api as any).runtime?.channel;
  const media: MediaFact[] = [];
  let text = facts.text;

  const attachments = facts.attachments ?? [];
  if (attachments.length > MAX_INBOUND_ATTACHMENTS) {
    api.logger.warn(
      `[MAX] message has ${attachments.length} attachments, only the first ${MAX_INBOUND_ATTACHMENTS} are processed`,
    );
  }

  for (const att of attachments.slice(0, MAX_INBOUND_ATTACHMENTS)) {
    // Stickers: no downloadable media — cache the code per chat (so the agent
    // can resend it) and surface it to the agent as a text marker.
    if (att?.type === "sticker") {
      const code = typeof att?.payload?.code === "string" ? att.payload.code : "";
      if (code) rememberStickerCode(facts.chatId, code);
      const emoji = typeof att?.payload?.emoji === "string" ? att.payload.emoji : "";
      const marker = code
        ? emoji
          ? `[Sticker ${emoji} (code ${code})]`
          : `[Sticker (code ${code})]`
        : "[Sticker]";
      text = text ? `${text}\n${marker}` : marker;
      continue;
    }

    // Location: coordinates are top-level fields (ll=lon,lat on Yandex Maps).
    if (att?.type === "location") {
      const lat = att?.latitude ?? att?.payload?.latitude;
      const lon = att?.longitude ?? att?.payload?.longitude;
      if (lat != null && lon != null) {
        const url = `https://yandex.ru/maps/?ll=${encodeURIComponent(`${lon},${lat}`)}&z=15`;
        const marker = `[Location: ${lat}, ${lon}](${url})`;
        text = text ? `${text}\n${marker}` : marker;
      }
      continue;
    }

    // Contact: display name from the VCard FN line, or the linked MAX profile.
    if (att?.type === "contact") {
      const raw = att?.payload?.vcf_info ?? "";
      const fn = String(raw)
        .split("\n")
        .find((line) => line.startsWith("FN:"))
        ?.slice(3);
      const maxInfo = att?.payload?.max_info;
      const maxName = maxInfo
        ? [maxInfo.first_name, maxInfo.last_name].filter(Boolean).join(" ") ||
          (typeof maxInfo.name === "string" ? maxInfo.name : "")
        : "";
      const name = fn || maxName;
      const marker = `[Contact${name ? `: ${name}` : ""}]`;
      text = text ? `${text}\n${marker}` : marker;
      continue;
    }

    // Share: forwarded post/contact cards carry a title and/or payload.url.
    if (att?.type === "share") {
      const title = typeof att?.title === "string" ? att.title : "";
      const shareUrl = typeof att?.payload?.url === "string" ? att.payload.url : "";
      const label = title && shareUrl ? `${title} (${shareUrl})` : title || shareUrl;
      const marker = `[Shared${label ? `: ${label}` : ""}]`;
      text = text ? `${text}\n${marker}` : marker;
      continue;
    }

    // Anything else we cannot render: tell the agent something arrived instead
    // of dropping it silently.
    const knownMediaType =
      att?.type === "image" || att?.type === "video" || att?.type === "audio" || att?.type === "file";
    if (att?.type && !knownMediaType) {
      const marker = `[Unsupported attachment: ${att.type}]`;
      text = text ? `${text}\n${marker}` : marker;
      continue;
    }

    let url =
      att?.payload?.url ?? (Array.isArray(att?.payload?.ls) ? att.payload.ls[0] : undefined);
    if (!url && att?.type === "video" && att?.payload?.token) {
      url = await resolveVideoPlaybackUrl(api, att.payload.token);
    }
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
              noteOwnDraftMid(draft.mid);
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
                  // Per-message send options: channelData.maxNotify /
                  // maxDisableLinkPreview override the channel config defaults.
                  const sendOpts = resolveMaxSendOptions(cfg, payload?.channelData);
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
                        sent = await sendReplyMessage(bot, chunk, { format: "markdown", ...sendOpts });
                      } catch {
                        sent = await sendReplyMessage(bot, chunk, { ...sendOpts });
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
                        ...sendOpts,
                        ...(attachments ? { attachments } : {}),
                      });
                    } catch {
                      // invalid markdown must not lose the reply
                      sent = await sendReplyMessage(bot, chunk, {
                        ...sendOpts,
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

/**
 * DM access gate — runs BEFORE any attachment download or disk write, so a
 * blocked sender cannot make the plugin fetch or store anything. Group chats
 * are not gated here (group policy is a separate surface). Config policies map
 * onto the SDK vocabulary: "closed" → "disabled"; unset → "allowlist"
 * (matches the security.dm defaultPolicy the plugin reports to core).
 */
async function checkDmAccess(api: OpenClawPluginApi, facts: InboundFacts): Promise<boolean> {
  if (facts.isGroup) return true;
  const rt = (api as any).runtime;
  const cfg = rt?.config?.current?.() ?? (api as any).config ?? {};
  const section = (cfg as any)?.channels?.[MAX_CHANNEL_ID] ?? {};
  const rawPolicy = section.dmPolicy ?? "allowlist";
  const dmPolicy = rawPolicy === "closed" ? "disabled" : rawPolicy;
  if (dmPolicy === "open") return true;

  let storeAllowFrom: string[] = [];
  try {
    storeAllowFrom =
      (await rt?.channel?.pairing?.readAllowFromStore?.({
        channel: MAX_CHANNEL_ID,
        accountId: DEFAULT_ACCOUNT_ID,
      })) ?? [];
  } catch (err: any) {
    api.logger.warn(`[MAX] pairing allowlist read failed: ${err?.message ?? err}`);
  }

  const { decision, reason } = resolveDmGroupAccessWithLists({
    isGroup: false,
    dmPolicy,
    allowFrom: section.allowFrom ?? [],
    storeAllowFrom,
    isSenderAllowed: (allowFrom) =>
      allowFrom.some(
        (entry) =>
          normalizeMaxTarget(String(entry)).replace(/^user:/i, "") === String(facts.senderId),
      ),
  });

  if (decision === "allow") return true;

  api.logger.info(
    `[MAX] inbound dropped by dmPolicy=${rawPolicy}: ${reason} (sender=${facts.senderId})`,
  );

  if (decision === "pairing") {
    try {
      const pairing = createChannelPairingController({
        core: rt,
        channel: MAX_CHANNEL_ID,
        accountId: DEFAULT_ACCOUNT_ID,
      });
      const bot = getBot();
      await pairing.issueChallenge({
        senderId: String(facts.senderId),
        senderIdLine: `maxUserId: ${facts.senderId}`,
        sendPairingReply: async (text: string) => {
          if (bot) {
            await bot.api.sendMessageToUser(Number(facts.senderId), text, { format: "markdown" });
          }
        },
      });
    } catch (err: any) {
      api.logger.warn(`[MAX] pairing challenge failed: ${err?.message ?? err}`);
    }
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Cached bot identity (user id + username) for group mention detection.
 * Fetched lazily via getBot() on first use — through the exported getter so
 * tests and re-initialization both see the current bot.
 */
let botIdentity: { userId?: number; username?: string } | null = null;
let botIdentityPromise: Promise<{ userId?: number; username?: string }> | null = null;

async function ensureBotIdentity(): Promise<{ userId?: number; username?: string }> {
  if (botIdentity) return botIdentity;
  botIdentityPromise ??= (async () => {
    try {
      const me = await getBot()?.api.getMyInfo();
      botIdentity = { userId: (me as any)?.user_id, username: (me as any)?.username };
    } catch {
      botIdentity = {};
    }
    return botIdentity;
  })();
  return botIdentityPromise;
}

/**
 * Group access gate — runs BEFORE any attachment download or disk write (same
 * principle as the DM gate). Defaults preserve the pre-0.5 behavior: without
 * config, groups are open and no mention is required.
 *
 * - groupPolicy "disabled" → all group traffic is ignored;
 * - "allowlist" → the chat must appear in `groups` (or via the "*" wildcard)
 *   and, when groupAllowFrom is non-empty, the sender must be listed;
 * - per-group `enabled: false` switches a single group off;
 * - requireMention (per-group → "*" → top-level, default false): the bot
 *   answers only when @-mentioned by username or replied to. Button presses
 *   (message_callback) are interactions with the bot's own message and always
 *   count as a mention.
 */
async function checkGroupAccess(api: OpenClawPluginApi, facts: InboundFacts): Promise<boolean> {
  if (!facts.isGroup) return true;
  const rt = (api as any).runtime;
  const cfg = rt?.config?.current?.() ?? (api as any).config ?? {};
  const section = (cfg as any)?.channels?.[MAX_CHANNEL_ID] ?? {};
  const drop = (reason: string) => {
    api.logger.info(`[MAX] group message dropped: ${reason} (chat=${facts.chatId})`);
    return false;
  };

  const groupPolicy: string = section.groupPolicy ?? "open";
  if (groupPolicy === "disabled") return drop("groupPolicy=disabled");

  const groups: Record<string, any> = section.groups ?? {};
  const groupCfg = groups[facts.chatId] ?? groups["*"];
  if (groupPolicy === "allowlist") {
    if (!(facts.chatId in groups) && !("*" in groups)) {
      return drop("chat not in groups allowlist");
    }
    const groupAllowFrom: Array<string | number> = section.groupAllowFrom ?? [];
    if (groupAllowFrom.length > 0) {
      const allowed = groupAllowFrom.some(
        (entry) =>
          normalizeMaxTarget(String(entry)).replace(/^user:/i, "") === String(facts.senderId),
      );
      if (!allowed) return drop("sender not in groupAllowFrom");
    }
  }

  if (groupCfg?.enabled === false) return drop("group disabled via groups config");

  const requireMention: boolean =
    typeof groupCfg?.requireMention === "boolean"
      ? groupCfg.requireMention
      : typeof section.requireMention === "boolean"
        ? section.requireMention
        : false;
  if (!requireMention) return true;

  // Button presses on the bot's own keyboard are implicit mentions.
  if (facts.callbackId) return true;

  // Reply to one of the bot's messages counts as a mention (Telegram-style).
  if (facts.replyToSenderIsBot) return true;

  const identity = await ensureBotIdentity();
  if (
    facts.replyToSenderId &&
    identity.userId != null &&
    facts.replyToSenderId === String(identity.userId)
  ) {
    return true;
  }

  if (identity.username) {
    const mentionRe = new RegExp(`@${escapeRegExp(identity.username)}\\b`, "i");
    if (mentionRe.test(facts.text)) return true;
  }

  return drop("bot not mentioned (requireMention)");
}

/** Shared update handler for webhook and polling transports. */
export async function handleUpdate(api: OpenClawPluginApi, update: any, token: string): Promise<void> {  const facts = extractInboundFacts(update);
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

  // Access gate BEFORE any download, session record or last-route write: a
  // blocked sender causes zero fetches and zero disk writes.
  if (!(await checkDmAccess(api, facts))) return;
  if (!(await checkGroupAccess(api, facts))) return;

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

    const groupWarning = resolveGroupPolicyWarning(section);
    if (groupWarning) api.logger.warn(`[MAX] ${groupWarning}`);

    // The channel gateway lifecycle (gateway.startAccount) owns bot startup;
    // here we expose the inbound handler and the webhook HTTP route.
    setMaxUpdateHandler((update, handlerToken) => handleUpdate(api, update, handlerToken));

    // Agent tool: send a file into the current MAX chat. Registered as a
    // factory so the per-run tool context (delivery route, agent, workspace)
    // is captured fresh for each session.
    api.registerTool((toolCtx: any) => createMaxSendFileTool(toolCtx));

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
