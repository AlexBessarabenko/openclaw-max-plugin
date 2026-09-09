import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Inbound video token→URL resolution: token-only video attachments are
 * resolved via getVideoInfo (best mp4, hls fallback) and then downloaded
 * through the guarded path; urls === null or a resolve error keeps the plain
 * marker and never breaks the message.
 */

const fetchSpy = vi.fn(async () => new Response("bytes", { status: 200 }));

const fakeBot = {
  api: {
    sendMessageToChat: vi.fn(),
    sendMessageToUser: vi.fn(),
    editMessage: vi.fn(),
    answerOnCallback: vi.fn(),
    sendAction: vi.fn(),
    getVideoInfo: vi.fn(),
  },
};

vi.mock("../channel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channel.js")>();
  return { ...actual, getBot: () => fakeBot as any, getMaxFetch: () => fetchSpy as any };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(async ({ url, fetchImpl, init }: any) => {
    const response = await fetchImpl(url, init);
    return { response, finalUrl: url, release: async () => {} };
  }),
}));

import { handleUpdate } from "../index.js";

function makeApi() {
  const captured: { inboundArgs?: any } = {};
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
        session: { resolveStorePath: () => "/store/agent", recordInboundSession: vi.fn() },
        pairing: { readAllowFromStore: vi.fn(async () => []) },
        inbound: {
          run: vi.fn(async (args: any) => {
            captured.inboundArgs = args;
            const turn = await args.adapter.resolveTurn();
            await turn.runDispatch();
          }),
          buildContext: (x: any) => ({ ...x }),
        },
        reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => ({})) },
      },
    },
  };
  return { api, captured };
}

function videoMessage(mid: string, payload: Record<string, unknown>) {
  return {
    update_type: "message_created",
    message: {
      sender: { user_id: 100200, name: "Egor" },
      recipient: { chat_id: 5050, chat_type: "dialog" },
      body: { mid, text: "видео" },
      attachments: [{ type: "video", payload }],
      timestamp: 1757190000,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("video token → playback URL", () => {
  it("resolves the best mp4 and downloads it through the guarded path", async () => {
    fakeBot.api.getVideoInfo.mockResolvedValue({
      token: "vtok",
      urls: { mp4_720: "https://cdn.max.ru/v720.mp4", mp4_144: "https://cdn.max.ru/v144.mp4" },
    });
    const { api } = makeApi();
    await handleUpdate(api as any, videoMessage("m-v1", { token: "vtok" }), "tok");

    expect(fakeBot.api.getVideoInfo).toHaveBeenCalledWith("vtok");
    expect(fetchSpy).toHaveBeenCalledWith("https://cdn.max.ru/v720.mp4", expect.anything());
  });

  it("falls back to hls when no mp4 is available", async () => {
    fakeBot.api.getVideoInfo.mockResolvedValue({
      token: "vtok2",
      urls: { hls: "https://cdn.max.ru/v.m3u8" },
    });
    const { api } = makeApi();
    await handleUpdate(api as any, videoMessage("m-v2", { token: "vtok2" }), "tok");
    expect(fetchSpy).toHaveBeenCalledWith("https://cdn.max.ru/v.m3u8", expect.anything());
  });

  it("urls === null: no download, message text survives", async () => {
    fakeBot.api.getVideoInfo.mockResolvedValue({ token: "vtok3", urls: null });
    const { api, captured } = makeApi();
    await handleUpdate(api as any, videoMessage("m-v3", { token: "vtok3" }), "tok");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);
    expect(captured.inboundArgs.raw.text).toBe("видео");
  });

  it("getVideoInfo failure: warn + plain marker, no crash", async () => {
    fakeBot.api.getVideoInfo.mockRejectedValue(new Error("HTTP 404"));
    const { api } = makeApi();
    await handleUpdate(api as any, videoMessage("m-v4", { token: "vtok4" }), "tok");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/getVideoInfo failed/));
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });
});
