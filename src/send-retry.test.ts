import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Retry-on-attachment.not.ready tests: only the SEND is retried (never the
 * upload), only for that specific error, only when attachments ride along,
 * capped at 6 attempts with a growing pause.
 */

import { sendMaxMessage } from "../channel.js";

function makeBot(impl: () => Promise<any>) {
  return {
    api: {
      sendMessageToChat: vi.fn(impl),
      sendMessageToUser: vi.fn(impl),
    },
  } as any;
}

const notReady = () => Object.assign(new Error("attachment.not.ready"), { code: "attachment.not.ready" });
const ATTACHMENTS = { attachments: [{ type: "file", payload: { token: "t" } }] };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function runWithTimers(promise: Promise<any>) {
  // Attach expectations first, then flush all retry sleeps.
  const settled = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(60_000);
  return settled;
}

describe("sendMaxMessage attachment.not.ready retry", () => {
  it("retries the send until the attachment is ready", async () => {
    let attempt = 0;
    const bot = makeBot(async () => {
      attempt++;
      if (attempt < 3) throw notReady();
      return { message: { body: { mid: "m-1" } } };
    });

    const result = await runWithTimers(sendMaxMessage(bot, "5050", "file", ATTACHMENTS));
    expect(result).toEqual({ value: { message: { body: { mid: "m-1" } } } });
    expect(bot.api.sendMessageToChat).toHaveBeenCalledTimes(3);
  });

  it("does not retry other errors", async () => {
    const bot = makeBot(async () => {
      throw new Error("HTTP 403: forbidden");
    });
    const result = await runWithTimers(sendMaxMessage(bot, "5050", "file", ATTACHMENTS));
    expect(result.error?.message).toMatch(/403/);
    expect(bot.api.sendMessageToChat).toHaveBeenCalledTimes(1);
  });

  it("does not retry text-only sends even on attachment.not.ready", async () => {
    const bot = makeBot(async () => {
      throw notReady();
    });
    const result = await runWithTimers(sendMaxMessage(bot, "5050", "plain text"));
    expect(result.error?.message).toMatch(/attachment\.not\.ready/);
    expect(bot.api.sendMessageToChat).toHaveBeenCalledTimes(1);
  });

  it("gives up after 6 attempts", async () => {
    const bot = makeBot(async () => {
      throw notReady();
    });
    const result = await runWithTimers(sendMaxMessage(bot, "5050", "file", ATTACHMENTS));
    expect(result.error?.message).toMatch(/attachment\.not\.ready/);
    expect(bot.api.sendMessageToChat).toHaveBeenCalledTimes(6);
  });
});
