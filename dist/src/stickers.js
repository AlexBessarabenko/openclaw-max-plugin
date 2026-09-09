/**
 * Per-chat cache of sticker codes seen inbound.
 *
 * Stickers are echo-only: there is no bundled catalog, so the agent can send
 * a sticker only by an explicit code or by resending the last sticker seen in
 * the chat ("send it back"). Inbound handlers call `rememberStickerCode`;
 * the message-actions adapter reads `getLastStickerCode`.
 *
 * The Map is capped (FIFO eviction) so a long-lived gateway does not leak
 * memory across thousands of chats, and entries expire after
 * STICKER_CACHE_TTL_MS — silently resending a sticker the user sent hours ago
 * reads as a glitch, not a reply.
 */
const MAX_CACHED_CHATS = 1000;
/** Freshness window for "last sticker seen" entries. */
export const STICKER_CACHE_TTL_MS = 30 * 60 * 1000;
/** Test hook: number of chats currently cached (FIFO cap check). */
export function stickerCacheSizeForTest() {
    return lastStickerByChat.size;
}
const lastStickerByChat = new Map();
const lastStickerGlobal = { code: "", at: 0 };
/** Remember a sticker code received in a chat (inbound sticker seen). */
export function rememberStickerCode(chatId, code) {
    const key = String(chatId);
    const entry = { code, at: Date.now() };
    if (lastStickerByChat.has(key))
        lastStickerByChat.delete(key); // refresh LRU order
    lastStickerByChat.set(key, entry);
    while (lastStickerByChat.size > MAX_CACHED_CHATS) {
        const oldest = lastStickerByChat.keys().next().value;
        if (oldest === undefined)
            break;
        lastStickerByChat.delete(oldest);
    }
    lastStickerGlobal.code = code;
    lastStickerGlobal.at = entry.at;
}
function freshEntry(entry) {
    if (!entry?.code)
        return null;
    if (Date.now() - entry.at > STICKER_CACHE_TTL_MS)
        return null;
    return entry.code;
}
/** Last sticker code seen in a chat (or the last one seen anywhere), within the TTL. */
export function getLastStickerCode(chatId) {
    if (chatId != null) {
        const code = freshEntry(lastStickerByChat.get(String(chatId)));
        if (code)
            return code;
    }
    return freshEntry(lastStickerGlobal);
}
/** Test hook: drop all cached sticker codes. */
export function resetStickerCacheForTest() {
    lastStickerByChat.clear();
    lastStickerGlobal.code = "";
    lastStickerGlobal.at = 0;
}
//# sourceMappingURL=stickers.js.map