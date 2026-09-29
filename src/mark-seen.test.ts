import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * mark_seen: fired exactly once per inbound message from the first typing
 * tick (channels.max.markSeen, default true). The typing keepalive repeats
 * typing_on but never mark_seen; user-target turns (message_callback without
 * a source message) have no chat to mark.
 */

const fakeBot = {
  api: {
    sendMessageToChat: vi.fn(),
    sendMessageToUser: vi.fn(),
    editMessage: vi.fn(),
    answerOnCallback: vi.fn(),
    sendAction: vi.fn(async () => {}),
  },
};

vi.mock("../channel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channel.js")>();
  return { ...actual, getBot: () => fakeBot as any };
});

import { handleUpdate } from "../index.js";

function makeApi(channelConfig: Record<string, unknown> = {}) {
  const captured: { dispatch?: any } = {};
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      config: { current: () => ({ channels: { max: { dmPolicy: "open", ...channelConfig } } }) },
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
            const turn = await args.adapter.resolveTurn();
            await turn.runDispatch();
          }),
          buildContext: (x: any) => ({ ...x }),
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (params: any) => {
            captured.dispatch = params;
            // Simulate the typing start + one keepalive tick (the SDK dedupes
            // starts while one is in flight, so let the first settle first).
            await params.dispatcherOptions.typingCallbacks.onReplyStart();
            await new Promise((resolve) => setTimeout(resolve, 10));
            await params.dispatcherOptions.typingCallbacks.onReplyStart();
            await params.dispatcherOptions.typingCallbacks.onCleanup?.();
            return {};
          }),
        },
      },
    },
  };
  return { api, captured };
}

let midSeq = 0;
function directMessage() {
  return {
    update_type: "message_created",
    message: {
      sender: { user_id: 100200, name: "Egor" },
      recipient: { chat_id: 5050, chat_type: "dialog" },
      body: { mid: `ms-${++midSeq}`, text: "привет" },
      timestamp: 1757190000,
    },
  };
}

function callbackWithoutMessage() {
  return {
    update_type: "message_callback",
    callback: {
      timestamp: 1757191000,
      callback_id: `cb-ms-${++midSeq}`,
      payload: "vote:yes",
      user: { user_id: 100200, name: "Egor" },
    },
  };
}

const actionsOf = (name: string) =>
  fakeBot.api.sendAction.mock.calls.filter((call) => call[1] === name).length;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mark_seen", () => {
  it("is sent once per message, typing_on repeats with the keepalive", async () => {
    const { api } = makeApi();
    await handleUpdate(api as any, directMessage(), "tok");
    expect(actionsOf("mark_seen")).toBe(1);
    expect(actionsOf("typing_on")).toBe(2);
    expect(fakeBot.api.sendAction.mock.calls[0]).toEqual([5050, "mark_seen"]);
  });

  it("is skipped when channels.max.markSeen is false", async () => {
    const { api } = makeApi({ markSeen: false });
    await handleUpdate(api as any, directMessage(), "tok");
    expect(actionsOf("mark_seen")).toBe(0);
    expect(actionsOf("typing_on")).toBe(2);
  });

  it("is not sent on the user-target path (no chat to mark)", async () => {
    const { api } = makeApi();
    await handleUpdate(api as any, callbackWithoutMessage(), "tok");
    expect(fakeBot.api.sendAction).not.toHaveBeenCalled();
  });
});
