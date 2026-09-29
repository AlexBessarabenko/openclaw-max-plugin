/**
 * Per-chat send rate limiter: MAX accepts at most 2 messages per second into
 * one chat. Sliding 1s window with a FIFO promise queue per chat, so bursts
 * (chunked long replies, media follow-ups) leave serially instead of bouncing
 * off the platform limit. Only MESSAGE sends are throttled — sender actions
 * (typing_on/mark_seen), edits, deletes and callback answers are not messages.
 */
export const MAX_SENDS_PER_CHAT_PER_SECOND = 2;
export const SEND_WINDOW_MS = 1000;
export class MaxChatSendLimiter {
    limit;
    windowMs;
    recent = new Map();
    tails = new Map();
    constructor(limit = MAX_SENDS_PER_CHAT_PER_SECOND, windowMs = SEND_WINDOW_MS) {
        this.limit = limit;
        this.windowMs = windowMs;
    }
    acquire(key) {
        const take = async () => {
            for (;;) {
                const now = Date.now();
                const times = (this.recent.get(key) ?? []).filter((t) => now - t < this.windowMs);
                if (times.length < this.limit) {
                    times.push(now);
                    this.recent.set(key, times);
                    return;
                }
                this.recent.set(key, times);
                await new Promise((resolve) => setTimeout(resolve, times[0] + this.windowMs - now));
            }
        };
        const slot = (this.tails.get(key) ?? Promise.resolve()).then(take);
        this.tails.set(key, slot);
        void slot.finally(() => {
            if (this.tails.get(key) === slot)
                this.tails.delete(key);
        });
        if (this.recent.size > 1000)
            this.prune();
        return slot;
    }
    prune() {
        const now = Date.now();
        for (const [key, times] of this.recent) {
            if (!this.tails.has(key) && times.every((t) => now - t >= this.windowMs)) {
                this.recent.delete(key);
            }
        }
    }
}
let sharedSendLimiter = new MaxChatSendLimiter();
/** Throttle one message send into the given chat (or `user:<id>` DM target). */
export function acquireChatSendSlot(key) {
    return sharedSendLimiter.acquire(key);
}
/** @internal Fresh process-wide limiter (test isolation). */
export function resetMaxSendLimiterForTests() {
    sharedSendLimiter = new MaxChatSendLimiter();
}
//# sourceMappingURL=send-limiter.js.map