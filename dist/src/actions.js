/**
 * MAX channel message actions adapter — plugin-owned actions on the shared
 * `message` tool.
 *
 * Scope:
 *  - edit   — PUT /messages?message_id. Edit limits: up to 7 days in dialogs;
 *    no time limit for messages with an inline keyboard or in groups/channels;
 *    at most 2 edit operations per second per chat.
 *  - delete — DELETE /messages?message_id. No time limit for the bot's own
 *    messages (≤2 operations/sec per chat).
 *  - pin / unpin — PUT/DELETE /chats/{chat_id}/pin (pin supports notify=false).
 *  - sticker — echo-only: send a sticker by code, or resend the last sticker
 *    seen in the chat (no bundled catalog).
 *  - sendAttachment — native location pin or contact card.
 *
 * Plain `send` (text/media) stays on the core path: the channel ships a
 * messaging target adapter + outbound attachedResults, so the core keeps
 * durable send/retry semantics. The adapter only owns the actions MAX needs
 * channel-specific wire formats for.
 *
 * Wire formats (MAX Bot API v2, verified against @maxhub/max-bot-api@0.3.1):
 *  - sticker:  attachments: [{ type: "sticker", payload: { code } }] (no text)
 *  - location: attachments: [{ type: "location", latitude, longitude }] —
 *              coordinates are TOP-LEVEL fields, not inside payload
 *  - contact:  attachments: [{ type: "contact", payload: { vcf_info, max_info, hash } }]
 *              (snake_case, per the SDK's ContactAttachmentRequest):
 *              max_info = { user_id } for a MAX contact by user id;
 *              vcf_info = VCard (BEGIN:VCARD/VERSION:3.0/FN/TEL/END:VCARD) for
 *              name+phone, signed with hash = HMAC-SHA256(key=access_token,
 *              data=vcf_info) hex.
 */
import { createHmac } from "node:crypto";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { MAX_CHANNEL_ID, ensureBotForOutbound, normalizeMaxTarget, resolveAccount, sendMaxBody, } from "../channel.js";
import { getLastStickerCode } from "./stickers.js";
import { groupChatAdmission } from "./chat-policy.js";
/**
 * Moderation-action scoping (0.5.3): actions may target DMs freely (the bot
 * can only touch its own messages there) but GROUP chats only when admitted
 * by the channels.max group policy — a prompt injection in one chat must not
 * reach another chat the bot sits in.
 *
 * Chat typing uses the MAX id convention the plugin already relies on
 * (maxMessaging.inferTargetChatType, agentPrompt): dialog chat ids are
 * positive, group/channel ids are negative — so explicit chat targets need
 * no API call. edit/delete carry only a messageId; the chat is resolved via
 * GET /messages/{mid} (bot.api.getMessage → recipient.{chat_id, chat_type})
 * and cached process-lifetime (a mid never changes chats). Resolution
 * failures are fail-closed: the action is refused.
 */
