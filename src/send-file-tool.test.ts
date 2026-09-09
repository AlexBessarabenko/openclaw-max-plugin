import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tests for the max_send_file agent tool: chat binding from the call context
 * (never global state), media-roots confinement for local paths, and the
 * happy path through the plugin's upload + send pipeline with a mocked bot.
 */

const fakeBot = {
  api: {
    sendMessageToChat: vi.fn(async () => ({ message: { body: { mid: "m-9" } } })),
    sendMessageToUser: vi.fn(async () => ({ message: { body: { mid: "m-9u" } } })),
    raw: {
      uploads: {
        getUploadUrl: vi.fn(async () => ({ url: "https://uploads.example/put-here", token: "tok-1" })),
      },
    },
  },
};

vi.mock("../channel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channel.js")>();
  return { ...actual, getBot: () => fakeBot as any };
});

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "max-tool-roots-"));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  getAgentScopedMediaLocalRoots: () => [tmpRoot],
}));

import { createMaxSendFileTool } from "./send-file-tool.js";

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  // rawUploadMaxMedia posts through the scoped fetch → global fetch for
  // non-MAX hosts; stub the upload endpoint.
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ token: "tok-1" }), { status: 200 }),
  ) as any;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("max_send_file", () => {
  it("sends a local file from the media roots to the current chat", async () => {
    const file = path.join(tmpRoot, "отчёт.pdf");
    fs.writeFileSync(file, "pdf-bytes");

    const tool = createMaxSendFileTool({
      config: {},
      deliveryContext: { channel: "max", to: "5050", accountId: "default" },
    });
    const result = (await tool.execute("call-1", { path: file, caption: "держи" })) as any;

    expect(result.details).toMatchObject({
      ok: true,
      filename: "отчёт.pdf",
      fileSize: 9,
      uploadType: "file",
      to: "5050",
      messageId: "m-9",
    });
    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledWith(5050, "держи", {
      attachments: [{ type: "file", payload: { token: "tok-1" } }],
    });
  });

  it("refuses a local path outside the media roots", async () => {
    const tool = createMaxSendFileTool({
      config: {},
      deliveryContext: { channel: "max", to: "5050" },
    });
    const result = (await tool.execute("call-2", { path: "/etc/hostname" })) as any;

    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("send_failed");
    expect(result.content[0].text).toMatch(/outside the media roots/);
    expect(fakeBot.api.sendMessageToChat).not.toHaveBeenCalled();
  });

  it("fails explicitly when there is no current MAX chat context", async () => {
    const file = path.join(tmpRoot, "note.txt");
    fs.writeFileSync(file, "hi");
    const tool = createMaxSendFileTool({ config: {} });
    const result = (await tool.execute("call-3", { path: file })) as any;

    expect(result.details).toMatchObject({ ok: false, reason: "no_chat_context" });
    expect(result.content[0].text).toMatch(/no current MAX chat/);
    expect(fakeBot.api.sendMessageToChat).not.toHaveBeenCalled();
  });

  it("requires exactly one of path or url", async () => {
    const tool = createMaxSendFileTool({
      config: {},
      deliveryContext: { channel: "max", to: "5050" },
    });
    const none = (await tool.execute("call-4", {})) as any;
    expect(none.details.reason).toBe("missing_source");
    const both = (await tool.execute("call-5", { path: "/a", url: "https://x.ru/a" })) as any;
    expect(both.details.reason).toBe("ambiguous_source");
  });
});
