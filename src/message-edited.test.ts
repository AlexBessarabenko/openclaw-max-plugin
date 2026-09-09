import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * message_edited inbound tests: edits flow through the normal pipeline with a
 * unique `<mid>_edited_<ts>` id and an [Edited] marker; the bot's own draft
 * edits (streaming) are dropped before they can loop the agent.
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

function makeApi() {
  const captured: { inboundArgs?: any; turn?: any; dispatch?: any } = {};
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

function editedUpdate(mid: string, opts: { senderIsBot?: boolean; senderId?: number; ts?: number } = {}) {
  return {
    update_type: "message_edited",
    message: {
      sender: { user_id: opts.senderId ?? 100200, name: "Egor", is_bot: opts.senderIsBot ?? false },
      recipient: { chat_id: 5050, chat_type: "dialog" },
      body: { mid, text: "исправленный текст" },
      timestamp: opts.ts ?? 1757195000,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("message_edited inbound", () => {
  it("runs the pipeline with a suffixed id and an [Edited] marker", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(api as any, editedUpdate("m-1", { ts: 1757195001 }), "tok");

    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);
    expect(captured.inboundArgs.raw).toMatchObject({
      messageId: "m-1_edited_1757195001",
      text: "[Edited]\nисправленный текст",
      chatId: "5050",
      senderId: "100200",
    });
  });

  it("two edits of the same message both pass (unique ids)", async () => {
    const { api } = makeApi();
    await handleUpdate(api as any, editedUpdate("m-2", { ts: 1757195002 }), "tok");
    await handleUpdate(api as any, editedUpdate("m-2", { ts: 1757195003 }), "tok");
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(2);
  });

  it("drops edits authored by a bot", async () => {
    const { api } = makeApi();
    await handleUpdate(api as any, editedUpdate("m-3", { senderIsBot: true }), "tok");
    expect(api.runtime.channel.inbound.run).not.toHaveBeenCalled();
  });

  it("drops edits of our own streaming draft even without the bot flag", async () => {
    const { api, captured } = makeApi();
    // A normal message → turn → streaming draft with mid "draft-1".
    await handleUpdate(
      api as any,
      {
        update_type: "message_created",
        message: {
          sender: { user_id: 100200, name: "Egor" },
          recipient: { chat_id: 5050, chat_type: "dialog" },
          body: { mid: "m-4", text: "вопрос" },
          timestamp: 1757190000,
        },
      },
      "tok",
    );
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "draft-1" } } });
    await captured.dispatch.replyOptions.onPartialReply({ text: "черновик" });
    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalled();

    // MAX echoes the draft edit back; even a non-bot sender must not loop it.
    await handleUpdate(
      api as any,
      editedUpdate("draft-1", { senderId: 555000, ts: 1757195010 }),
      "tok",
    );
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1); // only m-4
  });
});
