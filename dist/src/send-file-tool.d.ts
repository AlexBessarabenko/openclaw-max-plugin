/**
 * Agent tool `max_send_file`: deliver a file into the MAX chat the current
 * session is bound to.
 *
 * Chat binding comes from the call context (`deliveryContext`, populated by
 * the runtime for channel-originated sessions) — never from module-global
 * state. Local paths are confined to the agent's media roots (plus the
 * session workspace); remote URLs go through the SSRF-guarded download.
 */
/** Minimal structural slice of OpenClawPluginToolContext this tool reads. */
export type SendFileToolContext = {
    config?: any;
    runtimeConfig?: any;
    getRuntimeConfig?: () => any;
    agentId?: string;
    workspaceDir?: string;
    deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
    };
};
type SendFileResultDetails = {
    ok: boolean;
    reason?: string;
    filename?: string;
    fileSize?: number;
    uploadType?: string;
    to?: string;
    messageId?: string;
    error?: string;
};
export declare function createMaxSendFileTool(toolCtx: SendFileToolContext): {
    name: string;
    label: string;
    description: string;
    parameters: any;
    execute(_toolCallId: string, params: Record<string, unknown>): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        details: SendFileResultDetails;
    }>;
};
export {};
//# sourceMappingURL=send-file-tool.d.ts.map