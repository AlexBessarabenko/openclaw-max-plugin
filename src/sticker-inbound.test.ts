import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for inbound native attachments: stickers (per-chat cache
 * + code marker), locations (Yandex Maps link) and contacts (name marker)
 * are folded into the agent-visible text. Same mocking approach as
 * callback-inbound.test.ts: no network, no gateway.
 *
 * Note: inbound dedup (`seenMessages`) is module-global with a TTL, so every
 * test uses a fresh mid.
 */

const fakeBot = {
  api: {
    sendMessageToChat: vi.fn(),
    sendMessageToUser: vi.fn(),
    editMessage: vi.fn(),
    answerOnCallback: vi.fn(),
    sendAction: vi.fn(),
  },
};

vi.mock("../channel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channel.js")>();
  return { ...actual, getBot: () => fakeBot as any };
});

import { handleUpdate } from "../index.js";
import { getLastStickerCode, resetStickerCacheForTest } from "./stickers.js";

type Captured = {
  inboundArgs?: any;
  turn?: any;
  dispatch?: any;
};

function makeApi(): { api: any; captured: Captured } {
  const captured: Captured = {};
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      config: { current: () => ({ channels: { max: { dmPolicy: "open" } } }) },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            sessionKey: "route-s",
            agentId: "agent",
            accountId: "default",
            matchedBy: "binding",
            mainSessionKey: "main",
          }),
          buildAgentSessionKey: () => "built-s",
        },
        session: {
          resolveStorePath: () => "/store/agent",
          recordInboundSession: vi.fn(),
        },
        pairing: {
          readAllowFromStore: vi.fn(async () => []),
        },
        inbound: {
          run: vi.fn(async (args: any) => {
            captured.inboundArgs = args;
            captured.turn = await args.adapter.resolveTurn();
            await captured.turn.runDispatch();
          }),
          buildContext: (x: any) => ({ ...x }),
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (params: any) => {
            captured.dispatch = params;
            return {};
          }),
        },
      },
    },
  };
  return { api, captured };
}

function messageWithAttachments(mid: string, attachments: any[], text = "") {
  return {
    update_type: "message_created",
    message: {
      timestamp: 1757190000,
      sender: { user_id: 100200, name: "Egor", is_bot: false },
      recipient: { chat_id: 5050, chat_type: "dialog" },
      body: { mid, text },
      attachments,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStickerCacheForTest();
});

describe("inbound sticker", () => {
  it("caches the code per chat and surfaces it as a text marker", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(
      api as any,
      messageWithAttachments("m-st-1", [{ type: "sticker", payload: { code: "1091f2b5" } }]),
      "tok",
    );

    // Per-chat cache: the agent can resend it without knowing the code
    expect(getLastStickerCode("5050")).toBe("1091f2b5");

    // Agent-visible text: [Sticker (code <code>)] — the SDK sticker payload
    // carries no emoji, so the marker is code-only unless one is provided.
    const text = captured.turn.ctxPayload.message.body;
    expect(text).toBe("[Sticker (code 1091f2b5)]");
  });

  it("includes the emoji when the payload provides one", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(
      api as any,
      messageWithAttachments("m-st-2", [{ type: "sticker", payload: { code: "2d03", emoji: "😪" } }]),
      "tok",
    );
    expect(captured.turn.ctxPayload.message.body).toBe("[Sticker 😪 (code 2d03)]");
  });

  it("tracks the newest sticker per chat", async () => {
    const { api } = makeApi();
    await handleUpdate(
      api as any,
      messageWithAttachments("m-st-3", [{ type: "sticker", payload: { code: "1091f2b5" } }]),
      "tok",
    );
    await handleUpdate(
      api as any,
      messageWithAttachments("m-st-4", [{ type: "sticker", payload: { code: "2d03" } }]),
      "tok",
    );
    expect(getLastStickerCode("5050")).toBe("2d03");
  });
});

describe("inbound location", () => {
  it("renders coordinates as a Yandex Maps link", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(
      api as any,
      messageWithAttachments(
        "m-loc-1",
        [{ type: "location", latitude: 55.75, longitude: 37.62 }],
        "я тут",
      ),
      "tok",
    );

    const text = captured.turn.ctxPayload.message.body;
    expect(text).toContain("я тут");
    expect(text).toContain("[Location: 55.75, 37.62]");
    expect(text).toMatch(/https:\/\/yandex\.ru\/maps\/\?ll=37\.62%2C55\.75&z=15/);
  });
});

describe("inbound contact", () => {
  it("extracts the name from the VCard payload", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(
      api as any,
      messageWithAttachments("m-ct-1", [
        {
          type: "contact",
          payload: { vcf_info: "BEGIN:VCARD\nVERSION:3.0\nFN:Катя\nEND:VCARD" },
        },
      ]),
      "tok",
    );
    expect(captured.turn.ctxPayload.message.body).toBe("[Contact: Катя]");
  });

  it("falls back to the MAX profile name when there is no VCard", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(
      api as any,
      messageWithAttachments("m-ct-2", [
        {
          type: "contact",
          payload: { max_info: { user_id: 777000, first_name: "Иван", last_name: "Петров" } },
        },
      ]),
      "tok",
    );
    expect(captured.turn.ctxPayload.message.body).toBe("[Contact: Иван Петров]");
  });

  it("falls back to a bare marker when the payload is empty", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(
      api as any,
      messageWithAttachments("m-ct-3", [{ type: "contact", payload: {} }]),
      "tok",
    );
    expect(captured.turn.ctxPayload.message.body).toBe("[Contact]");
  });
});
