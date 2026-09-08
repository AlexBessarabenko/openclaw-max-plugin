import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Persistent polling marker tests (at-least-once): the marker + dedup snapshot
 * land on disk only AFTER the whole batch is processed; a failed batch is not
 * persisted; a restart resumes from the persisted marker and the persisted
 * dedup ids absorb the replay. The state dir is redirected to a tmp dir.
 */

let stateDir: string;

vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: () => stateDir,
}));

import { runPollingLoop } from "../channel.js";
import { isDuplicate, primeSeenMessageIds, clearSeenMessageIds } from "../src/dedup.js";

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function makeBot(batches: Array<{ updates: any[]; marker: number }>) {
  const calls: Array<{ marker?: number }> = [];
  let callIdx = 0;
  const controller = new AbortController();
  const bot = {
    api: {
      getUpdates: vi.fn(async (_types: unknown, extra: { marker?: number }) => {
        calls.push({ marker: extra?.marker });
        const batch = batches[callIdx++];
        if (!batch) {
          controller.abort();
          throw abortError();
        }
        return batch;
      }),
    },
  };
  return { bot, calls, controller };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-poller-"));
  clearSeenMessageIds();
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("runPollingLoop persistent marker", () => {
  it("persists marker + seen ids only after the batch is processed", async () => {
    const { bot, calls, controller } = makeBot([
      { updates: [{ update_type: "message_created", body: { mid: "m-1" } }], marker: 42 },
    ]);
    const seenAtHandle: boolean[] = [];
    const handler = vi.fn(async () => {
      isDuplicate("m-1");
      // While the batch is still processing, nothing may be persisted yet.
      seenAtHandle.push(fs.existsSync(path.join(stateDir, "max", "polling-default.json")));
    });

    await runPollingLoop({ bot: bot as any, accountId: "default", token: "t", handler, signal: controller.signal, log });

    expect(seenAtHandle).toEqual([false]); // persist happened after the handler
    const state = JSON.parse(
      fs.readFileSync(path.join(stateDir, "max", "polling-default.json"), "utf8"),
    );
    expect(state.marker).toBe(42);
    expect(state.seenMessageIds).toContain("m-1");
    expect(calls[1].marker).toBe(42); // in-memory marker advanced too
  });

  it("does not persist when a batch update failed (replay after restart)", async () => {
    const { bot, calls, controller } = makeBot([
      {
        updates: [
          { update_type: "message_created", body: { mid: "m-ok" } },
          { update_type: "message_created", body: { mid: "m-bad" } },
        ],
        marker: 77,
      },
    ]);
    const handler = vi.fn(async (update: any) => {
      if (update.body.mid === "m-bad") throw new Error("boom");
    });

    await runPollingLoop({ bot: bot as any, accountId: "default", token: "t", handler, signal: controller.signal, log });

    // Not persisted, but the in-memory marker advanced (no poison-message loop).
    expect(fs.existsSync(path.join(stateDir, "max", "polling-default.json"))).toBe(false);
    expect(calls[1].marker).toBe(77);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/polling update failed/));
  });

  it("resumes from the persisted marker and absorbs replays via primed dedup", async () => {
    fs.mkdirSync(path.join(stateDir, "max"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "max", "polling-default.json"),
      JSON.stringify({ marker: 900, seenMessageIds: ["m-old"] }),
    );

    const { bot, calls, controller } = makeBot([{ updates: [], marker: 901 }]);
    const handler = vi.fn(async () => {});
    await runPollingLoop({ bot: bot as any, accountId: "default", token: "t", handler, signal: controller.signal, log });

    expect(calls[0].marker).toBe(900); // resumed, not restarted from scratch
    expect(isDuplicate("m-old")).toBe(true); // replayed batch is a no-op
    const state = JSON.parse(
      fs.readFileSync(path.join(stateDir, "max", "polling-default.json"), "utf8"),
    );
    expect(state.marker).toBe(901);
  });

  it("starts fresh when no state file exists", async () => {
    const { bot, calls, controller } = makeBot([{ updates: [], marker: 5 }]);
    await runPollingLoop({ bot: bot as any, accountId: "default", token: "t", handler: vi.fn(async () => {}), signal: controller.signal, log });
    expect(calls[0].marker).toBeUndefined();
  });
});

describe("dedup priming", () => {
  it("primed ids are duplicates, fresh ids are not", () => {
    primeSeenMessageIds(["a", "b"]);
    expect(isDuplicate("a")).toBe(true);
    expect(isDuplicate("c")).toBe(false);
    expect(isDuplicate("c")).toBe(true);
  });
});
