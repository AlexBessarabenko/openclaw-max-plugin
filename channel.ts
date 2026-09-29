import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink, waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { buildProbeChannelStatusSummary } from "openclaw/plugin-sdk/channel-status";
import { createComputedAccountStatusAdapter, createDefaultChannelRuntimeState } from "openclaw/plugin-sdk/status-helpers";
import { Bot } from "@maxhub/max-bot-api";
import { createMaxScopedFetch } from "./certs.js";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { downloadRemoteMedia, readLocalMedia } from "./src/media-access.js";
import { isPrivateOrLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { primeSeenMessageIds, recentSeenMessageIds } from "./src/dedup.js";
import { acquireChatSendSlot } from "./src/send-limiter.js";
import { alignMarkdownTables } from "./src/markdown-tables.js";
import { loadMaxPollingState, saveMaxPollingState } from "./src/polling-state.js";
import { maxMessageActions } from "./src/actions.js";
import {
  MAX_KEYBOARD_LIMITS,
  MAX_PRESENTATION_ROW_SIZE,
  parseInlineKeyboardInput,
  resolvePayloadKeyboardButtons,
  toInlineKeyboardAttachment,
} from "./src/keyboards.js";
import {
  MAX_PRESENTATION_BUTTONS_PER_ROW,
  MAX_PRESENTATION_SELECT_PER_ROW,
  renderMaxPresentationParts,
} from "./src/presentation.js";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

export const MAX_CHANNEL_ID = "max";
export const DEFAULT_ACCOUNT_ID = "default";
/** MAX Bot API v2 base URL (platform-api.max.ru is deprecated since 2026-07-19). */
export const DEFAULT_API_BASE_URL = "https://platform-api2.max.ru";

export type ResolvedAccount = {
  accountId: string | null;
  token: string;
  enabled: boolean;
  configured: boolean;
  allowFrom: string[];
  dmPolicy: string | undefined;
  webhookUrl: string | undefined;
  webhookSecret: string | undefined;
  apiBaseUrl: string;
  httpProxy: string | undefined;
  /** channels.max.commands — bot command menu (PATCH /me/commands at startup). */
  commands?: unknown;
};

function resolveAccountId(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): string {
  return params.accountId ?? DEFAULT_ACCOUNT_ID;
}

export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAccount {
  const section = (cfg.channels as Record<string, any>)?.[MAX_CHANNEL_ID];
  const token = section?.token ?? "";
  return {
    accountId: accountId ?? null,
    token,
    enabled: section?.enabled !== false,
    configured: Boolean(token),
    allowFrom: section?.allowFrom ?? [],
    dmPolicy: section?.dmPolicy,
    webhookUrl: section?.webhookUrl,
    webhookSecret: section?.webhookSecret,
    apiBaseUrl: section?.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    httpProxy: section?.httpProxy,
    commands: section?.commands,
  };
}

/** Strip routing prefixes ("max:", "max:group:") from a delivery target. */
export function stripMaxTarget(target: string): string {
  return target.replace(/^max:(group:)?/, "");
}

/** MAX chat ids: positive = dialog/chat id (not the user id), negative = group/channel. */
const MAX_TARGET_ID_RE = /^-?\d{5,}$/;
/** Explicit user-id targets keep the kind prefix: "user:<id>" → sendMessageToUser. */
const MAX_USER_TARGET_RE = /^user:\d{5,}$/i;

/**
 * Normalize a delivery target: "max:123", "max:group:-45", "chat:123" → bare chat id;
 * "user:123" / "max:user:123" → "user:123" (kind prefix preserved — a user id is
 * NOT a chat id: sending it via chat_id fails with 404).
 */
export function normalizeMaxTarget(raw: string): string {
  const t = String(raw ?? "")
    .trim()
    .replace(/^max:/i, "")
    .trim();
  if (/^user:/i.test(t)) return "user:" + t.slice(5).trim();
  return t.replace(/^(chat|group):/i, "").trim();
}

/**
 * Where to send: bare ids are chat ids (`sendMessageToChat` — works uniformly for
 * dialogs, groups and channels), `user:`-prefixed ids go through
 * `sendMessageToUser` (DM by user id).
 */
function resolveSendTarget(to: string): { userId: number } | { chatId: number } {
  const t = normalizeMaxTarget(to);
  if (MAX_USER_TARGET_RE.test(t)) return { userId: Number(t.slice(5)) };
  return { chatId: Number(t) };
}

/** Limiter key for a resolved target: one window per chat / per DM user. */
function sendLimiterKey(target: { userId: number } | { chatId: number }): string {
  return "userId" in target ? `user:${target.userId}` : `chat:${target.chatId}`;
}

/**
 * MAX processes fresh uploads asynchronously; sending right after an upload
 * can fail with `attachment.not.ready`. Retry the SEND (never the upload)
 * with a growing pause, only for that error, only when attachments ride along
 * (6 attempts total: 1.5s → 4s between them).
 */
const ATTACHMENT_NOT_READY_RE = /attachment\.not\.ready/;
const ATTACHMENT_RETRY_DELAYS_MS = [1500, 2000, 2500, 3000, 4000];

export async function sendMaxMessage(
  bot: Bot,
  to: string,
  text: string,
  extra?: Record<string, unknown>,
): Promise<any> {
  const target = resolveSendTarget(to);
  // MAX markdown has no table syntax — align pipe tables into monospace blocks.
  if ((extra as any)?.format === "markdown") text = alignMarkdownTables(text);
  const hasAttachments =
    Array.isArray((extra as any)?.attachments) && (extra as any).attachments.length > 0;
  const maxAttempts = hasAttachments ? 1 + ATTACHMENT_RETRY_DELAYS_MS.length : 1;
  await acquireChatSendSlot(sendLimiterKey(target));
  for (let attempt = 1; ; attempt++) {
    try {
      return "userId" in target
        ? await bot.api.sendMessageToUser(target.userId, text, extra as any)
        : await bot.api.sendMessageToChat(target.chatId, text, extra as any);
    } catch (err: any) {
      const reason = String(err?.code ?? err?.message ?? err);
      if (!hasAttachments || attempt >= maxAttempts || !ATTACHMENT_NOT_READY_RE.test(reason)) {
        throw err;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, ATTACHMENT_RETRY_DELAYS_MS[attempt - 1]),
      );
    }
  }
}

