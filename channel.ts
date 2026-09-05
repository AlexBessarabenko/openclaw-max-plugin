import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink, waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-runtime";
import { buildProbeChannelStatusSummary } from "openclaw/plugin-sdk/channel-status";
import { createComputedAccountStatusAdapter, createDefaultChannelRuntimeState } from "openclaw/plugin-sdk/status-helpers";
import { Bot } from "@maxhub/max-bot-api";

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
  };
}

/** Strip routing prefixes ("max:", "max:group:") from a delivery target. */
export function stripMaxTarget(target: string): string {
  return target.replace(/^max:(group:)?/, "");
}

// Store bot instance for outbound messaging
let botInstance: Bot | null = null;

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
    const resp = await fetch(`${account.apiBaseUrl}/me`, {
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
            Number(stripMaxTarget(params.id)),
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
        if (!botInstance) {
          throw new Error("MAX bot not initialized");
        }
        // chat_id works uniformly for dialogs, groups and channels
        const sent = await botInstance.api.sendMessageToChat(
          Number(stripMaxTarget(params.to)),
          params.text,
          { format: "markdown" }
        );
        // the api client returns the raw response ({ message: {...} })
        const mid = (sent as any)?.message?.body?.mid ?? (sent as any)?.body?.mid ?? (sent as any)?.id;
        return { messageId: mid != null ? String(mid) : String(Date.now()) };
      },
    },
  },
});

// Initialize bot function
export function initializeBot(token: string, apiBaseUrl?: string): Bot {
  if (botInstance) {
    try {
      botInstance.stop();
    } catch {
      // previous instance was not polling
    }
  }
  botInstance = new Bot(token, {
    clientOptions: { baseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL },
  });
  return botInstance;
}

// Get current bot instance
export function getBot(): Bot | null {
  return botInstance;
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

  const bot = initializeBot(account.token, account.apiBaseUrl);
  statusSink({ running: true, lastStartAt: Date.now(), lastError: null });

  let webhookActive = false;
  if (account.webhookUrl) {
    try {
      await bot.api.getMyInfo();
      const resp = await fetch(`${account.apiBaseUrl}/subscriptions`, {
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
      bot.stop();
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
    // bot.start() resolves when polling stops; the max-bot-api polling
    // loop also returns silently after transient fetch errors, so supervise it.
    while (!ctx.abortSignal?.aborted) {
      await bot.start({ allowedUpdates: ["message_created", "bot_started"] });
      if (ctx.abortSignal?.aborted) break;
      log?.warn("[MAX] Long polling exited unexpectedly, restarting in 5s");
      stopBot();
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    log?.info("[MAX] Long polling stopped");
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
