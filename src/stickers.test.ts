import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STICKER_CACHE_TTL_MS,
  getLastStickerCode,
  rememberStickerCode,
  resetStickerCacheForTest,
  stickerCacheSizeForTest,
} from "./stickers.js";

/**
 * Unit tests for the per-chat last-sticker cache (echo-only sticker support:
 * no catalog, the agent resends codes the bot has actually seen).
 */

beforeEach(() => {
  resetStickerCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("per-chat last-sticker cache", () => {
  it("stores and returns the last sticker per chat", () => {
    rememberStickerCode(5050, "2d03");
    expect(getLastStickerCode("5050")).toBe("2d03");
  });

  it("falls back to the freshest global entry for unknown chats", () => {
    rememberStickerCode(1111, "glob1");
    expect(getLastStickerCode("other-chat")).toBe("glob1");
    expect(getLastStickerCode()).toBe("glob1");
  });

  it("prefers the chat entry over the global one", () => {
    rememberStickerCode(1111, "old-global");
    rememberStickerCode(5050, "chat-code");
    expect(getLastStickerCode("5050")).toBe("chat-code");
    expect(getLastStickerCode(1111)).toBe("old-global");
  });

  it("expires entries after the TTL (fresh sticker replies only)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);

    rememberStickerCode(5050, "2d03");
    expect(getLastStickerCode("5050")).toBe("2d03");

    vi.advanceTimersByTime(STICKER_CACHE_TTL_MS + 1);
    expect(getLastStickerCode("5050")).toBeNull();
    expect(getLastStickerCode()).toBeNull(); // global entry expired too
  });

  it("expires chats independently: only entries older than the TTL drop", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);

    rememberStickerCode(1, "old-code");
    vi.advanceTimersByTime(STICKER_CACHE_TTL_MS / 2);
    rememberStickerCode(2, "new-code");

    vi.advanceTimersByTime(STICKER_CACHE_TTL_MS / 2 + 1);
    // chat 2 is only TTL/2+1ms old — still fresh on its own entry
    expect(getLastStickerCode(2)).toBe("new-code");
    // chat 1's own entry (TTL+1ms) expired; the lookup falls back to the
    // freshest global entry: chat entry ?? last seen anywhere
    expect(getLastStickerCode(1)).toBe("new-code");
    expect(getLastStickerCode()).toBe("new-code"); // global tracks the newest
  });

  it("evicts the oldest chats beyond the FIFO cap instead of growing forever", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);

    rememberStickerCode("chat-0", "c0");
    for (let i = 0; i < 1100; i++) {
      rememberStickerCode(`chat-${i}`, `code-${i}`);
      vi.advanceTimersByTime(1); // distinct timestamps, all fresh
    }
    // 1101 distinct chats were seen; the map is capped at MAX_CACHED_CHATS
    expect(stickerCacheSizeForTest()).toBe(1000);
    // kept boundary: chat-100..chat-1099 are resident with their own codes
    expect(getLastStickerCode("chat-100")).toBe("code-100");
    expect(getLastStickerCode("chat-1099")).toBe("code-1099");
    // evicted chats fall back to the fresh global entry
    expect(getLastStickerCode("chat-0")).toBe("code-1099");
  });
});
