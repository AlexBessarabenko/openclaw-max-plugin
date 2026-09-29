/**
 * Per-chat send rate limiter: MAX accepts at most 2 messages per second into
 * one chat. Sliding 1s window with a FIFO promise queue per chat, so bursts
 * (chunked long replies, media follow-ups) leave serially instead of bouncing
 * off the platform limit. Only MESSAGE sends are throttled — sender actions
 * (typing_on/mark_seen), edits, deletes and callback answers are not messages.
 */
export declare const MAX_SENDS_PER_CHAT_PER_SECOND = 2;
export declare const SEND_WINDOW_MS = 1000;
export declare class MaxChatSendLimiter {
    private limit;
    private windowMs;
    private recent;
    private tails;
    constructor(limit?: number, windowMs?: number);
    acquire(key: string): Promise<void>;
    private prune;
}
/** Throttle one message send into the given chat (or `user:<id>` DM target). */
export declare function acquireChatSendSlot(key: string): Promise<void>;
/** @internal Fresh process-wide limiter (test isolation). */
export declare function resetMaxSendLimiterForTests(): void;
//# sourceMappingURL=send-limiter.d.ts.map