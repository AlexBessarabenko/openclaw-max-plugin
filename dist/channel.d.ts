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
};
/** Strip routing prefixes ("max:", "max:group:") from a delivery target. */
export declare function stripMaxTarget(target: string): string;
type InboundUpdateHandler = (update: any, token: string) => Promise<void>;
export declare function setMaxUpdateHandler(handler: InboundUpdateHandler): void;
type MaxProbe = {
    ok: boolean;
    error?: string;
    bot?: {
        username?: string;
        name?: string;
    };
};
export declare const maxPlugin: import("openclaw/plugin-sdk/channel-core").ChannelPlugin<ResolvedAccount, MaxProbe, unknown>;
export declare function initializeBot(token: string, apiBaseUrl?: string): Bot;
export declare function getBot(): Bot | null;
export {};
//# sourceMappingURL=channel.d.ts.map