/**
 * Raw-structure send for attachment-only messages (stickers, contacts,
 * locations). Unlike `sendMaxMessage`, the text field is omitted entirely
 * when empty — MAX rejects sticker-only sends that carry an empty `text`.
 * These attachment kinds reference existing server-side objects (no fresh
 * upload), so the attachment.not.ready retry of `sendMaxMessage` is not
 * needed here.
 */
export async function sendMaxBody(
  bot: Bot,
  to: string,
  body: {
    text?: string;
    attachments?: Array<Record<string, unknown>>;
    link?: { type: "reply"; mid: string };
    format?: "markdown" | "html";
    notify?: boolean;
  },
): Promise<string> {
  const target = resolveSendTarget(to);
  const bodyText =
    body.format === "markdown" && body.text ? alignMarkdownTables(body.text) : body.text;
  const payload: Record<string, unknown> = {
    ...(bodyText ? { text: bodyText } : {}),
    ...(body.attachments ? { attachments: body.attachments } : {}),
    ...(body.link ? { link: body.link } : {}),
    ...(body.format ? { format: body.format } : {}),
    ...(body.notify !== undefined ? { notify: body.notify } : {}),
  };
  await acquireChatSendSlot(sendLimiterKey(target));
  const res =
    "userId" in target
      ? await (bot.api as any).raw.messages.send({ user_id: target.userId, ...payload })
      : await (bot.api as any).raw.messages.send({ chat_id: target.chatId, ...payload });
  return extractSentMessageId(res);
}

/**
 * Target adapter for the `message` tool and `openclaw message send --channel max`.
 *
 * Without it the core's async target resolver has no channel-specific
 * `looksLikeId`, so `max:<chat_id>` is rejected as "Unknown target". This matters
 * for harnesses that deliver *every* visible reply through the message tool
 * (e.g. `deliveryDefaults.sourceVisibleReplies = "message_tool"`): inbound
 * messages are processed, but the agent ends with "visible channel turn
 * dispatched with no queued reply payloads" and the user never gets an answer.
 *
 * Note: for direct chats the bare delivery target is the **dialog chat id**
 * (positive, differs from the user id). To address a user by their MAX user id
 * directly, use the explicit `user:<id>` form (sent via sendMessageToUser).
 */
export const maxMessaging: ChannelMessagingAdapter = {
  targetPrefixes: ["max"],
  normalizeTarget: (raw) => normalizeMaxTarget(raw) || undefined,
  inferTargetChatType: ({ to }) => {
    const id = normalizeMaxTarget(to);
    if (MAX_USER_TARGET_RE.test(id)) return "direct";
    if (!MAX_TARGET_ID_RE.test(id)) return undefined;
    return id.startsWith("-") ? "group" : "direct";
  },
  targetResolver: {
    looksLikeId: (raw, normalized) => {
      const t = normalizeMaxTarget(normalized ?? raw);
      return MAX_TARGET_ID_RE.test(t) || MAX_USER_TARGET_RE.test(t);
    },
    hint: "<chat_id> or user:<user_id> (MAX ids: positive = dialog, negative = group/channel)",
    resolveTarget: async ({ normalized, input }) => {
      const to = normalizeMaxTarget(normalized ?? input);
      if (MAX_USER_TARGET_RE.test(to)) {
        return { to, kind: "user", display: to, source: "normalized" };
      }
      if (!MAX_TARGET_ID_RE.test(to)) return null;
      return {
        to,
        kind: to.startsWith("-") ? "group" : "user",
        display: to,
        source: "normalized",
      };
    },
  },
};

type MaxUploadType = "image" | "video" | "audio" | "file";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "webm", "mkv"]);
const AUDIO_EXTS = new Set(["mp3", "ogg", "wav", "m4a", "opus"]);

export function resolveMaxUploadType(filename?: string, contentType?: string): MaxUploadType {
  const ext = filename?.split(".").pop()?.toLowerCase() ?? "";
  if (contentType?.startsWith("image/") || IMAGE_EXTS.has(ext)) return "image";
  if (contentType?.startsWith("video/") || VIDEO_EXTS.has(ext)) return "video";
  if (contentType?.startsWith("audio/") || AUDIO_EXTS.has(ext)) return "audio";
  return "file";
}

/**
 * Upload media through the raw uploads endpoint instead of the SDK helpers:
 * max-bot-api 0.2.5 drops the upload token on the Buffer path and never reads
 * it back from the multipart response. The token arrives either in the
 * getUploadUrl response (range-upload flow: video/audio/file) or in the upload
 * response JSON ("photos" map for image uploads, "token" otherwise).
 */