/** mid → message chat, process-lifetime (immutable mapping). */
const messageChatCache = new Map();
const MESSAGE_CHAT_CACHE_MAX = 1000;
export function resetActionChatCachesForTest() {
    messageChatCache.clear();
}
/** Dialog chat ids are positive by MAX convention; groups must be admitted. */
function assertChatIdAdmitted(cfg, chatId, action) {
    if (chatId >= 0)
        return;
    const admission = groupChatAdmission(cfg, chatId);
    if (!admission.admitted) {
        throw new Error(`${action}: chat ${chatId} is not admitted by the channels.max group policy (${admission.reason})`);
    }
}
/** Gate for actions with an explicit target (pin/unpin/sticker/sendAttachment). */
function assertActionTargetAdmitted(cfg, rawTo, action) {
    const t = normalizeMaxTarget(rawTo);
    if (/^user:/i.test(t))
        return; // DM target — always admitted
    const chatId = Number(t);
    if (!Number.isFinite(chatId))
        return; // invalid target: downstream validation errors
    assertChatIdAdmitted(cfg, chatId, action);
}
/** Gate for edit/delete: resolve the message's chat, then apply the policy. */
async function assertMessageActionAdmitted(cfg, bot, messageId, action) {
    let info = messageChatCache.get(messageId);
    if (!info) {
        let msg;
        try {
            msg = await bot.api.getMessage(messageId);
        }
        catch (err) {
            throw new Error(`${action}: cannot resolve the chat of message ${messageId}; refusing to run ` +
                `(fail-closed): ${err?.message ?? err}`);
        }
        info = {
            chatId: typeof msg?.recipient?.chat_id === "number" ? msg.recipient.chat_id : null,
            chatType: typeof msg?.recipient?.chat_type === "string" ? msg.recipient.chat_type : null,
        };
        if (messageChatCache.size >= MESSAGE_CHAT_CACHE_MAX) {
            messageChatCache.delete(messageChatCache.keys().next().value);
        }
        messageChatCache.set(messageId, info);
    }
    if (info.chatType === "dialog")
        return;
    if (info.chatType === "chat" || info.chatType === "channel") {
        // A known group/channel: apply the policy even if the id sign convention
        // were to break (positive id) — the explicit type wins.
        if (info.chatId == null) {
            throw new Error(`${action}: message ${messageId} is in a ${info.chatType} without a resolvable chat id; refusing to run (fail-closed)`);
        }
        const admission = groupChatAdmission(cfg, info.chatId);
        if (!admission.admitted) {
            throw new Error(`${action}: chat ${info.chatId} is not admitted by the channels.max group policy (${admission.reason})`);
        }
        return;
    }
    // chat_type unavailable — conservative fallback: unclassifiable messages are
    // refused; otherwise the id-sign convention classifies (positive = dialog).
    if (info.chatId == null) {
        throw new Error(`${action}: message ${messageId} has no resolvable chat; refusing to run (fail-closed)`);
    }
    assertChatIdAdmitted(cfg, info.chatId, action);
}
/** Placeholder target so edit/delete (messageId-only) still route to MAX. */
const MESSAGE_ACTION_PLACEHOLDER = "__message_action__";
const SUPPORTED_ACTIONS = ["edit", "delete", "pin", "unpin", "sticker", "sendAttachment"];
function maxConfigured(cfg) {
    const account = resolveAccount(cfg, undefined);
    return account.enabled && Boolean(account.token);
}
/** Strip the routing prefix from a target ("max:123" → "123"). */
function stripTargetPrefix(value) {
    if (!value)
        return value;
    return value.startsWith(`${MAX_CHANNEL_ID}:`) ? value.slice(MAX_CHANNEL_ID.length + 1) : value;
}
/**
 * Resolve the sticker code to send: explicit code → last sticker seen in the
 * target chat → last sticker seen anywhere. Echo-only: without a code in
 * sight there is nothing to send (there is no sticker catalog to search).
 */
