import path from "node:path";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { ensureBotForOutbound, getBot, getMaxFetch, rawUploadMaxMedia, resolveMaxUploadType, sendMaxMessage, } from "../channel.js";
import { downloadRemoteMedia, readLocalMedia } from "./media-access.js";
function textResult(text, details) {
    return { content: [{ type: "text", text }], details };
}
export function createMaxSendFileTool(toolCtx) {
    return {
        name: "max_send_file",
        label: "MAX: Send File",
        description: "Send a file to the current MAX chat. Provide either `path` (a local file inside " +
            "the agent's media roots) or `url` (http/https, downloaded through a safety " +
            "guard), plus an optional `caption`.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Absolute path to a local file inside the allowed media roots",
                },
                url: {
                    type: "string",
                    description: "http(s) URL of the file to download and send",
                },
                caption: {
                    type: "string",
                    description: "Optional message text sent with the file",
                },
            },
        },
        async execute(_toolCallId, params) {
            const filePath = String(params.path ?? "").trim();
            const fileUrl = String(params.url ?? "").trim();
            const caption = String(params.caption ?? "").trim();
            if (!filePath && !fileUrl) {
                return textResult("Error: either path or url is required", {
                    ok: false,
                    reason: "missing_source",
                });
            }
            if (filePath && fileUrl) {
                return textResult("Error: pass only one of path or url", {
                    ok: false,
                    reason: "ambiguous_source",
                });
            }
            // The chat id belongs to the delivery route the runtime bound to this
            // session; without it there is no trustworthy destination.
            const delivery = toolCtx.deliveryContext;
            const to = delivery?.to?.trim();
            if (!to || (delivery?.channel && delivery.channel !== "max")) {
                return textResult("Error: no current MAX chat — the tool works only from a MAX-bound session", { ok: false, reason: "no_chat_context" });
            }
            const cfg = toolCtx.getRuntimeConfig?.() ?? toolCtx.runtimeConfig ?? toolCtx.config ?? {};
            try {
                const bot = getBot() ?? ensureBotForOutbound(cfg);
                let data;
                let filename;
                let contentType;
                if (filePath) {
                    const roots = [
                        ...getAgentScopedMediaLocalRoots(cfg, toolCtx.agentId),
                        ...(toolCtx.workspaceDir ? [toolCtx.workspaceDir] : []),
                    ];
                    data = await readLocalMedia(filePath, { mediaLocalRoots: roots });
                    filename = path.basename(filePath);
                }
                else {
                    const fetched = await downloadRemoteMedia({ url: fileUrl, fetchImpl: getMaxFetch() });
                    data = fetched.buffer;
                    filename =
                        decodeURIComponent(new URL(fileUrl).pathname.split("/").pop() ?? "") || "file";
                    contentType = fetched.contentType || undefined;
                }
                const uploadType = resolveMaxUploadType(filename, contentType);
                const attachment = await rawUploadMaxMedia(bot, uploadType, data, filename);
                const sent = await sendMaxMessage(bot, to, caption || filename, {
                    attachments: [attachment],
                });
                const messageId = sent?.message?.body?.mid ?? sent?.body?.mid ?? sent?.id;
                return textResult(`File sent: ${filename} (${data.byteLength} bytes)`, {
                    ok: true,
                    filename,
                    fileSize: data.byteLength,
                    uploadType,
                    to,
                    ...(messageId != null ? { messageId: String(messageId) } : {}),
                });
            }
            catch (err) {
                return textResult(`Error sending file: ${err?.message ?? err}`, {
                    ok: false,
                    reason: "send_failed",
                    error: String(err?.message ?? err),
                });
            }
        },
    };
}
//# sourceMappingURL=send-file-tool.js.map