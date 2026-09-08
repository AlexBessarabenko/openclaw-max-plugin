import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Access-gate ordering tests: the DM policy decision runs BEFORE any
 * attachment download, session record, or last-route write. A blocked sender
 * must cause zero fetches and zero inbound dispatches.
 *
 * Same mocking approach as callback-inbound.test.ts; additionally the SSRF
 * guard is a pass-through and the scoped fetch is a spy, so every download
 * attempt is observable without network.
 */

const fetchSpy = vi.fn(async () => new Response("bytes", { status: 200 }));

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
  return { ...actual, getBot: () => fakeBot as any, getMaxFetch: () => fetchSpy as any };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(async ({ url, fetchImpl, init }: any) => {
    const response = await fetchImpl(url, init);
    return { response, finalUrl: url, release: async () => {} };
  }),
}));

import { handleUpdate } from "../index.js";

function makeApi(channelConfig: Record<string, unknown>) {
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      config: { current: () => ({ channels: { max: channelConfig } }) },
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
            const turn = await args.adapter.resolveTurn();
            await turn.runDispatch();
          }),
          buildContext: (x: any) => ({ ...x }),
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => ({})),
        },
      },
    },
  };
  return api;
}

function messageWithAttachment(mid: string, senderId: number) {
  return {
    update_type: "message_created",
    message: {
      sender: { user_id: senderId, name: "Stranger" },
      recipient: { chat_id: 5050, chat_type: "dialog" },
      body: { mid, text: "смотри" },
      attachments: [{ type: "image", payload: { url: "https://cdn.max.ru/pic.jpg" } }],
      timestamp: 1757190000,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("inbound access gate", () => {
  it("blocked sender: no download, no dispatch, no session write", async () => {
    const api = makeApi({ dmPolicy: "allowlist", allowFrom: [] });
    await handleUpdate(api as any, messageWithAttachment("m-blocked", 999999), "tok");

    expect(api.runtime.channel.inbound.run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(api.runtime.channel.session.recordInboundSession).not.toHaveBeenCalled();
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringMatching(/dropped by dmPolicy/));
  });

  it("allowlisted sender: attachment is downloaded and the turn runs", async () => {
    const api = makeApi({ dmPolicy: "allowlist", allowFrom: ["999999"] });
    await handleUpdate(api as any, messageWithAttachment("m-allowed", 999999), "tok");

    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://cdn.max.ru/pic.jpg",
      expect.objectContaining({ headers: { Authorization: "Bearer tok" } }),
    );
  });

  it("closed policy drops even allowlisted-config-absent senders before any fetch", async () => {
    const api = makeApi({ dmPolicy: "closed" });
    await handleUpdate(api as any, messageWithAttachment("m-closed", 100200), "tok");

    expect(api.runtime.channel.inbound.run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