function resolveStickerCode(rawStickerId, fallbackChat) {
    const id = Array.isArray(rawStickerId)
        ? String(rawStickerId[0] ?? "").trim()
        : typeof rawStickerId === "string"
            ? rawStickerId.trim()
            : "";
    if (id)
        return id;
    const last = getLastStickerCode(fallbackChat) ?? getLastStickerCode();
    return last ?? undefined;
}
/** "55.75, 37.62" / "55.75 37.62" / explicit latitude+longitude params. */
function parseLocation(params) {
    const latParam = params.latitude != null ? Number(params.latitude) : NaN;
    const lngParam = params.longitude != null ? Number(params.longitude) : NaN;
    if (Number.isFinite(latParam) && Number.isFinite(lngParam)) {
        return { latitude: latParam, longitude: lngParam };
    }
    const locationStr = readStringParam(params, "location");
    if (!locationStr)
        return null;
    const m = locationStr.match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/);
    if (!m)
        return null;
    const latitude = parseFloat(m[1]);
    const longitude = parseFloat(m[2]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
        return null;
    return { latitude, longitude };
}
/** Chat-level actions (pin/unpin) need a numeric chat id, not a user: target. */
function resolveChatId(rawTo, action) {
    const t = normalizeMaxTarget(rawTo);
    if (/^user:/i.test(t)) {
        throw new Error(`${action}: pass the chat id (user:<id> targets are not chats)`);
    }
    const chatId = Number(t);
    if (!Number.isFinite(chatId)) {
        throw new Error(`${action}: invalid chat target "${rawTo}"`);
    }
    return chatId;
}
export const maxMessageActions = {
    describeMessageTool: ({ cfg }) => {
        if (!maxConfigured(cfg))
            return null;
        return {
            actions: [...SUPPORTED_ACTIONS],
            // "presentation" adds the portable `presentation` param (buttons blocks)
            // to the message tool send schema; outbound.renderPresentation maps it
            // onto a MAX inline keyboard.
            capabilities: ["presentation"],
        };
    },
    supportsAction: ({ action }) => SUPPORTED_ACTIONS.includes(action),
    // Without this hook the core DROPS channelData/interactive on the message
    // tool send path: executeSendAction (message-action-runner) only keeps the
    // built payload when the plugin prepared it, or when it carries a
    // `presentation` the channel can render. A channelData-only send
    // (maxInlineKeyboard!) fell through to a plain text-only core send and the
    // keyboard silently vanished. Passing the payload through marks it
    // "prepared", so the core delivers it as-is — and payloads with channelData
    // route to our outbound.sendPayload, which attaches the keyboard.
    prepareSendPayload: ({ payload }) => payload,
    // edit/delete are addressed by messageId, not a chat target; declare the
    // alias so the runner accepts them without a `target` param.
    messageActionTargetAliases: {
        edit: { aliases: ["messageId"] },
        delete: { aliases: ["messageId"] },
    },
    extractToolSend: ({ args }) => {
        let to = typeof args.target === "string" ? args.target : undefined;
        if (!to) {
            // edit/delete carry messageId instead of a destination — placeholder
            // keeps routing on this plugin.
            to = typeof args.messageId === "string" ? MESSAGE_ACTION_PLACEHOLDER : undefined;
        }
        if (!to)
            return null;
        to = stripTargetPrefix(to);
        const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
        return { to, accountId };
    },
    handleAction: async ({ action, params, cfg, accountId }) => {
        const account = resolveAccount(cfg, accountId ?? undefined);
        if (!account.token) {
            throw new Error("MAX bot token not configured");
        }
        const bot = ensureBotForOutbound(cfg);
        if (action === "edit") {
            const messageId = readStringParam(params, "messageId", { required: true });
            const text = readStringParam(params, "message", { required: true, allowEmpty: true });
            await assertMessageActionAdmitted(cfg, bot, messageId, action);
            try {
                await bot.api.editMessage(messageId, { text, format: "markdown" });
            }
            catch (err) {
                throw new Error(`MAX edit failed for ${messageId}: ${err?.message ?? err} ` +
                    `(edit limits: 7 days in dialogs; no time limit with an inline keyboard ` +
                    `or in groups/channels; at most 2 edits/sec per chat)`);
            }
            return jsonResult({ ok: true, messageId });
        }
        if (action === "delete") {
            const messageId = readStringParam(params, "messageId", { required: true });
            await assertMessageActionAdmitted(cfg, bot, messageId, action);
            try {
                await bot.api.deleteMessage(messageId);
            }
            catch (err) {
                throw new Error(`MAX delete failed for ${messageId}: ${err?.message ?? err} ` +
                    `(delete has no time limit for the bot's own messages; ` +
                    `at most 2 deletes/sec per chat)`);
            }
            return jsonResult({ ok: true, messageId });
        }
        if (action === "pin" || action === "unpin") {
            const to = stripTargetPrefix(readStringParam(params, "to") ?? readStringParam(params, "target", { required: true }));
            const chatId = resolveChatId(to, action);
            assertChatIdAdmitted(cfg, chatId, action);
            if (action === "pin") {
                const messageId = readStringParam(params, "messageId", { required: true });
                // notify defaults to server behavior (members get notified); pass only
                // when the caller asked explicitly. Accept boolean or "true"/"false".
                const rawNotify = params.notify;
                const extra = rawNotify === undefined || rawNotify === null
                    ? undefined
                    : { notify: rawNotify === true || rawNotify === "true" };
                try {
                    await bot.api.pinMessage(chatId, messageId, extra);
                }
                catch (err) {
                    throw new Error(`MAX pin failed in ${to}: ${err?.message ?? err} ` +
                        `(the bot needs permission to pin messages in this chat)`);
                }
                return jsonResult({ ok: true, to, messageId });
            }
            try {
                // DELETE /chats/{id}/pin unpins the currently pinned message.
                await bot.api.unpinMessage(chatId);
            }
            catch (err) {
                throw new Error(`MAX unpin failed in ${to}: ${err?.message ?? err} ` +
                    `(the bot needs permission to pin messages in this chat)`);
            }
            return jsonResult({ ok: true, to });
        }
        if (action === "sticker") {
            const to = stripTargetPrefix(readStringParam(params, "to") ?? readStringParam(params, "target", { required: true }));
            const replyTo = readStringParam(params, "replyTo");
            const stickerCode = resolveStickerCode(params.stickerId, normalizeMaxTarget(to));
            assertActionTargetAdmitted(cfg, to, action);
            if (!stickerCode) {
                throw new Error("stickerId is required: pass a sticker code, or receive a sticker in this " +
                    "chat first (only stickers the bot has seen can be resent)");
            }
            const messageId = await sendMaxBody(bot, to, {
                attachments: [{ type: "sticker", payload: { code: stickerCode } }],
                ...(replyTo ? { link: { type: "reply", mid: replyTo } } : {}),
            });
            return jsonResult({ ok: true, to, stickerCode, messageId });
        }
        if (action === "sendAttachment") {
            const to = stripTargetPrefix(readStringParam(params, "to") ?? readStringParam(params, "target", { required: true }));
            const replyTo = readStringParam(params, "replyTo");
            const caption = readStringParam(params, "message") ?? readStringParam(params, "caption") ?? "";
            const attachType = readStringParam(params, "type") ?? readStringParam(params, "attachmentType") ?? "";
            assertActionTargetAdmitted(cfg, to, action);
            // Native location pin (coordinates are top-level, not in payload)
            const location = parseLocation(params);
            if (attachType === "location" || location) {
                if (!location) {
                    throw new Error("Invalid location: provide latitude/longitude or location='LAT,LNG'");
                }
                const messageId = await sendMaxBody(bot, to, {
                    text: caption || undefined,
                    attachments: [
                        { type: "location", latitude: location.latitude, longitude: location.longitude },
                    ],
                    ...(replyTo ? { link: { type: "reply", mid: replyTo } } : {}),
                });
                return jsonResult({ ok: true, to, latitude: location.latitude, longitude: location.longitude, messageId });
            }
            // Native contact card (snake_case payload): max_info for a MAX user id,
            // vcf_info (+ HMAC hash) for a VCard built from name + phone.
            const contactName = readStringParam(params, "contactName") ?? readStringParam(params, "name");
            if (attachType === "contact" || contactName) {
                const contactId = params.contactId != null ? Number(params.contactId) : NaN;
                const vcfPhone = readStringParam(params, "vcfPhone") ?? readStringParam(params, "phone");
                const payload = {};
                if (Number.isFinite(contactId)) {
                    payload.max_info = { user_id: contactId };
                }
                else {
                    const name = contactName ?? "Unknown";
                    // VCard with literal \n — MAX expects the raw vCard text in vcf_info
                    const vcfParts = ["BEGIN:VCARD", "VERSION:3.0", `FN:${name}`];
                    if (vcfPhone)
                        vcfParts.push(`TEL:${vcfPhone}`);
                    vcfParts.push("END:VCARD");
                    const vcf = vcfParts.join("\n");
                    payload.vcf_info = vcf;
                    payload.hash = createHmac("sha256", account.token).update(vcf).digest("hex");
                }
                const messageId = await sendMaxBody(bot, to, {
                    attachments: [{ type: "contact", payload }],
                    ...(replyTo ? { link: { type: "reply", mid: replyTo } } : {}),
                });
                return jsonResult({ ok: true, to, messageId });
            }
            throw new Error("sendAttachment: unknown type. Use type='location' or type='contact'");
        }
        throw new Error(`Action ${action} is not supported for provider max.`);
    },
};
//# sourceMappingURL=actions.js.map