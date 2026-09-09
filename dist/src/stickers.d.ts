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
/** Freshness window for "last sticker seen" entries. */
export declare const STICKER_CACHE_TTL_MS: number;
/** Test hook: number of chats currently cached (FIFO cap check). */
export declare function stickerCacheSizeForTest(): number;
/** Remember a sticker code received in a chat (inbound sticker seen). */
export declare function rememberStickerCode(chatId: string | number, code: string): void;
/** Last sticker code seen in a chat (or the last one seen anywhere), within the TTL. */
export declare function getLastStickerCode(chatId?: string | number): string | null;
/** Test hook: drop all cached sticker codes. */
export declare function resetStickerCacheForTest(): void;
//# sourceMappingURL=stickers.d.ts.map