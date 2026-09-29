import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-chat send limiter: at most 2 message sends per second into one chat
 * (sliding window), FIFO order per chat, no throttling across different
 * chats. Integration: sendMaxMessage acquires a slot before hitting the API.
 */

import { MaxChatSendLimiter, resetMaxSendLimiterForTests } from "./send-limiter.js";
import { sendMaxMessage } from "../channel.js";

beforeEach(() => {
  vi.useFakeTimers();
  resetMaxSendLimiterForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MaxChatSendLimiter", () => {
  it("admits 2 sends per window and makes the 3rd wait", async () => {
    const limiter = new MaxChatSendLimiter();
    const order: string[] = [];
    const track = (label: string, p: Promise<void>) =>
      p.then(() => {
        order.push(label);
      });

    const first = track("a", limiter.acquire("chat:1"));
    const second = track("b", limiter.acquire("chat:1"));
    const third = track("c", limiter.acquire("chat:1"));

    await vi.advanceTimersByTimeAsync(0);
    await first;
    await second;
    expect(order).toEqual(["a", "b"]);

    // Still inside the 1s window: the third slot is pending.
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual(["a", "b"]);

    await vi.advanceTimersByTimeAsync(600);
    await third;
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("keeps FIFO order under a burst", async () => {
    const limiter = new MaxChatSendLimiter();
    const order: number[] = [];
    const waits = Array.from({ length: 6 }, (_, i) =>
      limiter.acquire("chat:1").then(() => {
        order.push(i);
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(waits);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("throttles chats independently", async () => {
    const limiter = new MaxChatSendLimiter();
    const done: string[] = [];
    const waits = [
      limiter.acquire("chat:1").then(() => done.push("1a")),
      limiter.acquire("chat:1").then(() => done.push("1b")),
      limiter.acquire("chat:2").then(() => done.push("2a")),
      limiter.acquire("chat:2").then(() => done.push("2b")),
      limiter.acquire("chat:1").then(() => done.push("1c")),
      limiter.acquire("chat:2").then(() => done.push("2c")),
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect(done.sort()).toEqual(["1a", "1b", "2a", "2b"]);
    await vi.advanceTimersByTimeAsync(1100);
    await Promise.all(waits);
    expect(done.sort()).toEqual(["1a", "1b", "1c", "2a", "2b", "2c"]);
  });
});

describe("sendMaxMessage rate limiting", () => {
  it("serializes chunk sends into one chat through the limiter", async () => {
    const sentAt: number[] = [];
    const bot = {
      api: {
        sendMessageToChat: vi.fn(async () => {
          sentAt.push(Date.now());
          return { message: { body: { mid: `m-${sentAt.length}` } } };
        }),
        sendMessageToUser: vi.fn(),
      },
    } as any;

    const sends = [0, 1, 2, 3].map((i) => sendMaxMessage(bot, "5050", `chunk ${i}`));
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(sends);

    expect(bot.api.sendMessageToChat).toHaveBeenCalledTimes(4);
    // 2 per 1s window: pairs leave together, later pairs wait.
    expect(sentAt[1] - sentAt[0]).toBeLessThan(1000);
    expect(sentAt[2] - sentAt[0]).toBeGreaterThanOrEqual(1000);
    expect(sentAt[3] - sentAt[2]).toBeLessThan(1000);
  });

  it("does not throttle sends into different chats", async () => {
    const bot = {
      api: {
        sendMessageToChat: vi.fn(async () => ({ message: { body: { mid: "m" } } })),
        sendMessageToUser: vi.fn(async () => ({ message: { body: { mid: "m" } } })),
      },
    } as any;

    const sends = [
      sendMaxMessage(bot, "5050", "a"),
      sendMaxMessage(bot, "6060", "b"),
      sendMaxMessage(bot, "user:70700", "c"),
    ];
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(sends);
    expect(bot.api.sendMessageToChat).toHaveBeenCalledTimes(2);
    expect(bot.api.sendMessageToUser).toHaveBeenCalledTimes(1);
  });
});
