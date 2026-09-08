import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink, waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { buildProbeChannelStatusSummary } from "openclaw/plugin-sdk/channel-status";
import { createComputedAccountStatusAdapter, createDefaultChannelRuntimeState } from "openclaw/plugin-sdk/status-helpers";
import { Bot } from "@maxhub/max-bot-api";
import { createMaxScopedFetch } from "./certs.js";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { downloadRemoteMedia, readLocalMedia } from "./src/media-access.js";
import { primeSeenMessageIds, recentSeenMessageIds } from "./src/dedup.js";
import { loadMaxPollingState, saveMaxPollingState } from "./src/polling-state.js";

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
};

function resolveAccountId(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): string {
  return params.accountId ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccount(
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
  const hasAttachments =
    Array.isArray((extra as any)?.attachments) && (extra as any).attachments.length > 0;
  const maxAttempts = hasAttachments ? 1 + ATTACHMENT_RETRY_DELAYS_MS.length : 1;
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
        "Attach media via the message tool `media` param (local path or URL).",
        "Groups: the bot may answer only when @-mentioned or replied to (requireMention config).",
        "Inline keyboards: pass `channelData.maxInlineKeyboard` on the message tool —",
        "an array of rows, each row an array of buttons `{text, url?, payload?}`",
        "(url → link button, otherwise callback; payload defaults to the label) or",
        "plain strings (callback with payload = text). Full wire buttons",
        "`{type: \"callback\"|\"link\"|\"clipboard\", ...}` are accepted too.",
        "Limits: ≤210 buttons, ≤30 rows, ≤7 per row (≤3 if a row has a link),",
        "link URL ≤2048 chars. The keyboard attaches to the final reply only,",
        "on the reply path (not via `openclaw message send`); a button press",
        "returns as an inbound message carrying the payload (plus a quote of",
        "the message the button was on) — make payloads self-describing.",
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
    config: {
      resolveAccount,
      listAccountIds(cfg) {
        return [DEFAULT_ACCOUNT_ID];
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

  // Pairing: approval flow for new DM contacts
  pairing: {
    text: {
      idLabel: "MAX user ID",
      message: "Send this code to verify your identity:",
      notify: async (params: {
        cfg: OpenClawConfig;
        id: string;
        accountId?: string;
        runtime?: any;
        message: string;
      }) => {
        if (botInstance) {
          await botInstance.api.sendMessageToUser(
            Number(normalizeMaxTarget(params.id).replace(/^user:/i, "")),
            params.message,
            { format: "markdown" }
          );
        }
      },
    },
  },

  // Threading: how replies are delivered
  threading: { topLevelReplyToMode: "reply" },

  // Outbound: send messages to the platform
  outbound: {
    base: {
      deliveryMode: "direct",
    },
    attachedResults: {
      channel: MAX_CHANNEL_ID,
      sendText: async (params) => {
        const bot = ensureBotForOutbound(params.cfg);
        const sent = await sendMaxMessage(bot, params.to, params.text, { format: "markdown" });
        return { messageId: extractSentMessageId(sent) };
      },
      sendMedia: async (params) => {
        const bot = ensureBotForOutbound(params.cfg);
        const mediaUrl = params.mediaUrl;
        if (!mediaUrl) {
          throw new Error("mediaUrl is required");
        }
        let data: Buffer;
        let filename: string;
        let contentType: string | undefined;
        if (/^https?:\/\//i.test(mediaUrl)) {
          // SSRF-guarded download; scoped MAX fetch (CA/proxy) stays in effect
          const fetched = await downloadRemoteMedia({ url: mediaUrl, fetchImpl: getMaxFetch() });
          data = fetched.buffer;
          filename =
            decodeURIComponent(new URL(mediaUrl).pathname.split("/").pop() ?? "") || "file";
          contentType = fetched.contentType || undefined;
        } else {
          // Local paths only via the host reader or inside the allowed media
          // roots — otherwise an agent-named path could exfiltrate any file.
          data = await readLocalMedia(mediaUrl, {
            mediaReadFile: params.mediaReadFile,
            mediaLocalRoots:
              params.mediaLocalRoots ?? getAgentScopedMediaLocalRoots(params.cfg),
          });
          filename = mediaUrl.split("/").pop() || "file";
        }
        const uploadType = resolveMaxUploadType(filename, contentType);
        const attachment = await rawUploadMaxMedia(bot, uploadType, data, filename);
        const sent = await sendMaxMessage(bot, params.to, params.text ?? "", {
          attachments: [attachment as any],
        });
        return { messageId: extractSentMessageId(sent) };
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

  let webhookActive = false;
  if (account.webhookUrl) {
    try {
      await bot.api.getMyInfo();
      const resp = await maxFetch(`${account.apiBaseUrl}/subscriptions`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: account.token },
        body: JSON.stringify({
          url: account.webhookUrl,
          update_types: ["message_created", "message_callback", "bot_started", "message_edited"],
          ...(account.webhookSecret ? { secret: account.webhookSecret } : {}),
        }),
      });
      if (!resp.ok) {
        throw new Error(`POST /subscriptions failed: HTTP ${resp.status} ${await resp.text()}`);
      }
      webhookActive = true;
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
    ctx.abortSignal?.removeEventListener("abort", stopBot);
    stopBot();
    statusSink({ running: false, lastStopAt: Date.now() });
  }
}
