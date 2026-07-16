import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { Bot } from "@maxhub/max-bot-api";
export const MAX_CHANNEL_ID = "max";
export const DEFAULT_ACCOUNT_ID = "default";
/** MAX Bot API v2 base URL (platform-api.max.ru is deprecated since 2026-07-19). */
export const DEFAULT_API_BASE_URL = "https://platform-api2.max.ru";
function resolveAccountId(params) {
    return params.accountId ?? DEFAULT_ACCOUNT_ID;
}
function resolveAccount(cfg, accountId) {
    const section = cfg.channels?.[MAX_CHANNEL_ID];
    const token = section?.token;
    if (!token)
        throw new Error("max: token is required");
    return {
        accountId: accountId ?? null,
        token,
        allowFrom: section?.allowFrom ?? [],
        dmPolicy: section?.dmPolicy,
        webhookUrl: section?.webhookUrl,
        webhookSecret: section?.webhookSecret,
        apiBaseUrl: section?.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    };
}
/** Strip routing prefixes ("max:", "max:group:") from a delivery target. */
export function stripMaxTarget(target) {
    return target.replace(/^max:(group:)?/, "");
}
// Store bot instance for outbound messaging
let botInstance = null;
export const maxPlugin = createChatChannelPlugin({
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
            notify: async (params) => {
                if (botInstance) {
                    await botInstance.api.sendMessageToUser(Number(stripMaxTarget(params.id)), params.message, { format: "markdown" });
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
                const sent = await botInstance.api.sendMessageToChat(Number(stripMaxTarget(params.to)), params.text, { format: "markdown" });
                // the api client returns the raw response ({ message: {...} })
                const mid = sent?.message?.body?.mid ?? sent?.body?.mid ?? sent?.id;
                return { messageId: mid != null ? String(mid) : String(Date.now()) };
            },
        },
    },
});
// Initialize bot function
export function initializeBot(token, apiBaseUrl) {
    botInstance = new Bot(token, {
        clientOptions: { baseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL },
    });
    return botInstance;
}
// Get current bot instance
export function getBot() {
    return botInstance;
}
//# sourceMappingURL=channel.js.map