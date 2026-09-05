import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { Bot } from "@maxhub/max-bot-api";
export declare const MAX_CHANNEL_ID = "max";
export declare const DEFAULT_ACCOUNT_ID = "default";
/** MAX Bot API v2 base URL (platform-api.max.ru is deprecated since 2026-07-19). */
export declare const DEFAULT_API_BASE_URL = "https://platform-api2.max.ru";
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
/** Strip routing prefixes ("max:", "max:group:") from a delivery target. */
export declare function stripMaxTarget(target: string): string;
/**
 * Normalize a delivery target: "max:123", "max:group:-45", "chat:123" → bare chat id;
 * "user:123" / "max:user:123" → "user:123" (kind prefix preserved — a user id is
 * NOT a chat id: sending it via chat_id fails with 404).
 */
export declare function normalizeMaxTarget(raw: string): string;
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
export declare const maxMessaging: ChannelMessagingAdapter;
/** Scoped fetch for direct calls outside bot init (probes, attachment downloads). */
export declare function getMaxFetch(): (input: any, init?: any) => Promise<any>;
type InboundUpdateHandler = (update: any, token: string) => Promise<void>;
export declare function setMaxUpdateHandler(handler: InboundUpdateHandler): void;
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
export declare function runOutsideInheritedRootWork<T>(run: () => T): T;
type MaxProbe = {
    ok: boolean;
    error?: string;
    bot?: {
        username?: string;
        name?: string;
    };
};
export declare const maxPlugin: import("openclaw/plugin-sdk/channel-core").ChannelPlugin<ResolvedAccount, MaxProbe, unknown>;
export declare function initializeBot(token: string, apiBaseUrl?: string, httpProxy?: string): Bot;
export declare function getBot(): Bot | null;
export {};
//# sourceMappingURL=channel.d.ts.map