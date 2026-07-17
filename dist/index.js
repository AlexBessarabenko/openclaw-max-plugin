import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { getBot, initializeBot, maxPlugin, DEFAULT_ACCOUNT_ID, MAX_CHANNEL_ID } from "./channel.js";
import { ensureRussianTrustedCAs } from "./certs.js";
/** MAX caps message text at 4000 chars. */
const MAX_TEXT_LIMIT = 4000;
// Deduplication: messageId → timestamp (TTL 5 min)
const seenMessages = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000;
function isDuplicate(messageId) {
    const now = Date.now();
    for (const [id, ts] of seenMessages.entries()) {
        if (now - ts > DEDUP_TTL_MS) {
            seenMessages.delete(id);
        }
    }
    if (seenMessages.has(messageId)) {
        return true;
    }
    seenMessages.set(messageId, now);
    return false;
}
function chunkText(text, limit) {
    const chunks = [];
    for (let i = 0; i < text.length; i += limit) {
        chunks.push(text.slice(i, i + limit));
    }
    return chunks.length > 0 ? chunks : [""];
}
/** Normalize a raw MAX update (webhook or polling) into inbound facts. */
function extractInboundFacts(update) {
    const type = update?.update_type;
    if (type === "message_created" && update.message) {
        const m = update.message;
        const sender = m.sender ?? {};
        const recipient = m.recipient ?? {};
        const body = m.body ?? {};
        const chatId = recipient.chat_id ?? m.chat_id ?? update.chat_id;
        const senderId = sender.user_id ?? m.sender_id;
        if (chatId == null || senderId == null)
            return null;
        const senderName = sender.name ||
            [sender.first_name, sender.last_name].filter(Boolean).join(" ") ||
            "Unknown";
        return {
            messageId: String(body.mid ?? m.id ?? `${chatId}:${body.seq ?? m.timestamp ?? Date.now()}`),
            text: body.text ?? m.text ?? "",
            senderId: String(senderId),
            senderName,
            senderIsBot: Boolean(sender.is_bot),
            chatId: String(chatId),
            isGroup: (recipient.chat_type ?? m.chat_type ?? "dialog") !== "dialog",
            timestamp: m.timestamp,
            attachments: m.attachments ?? body.attachments ?? undefined,
        };
    }
    // "Начать" button pressed in a dialog; payload carries the deep-link parameter
    if (type === "bot_started") {
        const user = update.user ?? {};
        const chatId = update.chat_id ?? user.user_id;
        if (chatId == null || user.user_id == null)
            return null;
        const payload = typeof update.payload === "string" && update.payload ? ` ${update.payload}` : "";
        return {
            messageId: `bot_started:${chatId}:${update.timestamp ?? Date.now()}`,
            text: `/start${payload}`,
            senderId: String(user.user_id),
            senderName: user.name || [user.first_name, user.last_name].filter(Boolean).join(" ") || "Unknown",
            senderIsBot: false,
            chatId: String(chatId),
            isGroup: false,
            timestamp: update.timestamp,
        };
    }
    return null;
}
function attachmentContentType(att) {
    if (att?.type === "image")
        return "image/jpeg";
    if (att?.type === "video")
        return "video/mp4";
    if (att?.type === "file") {
        return att?.payload?.filename?.endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
    }
    return "application/octet-stream";
}
/** Attachment URLs live on MAX infrastructure and accept the bot/file token. */
function attachmentNeedsAuth(url) {
    try {
        const host = new URL(url).hostname;
        return /(^|\.)max\.ru$/.test(host) || /(^|\.)oneme\.ru$/.test(host);
    }
    catch {
        return false;
    }
}
async function downloadAttachment(url, token) {
    const headers = token && attachmentNeedsAuth(url) ? { Authorization: `Bearer ${token}` } : undefined;
    const resp = await fetch(url, headers ? { headers } : undefined);
    if (!resp.ok)
        throw new Error(`download failed: HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
}
/**
 * Transcribe a saved audio file through the core media-understanding pipeline.
 * Provider, API key and language all come from the gateway operator's
 * `tools.media.audio` config; returns null when no STT provider is configured.
 */
async function transcribeSavedAudio(api, filePath, mime) {
    const mu = api.runtime?.mediaUnderstanding;
    if (!mu?.transcribeAudioFile)
        return null;
    try {
        const cfg = api.runtime.config.current();
        const res = await mu.transcribeAudioFile({ filePath, cfg, mime });
        return res?.text ?? null;
    }
    catch (err) {
        api.logger.warn(`[MAX] audio transcription skipped: ${err.message}`);
        return null;
    }
}
/** Download attachments into the media store; voice is transcribed by the core media-understanding pipeline (`tools.media.audio`). */
async function buildTextAndMedia(api, facts, token) {
    const rt = api.runtime?.channel;
    const media = [];
    let text = facts.text;
    for (const att of facts.attachments ?? []) {
        const url = att?.payload?.url ?? (Array.isArray(att?.payload?.ls) ? att.payload.ls[0] : undefined);
        if (!url)
            continue;
        if (att.type === "audio") {
            const audioContentType = att?.payload?.contentType ?? "audio/ogg";
            try {
                const buf = await downloadAttachment(url, att?.payload?.token ?? token);
                if (!rt?.media?.saveMediaBuffer) {
                    media.push({ url, contentType: audioContentType, kind: "audio" });
                    continue;
                }
                const saved = await rt.media.saveMediaBuffer(buf, audioContentType, "inbound", undefined, att?.payload?.filename);
                const transcript = await transcribeSavedAudio(api, saved.path, saved.contentType ?? audioContentType);
                if (transcript) {
                    text = text ? `${text}\n[Voice]: ${transcript}` : `[Voice]: ${transcript}`;
                }
                media.push({
                    path: saved.path,
                    url: saved.path,
                    contentType: saved.contentType ?? audioContentType,
                    kind: "audio",
                    transcribed: Boolean(transcript),
                });
            }
            catch (err) {
                api.logger.warn(`[MAX] audio attachment handling failed: ${err.message}`);
                media.push({ url, contentType: audioContentType, kind: "audio" });
            }
            continue;
        }
        const kind = att.type === "image" ? "image" : att.type === "video" ? "video" : att.type === "file" ? "document" : "unknown";
        if (kind === "unknown")
            continue;
        const contentType = attachmentContentType(att);
        try {
            const buf = await downloadAttachment(url, att?.payload?.token ?? token);
            if (rt?.media?.saveMediaBuffer) {
                const saved = await rt.media.saveMediaBuffer(buf, contentType, "inbound", undefined, att?.payload?.filename);
                media.push({ path: saved.path, url: saved.path, contentType: saved.contentType ?? contentType, kind });
            }
            else {
                media.push({ url, contentType, kind });
            }
        }
        catch (err) {
            api.logger.warn(`[MAX] attachment download failed: ${err.message}`);
            media.push({ url, contentType, kind });
        }
    }
    return { text, media };
}
/** Feed one normalized inbound message into the OpenClaw runtime. */
async function runInbound(api, facts, token) {
    const rt = api.runtime?.channel;
    if (!rt?.inbound?.run) {
        api.logger.warn("[MAX] api.runtime.channel not available, skipping inbound");
        return;
    }
    const { text, media } = await buildTextAndMedia(api, facts, token);
    const { chatId, senderId, senderName, isGroup } = facts;
    api.logger.info(`[MAX] inbound: chat=${chatId} type=${isGroup ? "group" : "direct"} from=${senderId} preview="${text.substring(0, 50)}"`);
    await rt.inbound.run({
        channel: MAX_CHANNEL_ID,
        accountId: DEFAULT_ACCOUNT_ID,
        raw: facts,
        adapter: {
            ingest: (raw) => ({
                id: raw.messageId,
                timestamp: raw.timestamp,
                rawText: text,
                textForAgent: text,
                textForCommands: text,
                raw,
            }),
            resolveTurn: async () => {
                const cfg = api.runtime.config.current();
                // Canonical routing: bindings may map this peer to a specific agent
                const route = rt.routing.resolveAgentRoute({
                    cfg,
                    channel: MAX_CHANNEL_ID,
                    accountId: DEFAULT_ACCOUNT_ID,
                    peer: { kind: isGroup ? "group" : "direct", id: isGroup ? chatId : senderId },
                });
                // Default-route DMs get per-peer sessions instead of collapsing into
                // the agent main session (same override the Telegram channel applies)
                let sessionKey = route.sessionKey;
                if (!isGroup && route.matchedBy === "default") {
                    sessionKey = rt.routing.buildAgentSessionKey({
                        agentId: route.agentId,
                        channel: MAX_CHANNEL_ID,
                        accountId: route.accountId,
                        peer: { kind: "direct", id: senderId },
                        dmScope: "per-account-channel-peer",
                        identityLinks: cfg.session?.identityLinks,
                    });
                }
                const storePath = rt.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
                const ctxPayload = rt.inbound.buildContext({
                    channel: MAX_CHANNEL_ID,
                    accountId: route.accountId,
                    provider: "max",
                    surface: "max",
                    messageId: facts.messageId,
                    timestamp: facts.timestamp,
                    from: isGroup ? `max:group:${chatId}` : `max:${senderId}`,
                    sender: { id: senderId, name: senderName, isBot: facts.senderIsBot },
                    conversation: {
                        kind: isGroup ? "group" : "direct",
                        id: chatId,
                        label: isGroup ? `MAX chat ${chatId}` : senderName,
                    },
                    route: {
                        agentId: route.agentId,
                        accountId: route.accountId,
                        routeSessionKey: sessionKey,
                        mainSessionKey: route.mainSessionKey,
                    },
                    reply: { to: `max:${chatId}` },
                    message: {
                        inboundEventKind: "user_request",
                        rawBody: text,
                        body: text,
                        bodyForAgent: text,
                        commandBody: text,
                    },
                    access: { commands: { authorized: false, useAccessGroups: false, allowTextCommands: true } },
                    media: media.length > 0 ? media : undefined,
                });
                const sendTyping = async () => {
                    const bot = getBot();
                    if (bot) {
                        await bot.api.sendAction(Number(chatId), "typing_on");
                    }
                };
                return {
                    channel: MAX_CHANNEL_ID,
                    accountId: route.accountId,
                    routeSessionKey: sessionKey,
                    storePath,
                    ctxPayload,
                    recordInboundSession: rt.session.recordInboundSession,
                    record: {
                        updateLastRoute: {
                            sessionKey,
                            channel: MAX_CHANNEL_ID,
                            to: `max:${chatId}`,
                            accountId: route.accountId,
                        },
                        onRecordError: (err) => api.logger.warn(`[MAX] session record failed: ${err?.message ?? err}`),
                    },
                    runDispatch: () => rt.reply.dispatchReplyWithBufferedBlockDispatcher({
                        ctx: ctxPayload,
                        cfg,
                        dispatcherOptions: {
                            typingCallbacks: createTypingCallbacks({
                                start: sendTyping,
                                onStartError: () => {
                                    // typing is best-effort
                                },
                                keepaliveIntervalMs: 4000,
                                maxDurationMs: 120000,
                            }),
                            deliver: async (payload) => {
                                const bot = getBot();
                                const out = typeof payload?.text === "string" ? payload.text : "";
                                if (!bot || !out.trim())
                                    return undefined;
                                const messageIds = [];
                                for (const chunk of chunkText(out, MAX_TEXT_LIMIT)) {
                                    let sent;
                                    try {
                                        sent = await bot.api.sendMessageToChat(Number(chatId), chunk, { format: "markdown" });
                                    }
                                    catch {
                                        // invalid markdown must not lose the reply
                                        sent = await bot.api.sendMessageToChat(Number(chatId), chunk);
                                    }
                                    const mid = sent?.message?.body?.mid ?? sent?.body?.mid ?? sent?.id;
                                    if (mid != null)
                                        messageIds.push(String(mid));
                                }
                                return messageIds.length > 0 ? { messageIds } : undefined;
                            },
                            onError: (err) => {
                                api.logger.error(`[MAX] reply dispatch error: ${err?.message ?? err}`);
                            },
                        },
                    }),
                };
            },
        },
    });
}
/** Shared update handler for webhook and polling transports. */
async function handleUpdate(api, update, token) {
    const facts = extractInboundFacts(update);
    if (!facts)
        return;
    // Loop protection: never react to other bots (or our own echo)
    if (facts.senderIsBot)
        return;
    if (isDuplicate(facts.messageId)) {
        api.logger.info(`[MAX] duplicate message ${facts.messageId} ignored`);
        return;
    }
    await runInbound(api, facts, token);
}
export default defineChannelPluginEntry({
    id: MAX_CHANNEL_ID,
    name: "MAX Messenger",
    description: "MAX Messenger channel plugin for OpenClaw",
    plugin: maxPlugin,
    registerCliMetadata(api) {
        api.registerCli(({ program }) => {
            program.command("max").description("MAX Messenger management");
        }, {
            descriptors: [
                {
                    name: "max",
                    description: "MAX Messenger management",
                    hasSubcommands: false,
                },
            ],
        });
    },
    async registerFull(api) {
        ensureRussianTrustedCAs(api.logger);
        const cfg = api.config;
        const section = cfg?.channels?.[MAX_CHANNEL_ID];
        const token = section?.token;
        if (!token) {
            api.logger.warn("[MAX] No token found, bot not initialized");
            return;
        }
        const bot = initializeBot(token, section?.apiBaseUrl);
        const baseUrl = section?.apiBaseUrl ?? "https://platform-api2.max.ru";
        // --- Webhook handler ---
        api.registerHttpRoute({
            path: "/max/webhook",
            auth: "plugin",
            handler: async (req, res) => {
                try {
                    if (section?.webhookSecret) {
                        const header = req.headers["x-max-bot-api-secret"];
                        if (header !== section.webhookSecret) {
                            res.statusCode = 403;
                            res.end("forbidden");
                            return true;
                        }
                    }
                    const body = await new Promise((resolve, reject) => {
                        let data = "";
                        req.on("data", (chunk) => (data += chunk));
                        req.on("end", () => resolve(data));
                        req.on("error", reject);
                    });
                    const update = JSON.parse(body);
                    // MAX requires a timely HTTP 200; process after ACK
                    res.statusCode = 200;
                    res.end("ok");
                    handleUpdate(api, update, token).catch((err) => api.logger.error("[MAX] update handling failed: " + (err?.message ?? err)));
                    return true;
                }
                catch (err) {
                    api.logger.error("[MAX] Webhook error: " + err.message);
                    res.statusCode = 500;
                    res.end("error");
                    return true;
                }
            },
        });
        // --- Transport selection: webhook if a public URL is configured, else polling ---
        let webhookActive = false;
        if (section?.webhookUrl) {
            try {
                await bot.api.getMyInfo();
                const resp = await fetch(`${baseUrl}/subscriptions`, {
                    method: "POST",
                    headers: { "content-type": "application/json", Authorization: token },
                    body: JSON.stringify({
                        url: section.webhookUrl,
                        update_types: ["message_created", "bot_started"],
                        ...(section.webhookSecret ? { secret: section.webhookSecret } : {}),
                    }),
                });
                if (!resp.ok) {
                    throw new Error(`POST /subscriptions failed: HTTP ${resp.status} ${await resp.text()}`);
                }
                webhookActive = true;
                api.logger.info(`[MAX] Webhook subscribed: ${section.webhookUrl}`);
            }
            catch (err) {
                api.logger.warn(`[MAX] Webhook subscription failed, falling back to polling: ${err.message}`);
            }
        }
        if (!webhookActive) {
            bot.on("message_created", async (ctx) => {
                try {
                    await handleUpdate(api, ctx.update ?? { update_type: "message_created", message: ctx.message }, token);
                }
                catch (err) {
                    api.logger.error("[MAX] polling update failed: " + (err?.message ?? err));
                }
            });
            bot.on("bot_started", async (ctx) => {
                try {
                    await handleUpdate(api, ctx.update ?? ctx, token);
                }
                catch (err) {
                    api.logger.error("[MAX] bot_started handling failed: " + (err?.message ?? err));
                }
            });
            bot
                .start({ allowedUpdates: ["message_created", "bot_started"] })
                .then(() => api.logger.info("[MAX] Long polling started"))
                .catch((err) => {
                api.logger.error("[MAX] Failed to start bot polling: " + err.message);
            });
        }
    },
});
//# sourceMappingURL=index.js.map