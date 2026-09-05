import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink, waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { buildProbeChannelStatusSummary } from "openclaw/plugin-sdk/channel-status";
import { createComputedAccountStatusAdapter, createDefaultChannelRuntimeState } from "openclaw/plugin-sdk/status-helpers";
import { Bot } from "@maxhub/max-bot-api";
import { createMaxScopedFetch } from "./certs.js";

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

async function sendMaxMessage(
  bot: Bot,
  to: string,
  text: string,
  extra?: Record<string, unknown>,
): Promise<any> {
  const target = resolveSendTarget(to);
  return "userId" in target
    ? bot.api.sendMessageToUser(target.userId, text, extra as any)
    : bot.api.sendMessageToChat(target.chatId, text, extra as any);
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

function resolveMaxUploadType(filename?: string, contentType?: string): MaxUploadType {
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
async function rawUploadMaxMedia(
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
          const res = await fetch(mediaUrl);
          if (!res.ok) throw new Error(`failed to fetch media: HTTP ${res.status}`);
          data = Buffer.from(await res.arrayBuffer());
          filename =
            decodeURIComponent(new URL(mediaUrl).pathname.split("/").pop() ?? "") || "file";
          contentType = res.headers.get("content-type") ?? undefined;
        } else {
          if (!params.mediaReadFile) {
            throw new Error("local media is not readable in this context");
          }
          data = Buffer.from(await params.mediaReadFile(mediaUrl));
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
function ensureBotForOutbound(cfg: OpenClawConfig): Bot {
  if (botInstance) return botInstance;
  const account = resolveAccount(cfg, DEFAULT_ACCOUNT_ID);
  if (!account.token) throw new Error("MAX token is not configured");
  return initializeBot(account.token, account.apiBaseUrl, account.httpProxy);
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
          update_types: ["message_created", "bot_started"],
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

    bot.catch((err: any) => {
      log?.error(`[MAX] Bot middleware error: ${err?.message ?? err}`);
    });
    bot.on("message_created", async (botCtx: any) => {
      try {
        await handler(
          botCtx.update ?? { update_type: "message_created", message: botCtx.message },
          account.token,
        );
      } catch (err: any) {
        log?.error("[MAX] polling update failed: " + (err?.message ?? err));
      }
    });
    bot.on("bot_started", async (botCtx: any) => {
      try {
        await handler(botCtx.update ?? botCtx, account.token);
      } catch (err: any) {
        log?.error("[MAX] bot_started handling failed: " + (err?.message ?? err));
      }
    });

    log?.info("[MAX] Long polling started");
    // max-bot-api 0.3.1 reads bot.botInfo.username in startPolling but only
    // populates botInfo in the legacy start() flow — fetch it explicitly,
    // otherwise polling dies instantly on a TypeError and retries forever.
    try {
      bot.botInfo = await bot.api.getMyInfo();
    } catch (err: any) {
      log?.warn(`[MAX] getMyInfo failed before polling: ${err?.message ?? err}`);
    }
    // bot.startPolling() resolves when polling stops. max-bot-api ≥ 0.3.1
    // retries transient errors internally and honors AbortSignal; the
    // supervisor stays as a safety net for silent exits. Restarts use
    // exponential backoff with jitter (5s → 5min) so a MAX-side outage is
    // not hammered; a healthy run > 60s resets the delay.
    const MIN_RESTART_DELAY_MS = 5000;
    const MAX_RESTART_DELAY_MS = 5 * 60 * 1000;
    const HEALTHY_RUN_MS = 60000;
    let restartDelayMs = MIN_RESTART_DELAY_MS;
    const supervise = (async () => {
      while (!ctx.abortSignal?.aborted) {
        const startedAt = Date.now();
        await bot.startPolling({ allowedUpdates: ["message_created", "bot_started"] });
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
