import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for the message_callback → inbound pipeline. The MAX API
 * client (`getBot`) is mocked; the OpenClaw runtime (`api.runtime.channel`) is
 * mocked just enough to drive index.ts wiring end to end without network or
 * gateway.
 *
 * Note: inbound dedup (`seenMessages`) is module-global with a 5-minute TTL,
 * so every test uses a fresh callback_id.
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
            // The real runtime invokes the returned dispatch — so do we.
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

function messageCallbackUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_type: "message_callback",
    callback: {
      timestamp: 1757190000,
      callback_id: "cb-777",
      payload: "vote:yes",
      user: { user_id: 100200, name: "Egor", is_bot: false },
    },
    message: {
      recipient: { chat_id: 5050, chat_type: "dialog" },
      body: { mid: "m-1", text: "Голосуем?" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("message_callback → inbound", () => {
  it("synthesizes an inbound message from the callback payload", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(api as any, messageCallbackUpdate(), "tok");

    // Callback acknowledged immediately (spinner on the button stops).
    expect(fakeBot.api.answerOnCallback).toHaveBeenCalledTimes(1);
    expect(fakeBot.api.answerOnCallback).toHaveBeenCalledWith("cb-777", { message: null });

    // Inbound facts: text = payload + quote of the source message, routing
    // from user + message recipient.
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);
    expect(captured.inboundArgs.raw).toMatchObject({
      messageId: "callback:cb-777",
      text: 'vote:yes\n[Button on: "Голосуем?"]',
      senderId: "100200",
      chatId: "5050",
      isGroup: false,
    });

    const ctx = captured.turn.ctxPayload;
    expect(ctx.from).toBe("max:100200");
    expect(ctx.reply.to).toBe("max:5050");
    expect(ctx.message.body).toBe('vote:yes\n[Button on: "Голосуем?"]');
    expect(ctx.sender).toMatchObject({ id: "100200", name: "Egor" });
  });

  it("quotes only the first 200 chars of the source message", async () => {
    const { api, captured } = makeApi();
    const longText = `  ${"длинный текст ".repeat(30)}\nс переносами `;
    await handleUpdate(
      api as any,
      messageCallbackUpdate({
        callback: {
          timestamp: 1757190002,
          callback_id: "cb-long",
          payload: "menu:pick",
          user: { user_id: 100200, name: "Egor" },
        },
        message: { recipient: { chat_id: 5050, chat_type: "dialog" }, body: { mid: "m-3", text: longText } },
      }),
      "tok",
    );
    const text: string = captured.inboundArgs.raw.text;
    expect(text.startsWith('menu:pick\n[Button on: "')).toBe(true);
    // whitespace collapsed, clipped to 199 chars + ellipsis, closing quote
    expect(text).toMatch(/\u2026"\]$/);
    expect(text).not.toContain("\nс переносами");
    expect(text.length).toBeLessThanOrEqual('menu:pick\n[Button on: "'.length + 200 + '"]'.length);
  });

  it("without a source message replies via the user target (no 404 chat send)", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(
      api as any,
      messageCallbackUpdate({
        callback: {
          timestamp: 1757190003,
          callback_id: "cb-nomsg",
          payload: "vote:no",
          user: { user_id: 100200, name: "Egor" },
        },
        message: undefined,
      }),
      "tok",
    );

    // No quote available; reply target overridden to the explicit user target.
    expect(captured.inboundArgs.raw).toMatchObject({
      text: "vote:no",
      chatId: "100200",
      replyTarget: "max:user:100200",
    });
    expect(captured.turn.ctxPayload.reply.to).toBe("max:user:100200");

    // The deliver path must send via sendMessageToUser, not chat_id = user_id.
    await captured.dispatch.dispatcherOptions.deliver({ text: "Принято" });
    expect(fakeBot.api.sendMessageToUser).toHaveBeenCalledWith(100200, "Принято", {
      format: "markdown",
    });
    expect(fakeBot.api.sendMessageToChat).not.toHaveBeenCalled();
  });

  it("ignores callbacks without payload and dedups by callback_id", async () => {
    const { api } = makeApi();
    await handleUpdate(
      api as any,
      messageCallbackUpdate({ callback: { callback_id: "cb-empty", user: { user_id: 1 } } }),
      "tok",
    );
    expect(api.runtime.channel.inbound.run).not.toHaveBeenCalled();

    const dedup = messageCallbackUpdate({
      callback: { ...messageCallbackUpdate().callback, callback_id: "cb-dedup" },
    });
    await handleUpdate(api as any, dedup, "tok");
    await handleUpdate(api as any, dedup, "tok");
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("routes group-chat callbacks as group conversations", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(
      api as any,
      messageCallbackUpdate({
        callback: {
          timestamp: 1757190001,
          callback_id: "cb-888",
          payload: "menu:open",
          user: { user_id: 100200, name: "Egor" },
        },
        message: { recipient: { chat_id: -900100, chat_type: "chat" }, body: { mid: "m-2" } },
      }),
      "tok",
    );
    expect(captured.inboundArgs.raw).toMatchObject({ chatId: "-900100", isGroup: true });
    expect(captured.turn.ctxPayload.conversation.kind).toBe("group");
  });
});