export async function rawUploadMaxMedia(
  bot: Bot,
  type: MaxUploadType,
  data: Buffer,
  filename: string,
): Promise<{ type: MaxUploadType; payload: Record<string, unknown> }> {
  const { url, token } = await (bot.api as any).raw.uploads.getUploadUrl({ type });
  const form = new FormData();
  form.append("data", new Blob([data]), filename);
  const res = await maxFetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`media upload failed: HTTP ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (type === "image" && json.photos && typeof json.photos === "object") {
    return { type, payload: { photos: json.photos } };
  }
  const uploadToken = token ?? json.token;
  if (uploadToken) return { type, payload: { token: uploadToken } };
  throw new Error(`MAX API returned no upload token for type "${type}"`);
}

/** the api client returns the raw response ({ message: {...} }) */
function extractSentMessageId(sent: any): string {
  const mid = sent?.message?.body?.mid ?? sent?.body?.mid ?? sent?.id;
  return mid != null ? String(mid) : String(Date.now());
}

/**
 * Resolve one media source (remote URL or local path) into a wire attachment.
 * Remote image URLs ride by URL (attachment payload.url) — MAX fetches the
 * link server-side, no upload round trip; the host is screened the same way
 * the download path is (private/loopback hosts are refused). Everything else
 * (non-image URLs, local files) goes through the SSRF-guarded
 * download + upload flow.
 */
async function resolveMaxMediaAttachment(
  bot: Bot,
  mediaUrl: string,
  params: {
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    mediaLocalRoots?: readonly string[];
  },
): Promise<Record<string, unknown>> {
  if (/^https?:\/\//i.test(mediaUrl)) {
    const filename =
      decodeURIComponent(new URL(mediaUrl).pathname.split("/").pop() ?? "") || "file";
    if (resolveMaxUploadType(filename) === "image") {
      const host = new URL(mediaUrl).hostname;
      if (isPrivateOrLoopbackHost(host)) {
        throw new Error(`refusing to send image by URL: private or loopback host "${host}"`);
      }
      return { type: "image", payload: { url: mediaUrl } };
    }
    // SSRF-guarded download; scoped MAX fetch (CA/proxy) stays in effect
    const fetched = await downloadRemoteMedia({ url: mediaUrl, fetchImpl: getMaxFetch() });
    return rawUploadMaxMedia(
      bot,
      resolveMaxUploadType(filename, fetched.contentType || undefined),
      fetched.buffer,
      filename,
    );
  }
  // Local paths only via the host reader or inside the allowed media
  // roots — otherwise an agent-named path could exfiltrate any file.
  const data = await readLocalMedia(mediaUrl, {
    mediaReadFile: params.mediaReadFile,
    mediaLocalRoots: params.mediaLocalRoots,
  });
  const filename = mediaUrl.split("/").pop() || "file";
  return rawUploadMaxMedia(bot, resolveMaxUploadType(filename), data, filename);
}

/**
 * Send one media message. Remote image URLs ride by URL (attachment
 * payload.url) — MAX fetches the link server-side, no upload round trip;
 * the host is screened the same way the download path is (private/loopback
 * hosts are refused). Everything else (non-image URLs, local files) goes
 * through the SSRF-guarded download + upload flow.
 */
export async function sendMaxMedia(
  bot: Bot,
  params: {
    to: string;
    text?: string;
    mediaUrl: string;
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    mediaLocalRoots?: readonly string[];
    extra?: Record<string, unknown>;
  },
): Promise<string> {
  const attachment = await resolveMaxMediaAttachment(bot, params.mediaUrl, params);
  const sent = await sendMaxMessage(bot, params.to, params.text ?? "", {
    ...(params.extra ?? {}),
    attachments: [attachment as any],
  });
  return extractSentMessageId(sent);
}

/** MAX renders albums of up to 12 photo/video attachments in one message. */
export const MAX_ALBUM_SIZE = 12;

/**
 * Group outbound media into as few messages as MAX allows: images and videos
 * form albums of up to 12, audio/files always go one per message. Grouping is
 * decided by the upload type resolved from the filename/extension.
 */
export function groupMaxMediaUrls(mediaUrls: string[]): string[][] {
  const groups: string[][] = [];
  let album: string[] = [];
  const flush = () => {
    if (album.length > 0) groups.push(album);
    album = [];
  };
  for (const mediaUrl of mediaUrls) {
    const filename = mediaUrl.split("?")[0].split("#")[0].split("/").pop();
    const type = resolveMaxUploadType(filename);
    if (type === "image" || type === "video") {
      if (album.length >= MAX_ALBUM_SIZE) flush();
      album.push(mediaUrl);
    } else {
      flush();
      groups.push([mediaUrl]);
    }
  }
  flush();
  return groups;
}

/**
 * Send several media as few messages as MAX allows (albums of up to 12
 * images/videos; audio/files one per message). The caption rides on the first
 * message only. Returns the message id of each sent message.
 */
export async function sendMaxMediaGroup(
  bot: Bot,
  params: {
    to: string;
    text?: string;
    mediaUrls: string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    mediaLocalRoots?: readonly string[];
    extra?: Record<string, unknown>;
  },
): Promise<string[]> {
  const groups = groupMaxMediaUrls(params.mediaUrls);
  const messageIds: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const attachments: Record<string, unknown>[] = [];
    for (const mediaUrl of groups[i]) {
      attachments.push(await resolveMaxMediaAttachment(bot, mediaUrl, params));
    }
    const sent = await sendMaxMessage(bot, params.to, i === 0 ? (params.text ?? "") : "", {
      ...(params.extra ?? {}),
      attachments: attachments as any,
    });
    messageIds.push(extractSentMessageId(sent));
  }
  return messageIds;
}

// Store bot instance for outbound messaging
let botInstance: Bot | null = null;

/**
 * Startup warning for the permissive group posture: with groupPolicy=open and
 * no groupAllowFrom the bot answers everyone in every group it is added to.
 */
export function resolveGroupPolicyWarning(section: any): string | null {
  const groupPolicy = section?.groupPolicy ?? "open";
  const groupAllowFrom = Array.isArray(section?.groupAllowFrom) ? section.groupAllowFrom : [];
  if (groupPolicy === "open" && groupAllowFrom.length === 0) {
    return (
      "channels.max.groupPolicy is \"open\" and groupAllowFrom is empty: " +
      "the bot will answer every member of every group it joins. " +
      "Set groupPolicy/allowlist or groupAllowFrom to restrict this."
    );
  }
  return null;
}


/** Scoped fetch of the currently initialized account (proxy-aware). */
let maxFetch = createMaxScopedFetch();

/** Scoped fetch for direct calls outside bot init (probes, attachment downloads). */
export function getMaxFetch() {
  return maxFetch;
}

/**
 * Pairing approval notice, sent after `openclaw pairing approve` (with
 * --notify). The pairing id is a MAX user id — the reply goes through
 * sendMessageToUser (the bare user id is not a chat id).
 */
export async function sendMaxPairingApproval(bot: Bot, id: string): Promise<void> {
  const userId = Number(String(id).trim().replace(/^user:/i, ""));
  if (!Number.isFinite(userId)) {
    throw new Error(`pairing id "${id}" is not a MAX user id`);
  }
  await acquireChatSendSlot(`user:${userId}`);
  await bot.api.sendMessageToUser(
    userId,
    "✅ Доступ одобрен. Можете продолжать диалог с ботом.",
    { format: "markdown" },
  );
}

/** Masked token preview for diagnostics: first/last 4 chars, never the secret. */
export function maskMaxToken(token: string): string | null {
  if (!token) return null;
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * Per-message send options: `channelData.maxNotify` / `maxDisableLinkPreview`
 * override the channel config defaults (`channels.max.notify` /
 * `disableLinkPreview`). Unset fields are omitted — the MAX server default
 * (notify on, link preview on) applies.
 */
export function resolveMaxSendOptions(
  cfg: OpenClawConfig,
  channelData?: unknown,
): { notify?: boolean; disable_link_preview?: boolean } {
  const section = (cfg.channels as Record<string, any>)?.[MAX_CHANNEL_ID] ?? {};
  const cd =
    channelData && typeof channelData === "object" && !Array.isArray(channelData)
      ? (channelData as Record<string, unknown>)
      : {};
  const notify =
    typeof cd.maxNotify === "boolean"
      ? cd.maxNotify
      : typeof section.notify === "boolean"
        ? section.notify
        : undefined;
  const disableLinkPreview =
    typeof cd.maxDisableLinkPreview === "boolean"
      ? cd.maxDisableLinkPreview
      : typeof section.disableLinkPreview === "boolean"
        ? section.disableLinkPreview
        : undefined;
  return {
    ...(notify !== undefined ? { notify } : {}),
    ...(disableLinkPreview !== undefined ? { disable_link_preview: disableLinkPreview } : {}),
  };
}

/** Outbound text chunk limit (mirrors the reply-path MAX_TEXT_LIMIT). */
const MAX_OUTBOUND_TEXT_LIMIT = 4000;

/** Shown when a payload carries only buttons and no text at all. */
const MAX_CONTROL_ONLY_FALLBACK = "Choose an option.";

/**
 * Convert a portable `presentation` payload into the one MAX payload shape
 * used by every outbound funnel: the full block set renders to MAX markdown
 * (title/tone line, context, dividers, monospace tables/charts), buttons and
 * select options become `channelData.maxInlineKeyboard` rows carrying private
 * callback envelopes (see src/presentation.ts). Called by the core via
 * `outbound.renderPresentation` after the presentation was adapted to
 * `presentationCapabilities`.
 */
export function canonicalizeMaxPresentationPayload(payload: ReplyPayload): ReplyPayload {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (!presentation) return payload;
  const currentText = payload.text?.trim() ?? "";
  // presentationTextMode "fallback" marks payload.text as core's own plain
  // fallback of the presentation — replace it with our richer render. The
  // endsWith guard catches the same duplication when the mode flag is absent.
  const plainBlocks = presentation.blocks.filter(
    (block) => block.type !== "buttons" && block.type !== "select",
  );
  const plainFallback = renderMessagePresentationFallbackText({
    presentation: { ...presentation, blocks: plainBlocks },
  });
  const textIsFallback = payload.presentationTextMode === "fallback";
  const alreadyHasFallback =
    !textIsFallback &&
    plainFallback.length > 0 &&
    (currentText === plainFallback || currentText.endsWith(`\n\n${plainFallback}`));
  const baseText =
    textIsFallback || !currentText
      ? ""
      : alreadyHasFallback
        ? currentText
            .slice(0, currentText.length - plainFallback.length)
            .replace(/\n\n$/u, "")
            .trimEnd()
        : currentText;
  const rendered = renderMaxPresentationParts({ presentation, text: baseText });
  let keyboard: ReturnType<typeof parseInlineKeyboardInput> | null = null;
  try {
    keyboard = rendered.buttons.length > 0 ? parseInlineKeyboardInput(rendered.buttons) : null;
  } catch {
    keyboard = null; // over-limit keyboards degrade to text-only delivery
  }
  const { presentation: _presentation, presentationTextMode: _mode, ...rest } = payload;
  return {
    ...rest,
    text: rendered.text || (keyboard ? MAX_CONTROL_ONLY_FALLBACK : ""),
    ...(keyboard
      ? { channelData: { ...(payload.channelData ?? {}), maxInlineKeyboard: keyboard } }
      : {}),
  };
}

/**
 * Whole-payload outbound send (core `sendPayload`): taken whenever a payload
 * carries channelData / presentation / interactive — exactly the cases the
 * plain sendText path would silently drop. The keyboard attaches to the last
 * text chunk; media follows without captions.
 */
async function sendMaxPayload(ctx: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  payload: ReplyPayload;
  silent?: boolean;
  replyToId?: string | null;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<{ channel: string; messageId: string; meta?: { messageIds: string[] } }> {
  const payload = ctx.payload ?? {};
  const bot = ensureBotForOutbound(ctx.cfg);
  const opts = resolveMaxSendOptions(ctx.cfg, payload.channelData);
  if (ctx.silent === true) opts.notify = false;
  let keyboardButtons: ReturnType<typeof resolvePayloadKeyboardButtons> = null;
  try {
    keyboardButtons = resolvePayloadKeyboardButtons(payload);
  } catch {
    keyboardButtons = null; // invalid keyboard must not lose the message
  }
  const keyboardAttachment = keyboardButtons
    ? toInlineKeyboardAttachment(keyboardButtons)
    : undefined;
  let text = (typeof payload.text === "string" && payload.text.trim()) || ctx.text.trim();
  if (!text && keyboardAttachment) text = MAX_CONTROL_ONLY_FALLBACK;
  const replyLink = ctx.replyToId ? { link: { type: "reply", mid: String(ctx.replyToId) } } : {};
  let lastMessageId = "";
  const sentMessageIds: string[] = [];
  if (text) {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_OUTBOUND_TEXT_LIMIT) {
      chunks.push(text.slice(i, i + MAX_OUTBOUND_TEXT_LIMIT));
    }
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const extra = {
        format: "markdown",
        ...opts,
        ...(i === 0 ? replyLink : {}),
        ...(isLast && keyboardAttachment ? { attachments: [keyboardAttachment] } : {}),
      };
      let sent;
      try {
        sent = await sendMaxMessage(bot, ctx.to, chunks[i], extra);
      } catch {
        // invalid markdown must not lose the message
        const { format: _format, ...plainExtra } = extra;
        sent = await sendMaxMessage(bot, ctx.to, chunks[i], plainExtra);
      }
      lastMessageId = extractSentMessageId(sent);
      sentMessageIds.push(lastMessageId);
    }
  }
  const mediaUrls = [
    ...new Set(
      [payload.mediaUrl, ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [])]
        .filter((u): u is string => typeof u === "string" && Boolean(u.trim()))
        .map((u) => u.trim()),
    ),
  ];
  // Albums: images/videos group up to 12 per message, audio/files go singly.
  const mediaIds = await sendMaxMediaGroup(bot, {
    to: ctx.to,
    text: "",
    mediaUrls,
    mediaReadFile: ctx.mediaReadFile,
    mediaLocalRoots: ctx.mediaLocalRoots ?? getAgentScopedMediaLocalRoots(ctx.cfg),
    extra: { ...opts, ...(lastMessageId ? {} : replyLink) },
  });
  if (mediaIds.length > 0) {
    lastMessageId = mediaIds[mediaIds.length - 1];
    sentMessageIds.push(...mediaIds);
  }
  if (!lastMessageId) throw new Error("MAX sendPayload: nothing to send (empty text and no media)");
  return {
    channel: MAX_CHANNEL_ID,
    messageId: lastMessageId,
    meta: { messageIds: sentMessageIds },
  };
}

// Inbound updates are processed by the handler registered from the plugin
// entry (index.ts), where the full plugin api is available.
type InboundUpdateHandler = (update: any, token: string) => Promise<void>;
let updateHandler: InboundUpdateHandler | null = null;

export function setMaxUpdateHandler(handler: InboundUpdateHandler): void {
  updateHandler = handler;
}

/**
 * Run `run` detached from any inherited gateway root-work admission context.
 *
 * The gateway may invoke channel startup inside a short-lived "root work"
 * admission (e.g. the restart-startup handshake). Long-lived work started from
 * there — the polling loop, post-ACK webhook processing — keeps that
 * AsyncLocalStorage context, and once the admission is released every
 * downstream dispatch is rejected with GatewayDrainingError. The admission
 * state lives in a process-wide singleton; exiting the ALS store makes the
 * work independent of the caller's admission lifetime.
 */
export function runOutsideInheritedRootWork<T>(run: () => T): T {
  const state = (globalThis as any)[Symbol.for("openclaw.gatewayWorkAdmissionState")];
  const store = state?.currentRootWork;
  if (store && typeof store.exit === "function" && store.getStore?.()) {
    return store.exit(run);
  }
  return run();
}

type MaxProbe = {
  ok: boolean;
  error?: string;
  bot?: { username?: string; name?: string };
};

async function probeMaxAccount(account: ResolvedAccount, timeoutMs: number): Promise<MaxProbe> {
  if (!account.token) return { ok: false, error: "token is not configured" };
  try {
    const resp = await createMaxScopedFetch(undefined, account.httpProxy)(`${account.apiBaseUrl}/me`, {
      headers: { Authorization: account.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const bot = (await resp.json()) as MaxProbe["bot"];
    return { ok: true, bot };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const maxPlugin = createChatChannelPlugin<ResolvedAccount, MaxProbe>({
  base: {
    id: MAX_CHANNEL_ID,
    messaging: maxMessaging,
    meta: {
      id: MAX_CHANNEL_ID,
      label: "MAX Messenger",
      selectionLabel: "MAX Messenger (plugin)",
      blurb: "Connect OpenClaw to MAX messenger.",
      docsPath: "/plugins/max",
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      reactions: false,
      threads: false,
      media: true,
      nativeCommands: false,
    },
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### MAX Messenger formatting",
        "Markdown: **bold**, *italic*, ~~strikethrough~~, `inline code`, [links](url).",
        "Hard limit 4000 chars per message; the plugin chunks longer text.",
        "Delivery target: dialog chat id (positive) or `user:<user_id>` for DMs;",
        "group/channel ids are negative.",
        "Attach media via the message tool `media` param (local path or URL); several",
        "images/videos ride as one album (≤12 per message), audio/files one per message.",
        "Groups: the bot may answer only when @-mentioned or replied to (requireMention config).",
        "Inline keyboards on the message tool: prefer the `presentation` param —",
        'presentation={"blocks": [{"type": "buttons", "buttons": [{"label": "Да", "value": "yes"},',
        '{"label": "Link", "url": "https://…"}]}]}. Callback buttons carry `value` (or',
        'action={"type": "callback"|"command", ...}); `url` (or action type "url") makes a link',
        "button. The keyboard rides on the same message as the tool send. `select` blocks",
        "render as buttons; tables/charts render as monospace text. Presses of",
        "presentation callback buttons come back labelled `callback_data: <value>` (plus",
        "a quote of the message the button was on).",
        "channelData.maxInlineKeyboard also works — on the message tool AND in a plain",
        "reply: rows of `{text, url?, payload?}` buttons (payloads arrive verbatim) or",
        "plain strings. Wire types: callback, link, clipboard, message, request_contact,",
        "request_geo_location, open_app. Limits: ≤210 buttons, ≤30 rows, ≤7 per row (≤3",
        "if a row has link/open_app/request_*), link URL ≤2048 chars. The keyboard",
        "attaches to the final reply message only.",
        "",
        "### MAX message actions",
        'Sticker: message(action="sticker", target="<chat_id>", stickerId="<code>") — codes come',
        "from received stickers ([Sticker (code …)] markers); omit stickerId to echo the",
        "last sticker seen in that chat.",
        'Location pin: message(action="sendAttachment", type="location", target="<chat_id>", latitude="55.75", longitude="37.62").',
        'Contact card: message(action="sendAttachment", type="contact", target="<chat_id>", contactName="Name", vcfPhone="+79001234567") — or contactId=<MAX user_id>.',
        'Edit your own message: message(action="edit", messageId="<mid>", message="new text") —',
        "up to 7 days in dialogs; no time limit with an inline keyboard or in",
        "groups/channels (≤2 edits/sec per chat).",
        'Delete your own message: message(action="delete", messageId="<mid>") — no time limit.',
        'Pin/unpin: message(action="pin", target="<chat_id>", messageId="<mid>", notify=false) /',
        'message(action="unpin", target="<chat_id>").',
        "Per-message options on replies: channelData.maxNotify=false (silent),",
        "channelData.maxDisableLinkPreview=true; channel defaults: channels.max.notify /",
        "disableLinkPreview. Image URLs are attached by link (no re-upload).",
      ],
      inboundFormattingHints: () => ({
        text_markup: "markdown",
        rules: [
          "Keep answers under 4000 characters",
          "Avoid wide tables (narrow mobile rendering)",
        ],
      }),
    },
    setup: {
      resolveAccountId,
      applyAccountConfig(params) {
        return params.cfg;
      },
    },
    // Message-tool actions owned by the channel (edit/delete/pin/unpin/
    // sticker/sendAttachment); plain send stays on the core outbound path.
    actions: maxMessageActions,
    config: {
      resolveAccount,
      listAccountIds(cfg) {
        return [DEFAULT_ACCOUNT_ID];
      },
      // Diagnostics for `openclaw status` — never leaks the token itself.
      inspectAccount: (cfg, accountId) => {
        const section = (cfg.channels as Record<string, any>)?.[MAX_CHANNEL_ID] ?? {};
        const account = resolveAccount(cfg, accountId);
        return {
          accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
          enabled: account.enabled,
          configured: account.configured,
          tokenSource: account.token ? ("config" as const) : ("none" as const),
          tokenPreview: maskMaxToken(account.token),
          dmPolicy: account.dmPolicy ?? "allowlist",
          groupPolicy: section.groupPolicy ?? "open",
          webhook: account.webhookUrl ? "webhook" : "polling",
          streaming: section.streaming !== false,
          httpProxy: Boolean(account.httpProxy),
        };
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedAccount, MaxProbe>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: ({ snapshot }) =>
        buildProbeChannelStatusSummary(snapshot, { apiBaseUrl: (snapshot as any).apiBaseUrl ?? null }),
      probeAccount: async ({ account, timeoutMs }) => probeMaxAccount(account, timeoutMs),
      resolveAccountSnapshot: ({ account, runtime, probe }) => ({
        accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          apiBaseUrl: account.apiBaseUrl,
          connected: probe?.ok ?? runtime?.running ?? false,
          botUsername: probe?.ok ? probe.bot?.username ?? null : null,
        },
      }),
    }),
    gateway: {
      startAccount: async (ctx) =>
        runOutsideInheritedRootWork(() => runMaxAccount(ctx)),
    },
  },

  // DM security: who can message the bot
  security: {
    dm: {
      channelKey: MAX_CHANNEL_ID,
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  // Pairing: approval flow for new DM contacts. The challenge code itself is
  // sent by the inbound gate (index.ts issueChallenge → sendPairingReply);
  // notifyApproval fires after `openclaw pairing approve --notify`.
  pairing: {
    idLabel: "MAX user ID",
    notifyApproval: async (params) => {
      if (!botInstance) return;
      await sendMaxPairingApproval(botInstance, params.id);
    },
  },

  // Threading: how replies are delivered
  threading: { topLevelReplyToMode: "reply" },

  // Outbound: send messages to the platform
  outbound: {
    base: {
      deliveryMode: "direct",
      // Portable presentation (message tool `presentation` param): MAX renders
      // button/select blocks natively as inline keyboards; tables and charts
      // render as monospace text blocks (MAX has no native data blocks).
      presentationCapabilities: {
        supported: true,
        buttons: true,
        selects: true,
        context: true,
        divider: true,
        charts: true,
        tables: true,
        limits: {
          actions: {
            maxActions: MAX_KEYBOARD_LIMITS.maxButtons,
            maxActionsPerRow: MAX_PRESENTATION_ROW_SIZE,
            maxRows: MAX_KEYBOARD_LIMITS.maxRows,
            maxLabelLength: 128,
            // Leave room for the private envelope prefix inside the 1024-byte
            // callback payload limit.
            maxValueBytes: 960,
            supportsStyles: false,
            supportsDisabled: false,
            supportsLayoutHints: false,
          },
          selects: {
            maxOptions: 20,
            maxLabelLength: 128,
            maxValueBytes: 960,
          },
          text: {
            maxLength: 4000,
            encoding: "characters",
            markdownDialect: "markdown",
          },
        },
      },
      renderPresentation: ({ payload }) => canonicalizeMaxPresentationPayload(payload),
      // Payloads carrying channelData / presentation / interactive are routed
      // here by the core — sendText alone would silently drop the keyboard.
      sendPayload: sendMaxPayload,
      deliveryCapabilities: {
        durableFinal: {
          text: true,
          media: true,
          payload: true,
          silent: true,
          replyTo: true,
          messageSendingHooks: true,
        },
      },
    },
    attachedResults: {
      channel: MAX_CHANNEL_ID,
      sendText: async (params) => {
        const bot = ensureBotForOutbound(params.cfg);
        const opts = resolveMaxSendOptions(params.cfg);
        // The core's `silent` flag maps to MAX notify=false.
        if (params.silent === true) opts.notify = false;
        const sent = await sendMaxMessage(bot, params.to, params.text, { format: "markdown", ...opts });
        return { messageId: extractSentMessageId(sent) };
      },
      sendMedia: async (params) => {
        const bot = ensureBotForOutbound(params.cfg);
        const mediaUrl = params.mediaUrl;
        if (!mediaUrl) {
          throw new Error("mediaUrl is required");
        }
        const opts = resolveMaxSendOptions(params.cfg);
        if (params.silent === true) opts.notify = false;
        const messageId = await sendMaxMedia(bot, {
          to: params.to,
          text: params.text,
          mediaUrl,
          mediaReadFile: params.mediaReadFile,
          mediaLocalRoots: params.mediaLocalRoots ?? getAgentScopedMediaLocalRoots(params.cfg),
          extra: opts,
        });
        return { messageId };
      },
    },
  },
});

// Initialize bot function
export function initializeBot(token: string, apiBaseUrl?: string, httpProxy?: string): Bot {
  if (botInstance) {
    try {
      botInstance.stopPolling();
    } catch {
      // previous instance was not polling
    }
  }
  maxFetch = createMaxScopedFetch(undefined, httpProxy);
  botInstance = new Bot(token, {
    clientOptions: {
      baseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL,
      // Scoped TLS: Russian national CAs apply to MAX hosts only; the
      // process-wide trust store is never touched. Optional proxy tunnels
      // MAX traffic only.
      fetch: maxFetch as any,
    },
  });
  return botInstance;
}

// Get current bot instance
export function getBot(): Bot | null {
  return botInstance;
}

/**
 * Outbound sends also run outside the gateway lifecycle (e.g. the
 * `openclaw message send` CLI loads the plugin in-process), where
 * `initializeBot` was never called. Fall back to a send-only client built
 * from the configured token; `Bot` only starts polling on `.startPolling()`.
 */
export function ensureBotForOutbound(cfg: OpenClawConfig): Bot {
  if (botInstance) return botInstance;
  const account = resolveAccount(cfg, DEFAULT_ACCOUNT_ID);
  if (!account.token) throw new Error("MAX token is not configured");
  return initializeBot(account.token, account.apiBaseUrl, account.httpProxy);
}

/** Update types the polling loop asks for (webhook subscription mirrors this). */
const POLL_ALLOWED_UPDATES = ["message_created", "message_callback", "bot_started", "message_edited"];

/**
 * Subscribe the account's webhook URL (POST /subscriptions). Shared by
 * startup and the watchdog re-subscribe path.
 */
export async function subscribeMaxWebhook(account: ResolvedAccount): Promise<void> {
  const resp = await maxFetch(`${account.apiBaseUrl}/subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: account.token },
    body: JSON.stringify({
      url: account.webhookUrl,
      update_types: POLL_ALLOWED_UPDATES,
      ...(account.webhookSecret ? { secret: account.webhookSecret } : {}),
    }),
  });
  if (!resp.ok) {
    throw new Error(`POST /subscriptions failed: HTTP ${resp.status} ${await resp.text()}`);
  }
}

