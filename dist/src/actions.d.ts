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
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
export declare function resetActionChatCachesForTest(): void;
export declare const maxMessageActions: ChannelMessageActionAdapter;
//# sourceMappingURL=actions.d.ts.map