import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
/**
 * Update types defined by the MAX API schema that this channel deliberately
 * does not handle (chat-administration and comment-thread events). Anything
 * not in this list and not handled is an unknown type worth a debug note.
 */
export declare const MAX_IGNORED_UPDATE_TYPES: readonly ["message_removed", "comment_created", "comment_edited", "comment_removed", "bot_added", "bot_removed", "user_added", "user_removed", "bot_started", "bot_stopped", "dialog_cleared", "dialog_removed", "dialog_muted", "dialog_unmuted", "chat_title_changed", "bot_admin_permissions_changed"];
/** Update types this channel processes in extractInboundFacts. */
export declare const MAX_HANDLED_UPDATE_TYPES: readonly ["message_created", "message_edited", "message_callback"];
/** Shared update handler for webhook and polling transports. */
export declare function handleUpdate(api: OpenClawPluginApi, update: any, token: string): Promise<void>;
declare const _default: {
    id: string;
    name: string;
    description: string;
    configSchema: import("node_modules/openclaw/dist/zod-schema.implicit-mentions-Du1YLL_X.js").l;
    register: (api: OpenClawPluginApi) => void;
    channelPlugin: import("openclaw/plugin-sdk/channel-core").ChannelPlugin<import("./channel.js").ResolvedAccount, {
        ok: boolean;
        error?: string;
        bot?: {
            username?: string;
            name?: string;
        };
    }, unknown>;
    setChannelRuntime?: (runtime: import("openclaw/plugin-sdk/channel-core").PluginRuntime) => void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map