const WEBHOOK_WATCHDOG_INTERVAL_MS = 12 * 60 * 1000;

/**
 * Register the bot command menu (PATCH /me/commands, schema BotCommandsPatch:
 * ≤32 commands, name 1..64 chars, description ≤128). Invalid entries are
 * dropped with a warning; over-128 descriptions are truncated.
 */
export async function registerMaxBotCommands(params: {
  commands: unknown;
  apiBaseUrl: string;
  token: string;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<number> {
  if (!Array.isArray(params.commands)) return 0;
  const commands = params.commands
    .flatMap((entry: any) => {
      const name = typeof entry?.name === "string" ? entry.name.trim() : "";
      if (!name || name.length > 64) {
        params.log?.warn?.("[MAX] commands entry skipped: name must be 1-64 chars");
        return [];
      }
      const description =
        typeof entry?.description === "string" ? entry.description.trim() : "";
      return [
        {
          name,
          ...(description ? { description: description.slice(0, 128) } : {}),
        },
      ];
    })
    .slice(0, 32);
  if (commands.length < params.commands.length) {
    params.log?.warn?.(`[MAX] commands truncated to 32 entries (configured ${params.commands.length})`);
  }
  const resp = await maxFetch(`${params.apiBaseUrl}/me/commands`, {
    method: "PATCH",
    headers: { "content-type": "application/json", Authorization: params.token },
    body: JSON.stringify({ commands }),
  });
  if (!resp.ok) {
    throw new Error(`PATCH /me/commands failed: HTTP ${resp.status} ${await resp.text()}`);
  }
  return commands.length;
}

/**
 * MAX drops a webhook subscription after ~8h of failed deliveries. In webhook
 * mode, re-check every 12 minutes and re-create ours when it is gone; in
 * polling mode the watchdog is never started. Returns a stop function.
 */
export function startMaxWebhookWatchdog(params: {
  account: ResolvedAccount;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  intervalMs?: number;
}): () => void {
  const { account, log } = params;
  const timer = setInterval(() => {
    void (async () => {
      try {
        const resp = await maxFetch(`${account.apiBaseUrl}/subscriptions`, {
          headers: { Authorization: account.token },
        });
        if (!resp.ok) throw new Error(`GET /subscriptions failed: HTTP ${resp.status}`);
        const json = (await resp.json().catch(() => ({}))) as any;
        const subscriptions = Array.isArray(json?.subscriptions) ? json.subscriptions : [];
        if (subscriptions.some((s: any) => s?.url === account.webhookUrl)) return;
        log?.warn?.("[MAX] webhook subscription is missing, re-creating");
        await subscribeMaxWebhook(account);
        log?.info?.(`[MAX] Webhook re-subscribed: ${account.webhookUrl}`);
      } catch (err: any) {
        log?.warn?.(`[MAX] webhook watchdog check failed: ${err?.message ?? err}`);
      }
    })();
  }, params.intervalMs ?? WEBHOOK_WATCHDOG_INTERVAL_MS);
  (timer as any).unref?.();
  return () => clearInterval(timer);
}

/** Transient polling errors, mirroring the SDK's Polling.shouldRetry. */
function isTransientPollingError(err: any): boolean {
  if (!err || typeof err !== "object") return false;
  if (typeof err.status === "number") return err.status === 429 || err.status >= 500;
  return err.name === "TypeError";
}

/**
 * Long-polling loop with a persistent marker (at-least-once delivery).
 *
 * The SDK's own Polling advances its marker in memory before processing; a
 * gateway restart then loses or replays updates inside the server retention
 * window. Here the marker (plus the tail of the dedup list) is persisted only
 * AFTER the whole batch has been handed to the inbound handler. A crash
 * mid-batch replays at most one batch; the persisted dedup ids make the
 * replay a no-op. If any update in the batch failed, the in-memory marker
 * still advances (no poison-message loop) but nothing is persisted, so the
 * failed batch is retried after a restart.
 */
export async function runPollingLoop(params: {
  bot: Bot;
  accountId: string;
  token: string;
  handler: InboundUpdateHandler;
  signal?: AbortSignal;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<void> {
  const { bot, accountId, token, handler, signal, log } = params;

  let marker: number | undefined;
  try {
    const state = await loadMaxPollingState(accountId);
    if (typeof state.marker === "number") marker = state.marker;
    if (state.seenMessageIds?.length) primeSeenMessageIds(state.seenMessageIds);
    if (marker != null) log?.info?.(`[MAX] polling resumes from persisted marker ${marker}`);
  } catch (err: any) {
    log?.warn?.(`[MAX] polling state load failed, starting fresh: ${err?.message ?? err}`);
  }

  const BASE_DELAY_MS = 5000;
  const MAX_DELAY_MS = 60000;
  let delayMs = BASE_DELAY_MS;

  while (!signal?.aborted) {
    let batchFailed = false;
    try {
      const { updates, marker: next } = await (bot.api as any).getUpdates(POLL_ALLOWED_UPDATES, {
        marker,
        limit: 100,
        timeout: 30,
        signal,
      });
      delayMs = BASE_DELAY_MS;
      for (const update of updates ?? []) {
        try {
          await handler(update, token);
        } catch (err: any) {
          batchFailed = true;
          log?.error?.(`[MAX] polling update failed: ${err?.message ?? err}`);
        }
      }
      if (typeof next === "number") {
        marker = next;
        if (!batchFailed) {
          try {
            await saveMaxPollingState(accountId, {
              marker,
              seenMessageIds: recentSeenMessageIds(),
            });
          } catch (err: any) {
            log?.warn?.(`[MAX] polling state persist failed: ${err?.message ?? err}`);
          }
        }
      }
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") return;
      if (isTransientPollingError(err)) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
}

async function runMaxAccount(ctx: ChannelGatewayContext<ResolvedAccount>): Promise<void> {
  const account = ctx.account;
  const log = ctx.log;
  const statusSink = createAccountStatusSink({
    accountId: ctx.accountId,
    setStatus: ctx.setStatus,
  });

  if (!account.token) {
    log?.warn("[MAX] No token configured, account not started");
    statusSink({ running: false, lastError: "token is not configured" });
    return;
  }
  if (!updateHandler) {
    log?.error("[MAX] Inbound update handler not registered, account not started");
    statusSink({ running: false, lastError: "plugin entry not fully registered" });
    return;
  }
  const handler = updateHandler;

  const bot = initializeBot(account.token, account.apiBaseUrl, account.httpProxy);
  statusSink({ running: true, lastStartAt: Date.now(), lastError: null });

  // Bot command menu (channels.max.commands) — best-effort, never fatal.
  if (Array.isArray(account.commands)) {
    try {
      const count = await registerMaxBotCommands({
        commands: account.commands,
        apiBaseUrl: account.apiBaseUrl,
        token: account.token,
        log,
      });
      log?.info(`[MAX] bot commands registered (${count})`);
    } catch (err: any) {
      log?.warn(`[MAX] bot command registration failed: ${err?.message ?? err}`);
    }
  }

  let webhookActive = false;
  let stopWebhookWatchdog: (() => void) | null = null;
  if (account.webhookUrl) {
    try {
      await bot.api.getMyInfo();
      await subscribeMaxWebhook(account);
      webhookActive = true;
      stopWebhookWatchdog = startMaxWebhookWatchdog({ account, log });
      log?.info(`[MAX] Webhook subscribed: ${account.webhookUrl}`);
    } catch (err: any) {
      log?.warn(`[MAX] Webhook subscription failed, falling back to polling: ${err?.message ?? err}`);
    }
  }

  const stopBot = () => {
    try {
      bot.stopPolling();
    } catch {
      // bot was not polling
    }
  };
  ctx.abortSignal?.addEventListener("abort", stopBot, { once: true });

  try {
    if (webhookActive) {
      await waitUntilAbort(ctx.abortSignal);
      return;
    }

    log?.info("[MAX] Long polling started");
    // Own polling loop (the SDK's Polling keeps the marker in memory only):
    // the marker + recent dedup ids are persisted AFTER each fully processed
    // batch, so a gateway restart replays at most one batch and the persisted
    // dedup snapshot absorbs it (at-least-once). Transient errors retry with
    // exponential backoff inside the loop; anything else propagates to the
    // account supervisor below.
    const MIN_RESTART_DELAY_MS = 5000;
    const MAX_RESTART_DELAY_MS = 5 * 60 * 1000;
    const HEALTHY_RUN_MS = 60000;
    let restartDelayMs = MIN_RESTART_DELAY_MS;
    const supervise = (async () => {
      while (!ctx.abortSignal?.aborted) {
        const startedAt = Date.now();
        await runPollingLoop({
          bot,
          accountId: ctx.accountId,
          token: account.token,
          handler,
          signal: ctx.abortSignal,
          log,
        });
        if (ctx.abortSignal?.aborted) break;
        if (Date.now() - startedAt > HEALTHY_RUN_MS) restartDelayMs = MIN_RESTART_DELAY_MS;
        const waitMs = Math.round(restartDelayMs * (0.5 + Math.random()));
        log?.warn(`[MAX] Long polling exited unexpectedly, restarting in ${Math.round(waitMs / 1000)}s`);
        stopBot();
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (ctx.abortSignal?.aborted) break;
        restartDelayMs = Math.min(restartDelayMs * 2, MAX_RESTART_DELAY_MS);
        log?.info("[MAX] Long polling restarting");
      }
      log?.info("[MAX] Long polling stopped");
    })();
    supervise.catch((err: any) => {
      const message = err?.message ?? String(err);
      statusSink({ running: false, lastError: message });
      log?.error(`[MAX] Account loop failed: ${message}`);
    });
    await waitUntilAbort(ctx.abortSignal);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    statusSink({ running: false, lastError: message });
    log?.error(`[MAX] Account loop failed: ${message}`);
    throw err;
  } finally {
    stopWebhookWatchdog?.();
    ctx.abortSignal?.removeEventListener("abort", stopBot);
    stopBot();
    statusSink({ running: false, lastStopAt: Date.now() });
  }
}
