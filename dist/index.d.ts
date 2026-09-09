import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
/** Shared update handler for webhook and polling transports. */
export declare function handleUpdate(api: OpenClawPluginApi, update: any, token: string): Promise<void>;
declare const _default: {
    id: string;
    name: string;
    description: string;
    configSchema: import("node_modules/openclaw/dist/types.config-CGDAHrEQ.js").n;
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