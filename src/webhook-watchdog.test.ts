import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Webhook watchdog: in webhook mode, re-checks /subscriptions on an interval
 * and re-creates our subscription (same url/secret/update_types as startup)
 * when MAX has dropped it; a present subscription or a polling account means
 * no writes. stop() disarms the interval.
 */

const fetchSpy = vi.hoisted(() => vi.fn());

vi.mock("../certs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../certs.js")>();
  return { ...actual, createMaxScopedFetch: () => fetchSpy as any };
});

import { startMaxWebhookWatchdog, type ResolvedAccount } from "../channel.js";

const account: ResolvedAccount = {
  accountId: "default",
  token: "test-token",
  enabled: true,
  configured: true,
  allowFrom: [],
  dmPolicy: undefined,
  webhookUrl: "https://gw.example.com/max/webhook",
  webhookSecret: "s3cret",
  apiBaseUrl: "https://platform-api2.max.ru",
  httpProxy: undefined,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startMaxWebhookWatchdog", () => {
  it("re-creates a missing subscription with the startup parameters", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    fetchSpy.mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      if (init?.method === "POST") return jsonResponse({ ok: true });
      return jsonResponse({ subscriptions: [{ url: "https://other.example.com/hook" }] });
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    const stop = startMaxWebhookWatchdog({ account, log, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    stop();

    const post = calls.find((c) => c.init?.method === "POST");
    expect(post).toBeDefined();
    expect(post!.url).toBe("https://platform-api2.max.ru/subscriptions");
    expect(JSON.parse(post!.init.body)).toEqual({
      url: "https://gw.example.com/max/webhook",
      update_types: ["message_created", "message_callback", "bot_started", "message_edited"],
      secret: "s3cret",
    });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/missing/));
  });

  it("does not write when our subscription is still present", async () => {
    fetchSpy.mockImplementation(async (_url: string, init: any) => {
      if (init?.method === "POST") throw new Error("must not POST");
      return jsonResponse({
        subscriptions: [{ url: "https://gw.example.com/max/webhook" }],
      });
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    const stop = startMaxWebhookWatchdog({ account, log, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2500);
    stop();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("survives check errors and retries on the next tick", async () => {
    let attempt = 0;
    fetchSpy.mockImplementation(async (_url: string, init: any) => {
      if (init?.method === "POST") return jsonResponse({ ok: true });
      attempt++;
      if (attempt === 1) return jsonResponse({}, 500);
      return jsonResponse({ subscriptions: [] });
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    const stop = startMaxWebhookWatchdog({ account, log, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    stop();

    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/watchdog check failed/));
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/re-subscribed/));
  });

  it("stop() disarms the interval", async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ subscriptions: [] }));
    const stop = startMaxWebhookWatchdog({ account, intervalMs: 1000 });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
