import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for per-message send options on the reply path:
 * channelData.maxNotify / maxDisableLinkPreview (and the channel config
 * defaults channels.max.notify / disableLinkPreview) ride on the final reply.
 * Same mocking approach as keyboard-delivery.test.ts: no network, no gateway.
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

type Captured = {
  inboundArgs?: any;
  turn?: any;
  dispatch?: any;
};

function makeApi(maxSection: Record<string, unknown> = {}): { api: any; captured: Captured } {
  const captured: Captured = {};
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      config: { current: () => ({ channels: { max: { dmPolicy: "open", ...maxSection } } }) },
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

function messageCreatedUpdate(mid: string) {
  return {
    update_type: "message_created",
    message: {
      sender: { user_id: 100200, name: "Egor" },
      recipient: { chat_id: 5050, chat_type: "dialog" },
      body: { mid, text: "привет" },
      timestamp: 1757190000,
    },
  };
}

async function setupDispatchedTurn(
  mid: string,
  maxSection: Record<string, unknown> = {},
): Promise<{ api: any; captured: Captured }> {
  const { api, captured } = makeApi(maxSection);
  await handleUpdate(api as any, messageCreatedUpdate(mid), "tok");
  expect(captured.dispatch).toBeDefined();
  return { api, captured };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deliver with per-message send options", () => {
  it("sends without options by default", async () => {
    const { captured } = await setupDispatchedTurn("m-so-1");
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "n-1" } } });

    await captured.dispatch.dispatcherOptions.deliver({ text: "Готово" });

    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledWith(
      5050,
      "Готово",
      expect.not.objectContaining({ notify: expect.anything(), disable_link_preview: expect.anything() }),
    );
  });

  it("forwards channelData.maxNotify=false and maxDisableLinkPreview=true", async () => {
    const { captured } = await setupDispatchedTurn("m-so-2");
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "n-2" } } });

    await captured.dispatch.dispatcherOptions.deliver({
      text: "тихо",
      channelData: { maxNotify: false, maxDisableLinkPreview: true },
    });

    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledWith(
      5050,
      "тихо",
      expect.objectContaining({ notify: false, disable_link_preview: true }),
    );
  });

  it("applies channel config defaults when channelData is absent", async () => {
    const { captured } = await setupDispatchedTurn("m-so-3", {
      notify: false,
      disableLinkPreview: true,
    });
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "n-3" } } });

    await captured.dispatch.dispatcherOptions.deliver({ text: "по умолчанию" });

    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledWith(
      5050,
      "по умолчанию",
      expect.objectContaining({ notify: false, disable_link_preview: true }),
    );
  });

  it("channelData overrides the channel config default", async () => {
    const { captured } = await setupDispatchedTurn("m-so-4", { notify: false });
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "n-4" } } });

    await captured.dispatch.dispatcherOptions.deliver({
      text: "громко",
      channelData: { maxNotify: true },
    });

    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledWith(
      5050,
      "громко",
      expect.objectContaining({ notify: true }),
    );
  });
});
