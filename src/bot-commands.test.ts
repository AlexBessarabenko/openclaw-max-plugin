import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bot command menu registration (PATCH /me/commands): runs only when
 * channels.max.commands is set, validates entries against the schema limits
 * (≤32 commands, name 1..64, description ≤128) and never throws on validation
 * — API failures propagate to the caller, which logs a warning.
 */

const fetchSpy = vi.hoisted(() => vi.fn());

vi.mock("../certs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../certs.js")>();
  return { ...actual, createMaxScopedFetch: () => fetchSpy as any };
});

import { registerMaxBotCommands } from "../channel.js";

const BASE = { apiBaseUrl: "https://platform-api2.max.ru", token: "test-token" };

function okResponse(): Response {
  return new Response(JSON.stringify({ commands: [] }), { status: 200 });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy.mockImplementation(async () => okResponse());
});

describe("registerMaxBotCommands", () => {
  it("PATCHes the validated command list", async () => {
    const count = await registerMaxBotCommands({
      ...BASE,
      commands: [
        { name: "start", description: "Начать диалог" },
        { name: "help" },
      ],
    });
    expect(count).toBe(2);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://platform-api2.max.ru/me/commands");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      commands: [
        { name: "start", description: "Начать диалог" },
        { name: "help" },
      ],
    });
  });

  it("is a no-op for a non-array config", async () => {
    const count = await registerMaxBotCommands({ ...BASE, commands: "nope" });
    expect(count).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("drops invalid names and truncates long descriptions", async () => {
    const log = { warn: vi.fn() };
    const count = await registerMaxBotCommands({
      ...BASE,
      log,
      commands: [
        { name: "" },
        { name: "x".repeat(65) },
        { name: "ok", description: "d".repeat(200) },
        { description: "no name" },
      ],
    });
    expect(count).toBe(1);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      commands: [{ name: "ok", description: "d".repeat(128) }],
    });
    expect(log.warn).toHaveBeenCalled();
  });

  it("keeps at most 32 commands", async () => {
    const count = await registerMaxBotCommands({
      ...BASE,
      commands: Array.from({ length: 40 }, (_, i) => ({ name: `cmd${i}` })),
    });
    expect(count).toBe(32);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).commands).toHaveLength(32);
  });

  it("propagates API errors (the caller warns and continues)", async () => {
    fetchSpy.mockImplementation(async () => new Response("bad token", { status: 401 }));
    await expect(
      registerMaxBotCommands({ ...BASE, commands: [{ name: "start" }] }),
    ).rejects.toThrow(/HTTP 401/);
  });
});
