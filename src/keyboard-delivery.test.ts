import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for inline keyboard delivery on final replies: the
 * keyboard travels on the reply payload as opaque `channelData.maxInlineKeyboard`
 * (forwarded untouched by the core) and is attached only to the final
 * authoritative message — never to streaming draft edits.
 *
 * Same mocking approach as callback-inbound.test.ts: the MAX API client
 * (`getBot`) and the OpenClaw runtime are mocked; no network, no gateway.
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

/** A regular dialog message: enough inbound wiring to reach the reply deliverer. */
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

async function setupDispatchedTurn(mid: string): Promise<{ api: any; captured: Captured }> {
  const { api, captured } = makeApi();
  await handleUpdate(api as any, messageCreatedUpdate(mid), "tok");
  expect(captured.dispatch).toBeDefined();
  return { api, captured };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deliver with inline keyboard", () => {
  it("attaches the keyboard to the final message", async () => {
    const { captured } = await setupDispatchedTurn("m-k1");
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "new-1" } } });

    const result = await captured.dispatch.dispatcherOptions.deliver({
      text: "Готово",
      channelData: { maxInlineKeyboard: [["OK", { text: "Site", url: "https://max.ru" }]] },
    });

    expect(result).toEqual({ messageIds: ["new-1"] });
    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledWith(
      5050,
      "Готово",
      expect.objectContaining({
        attachments: [
          {
            type: "inline_keyboard",
            payload: {
              buttons: [
                [
                  { type: "callback", text: "OK", payload: "OK" },
                  { type: "link", text: "Site", url: "https://max.ru" },
                ],
              ],
            },
          },
        ],
      }),
    );
  });

  it("attaches the keyboard only to the last chunk of long replies", async () => {
    const { captured } = await setupDispatchedTurn("m-k2");
    fakeBot.api.sendMessageToChat.mockImplementation(async (_chat: number, text: string) => ({
      message: { body: { mid: `mid-${text.length}` } },
    }));

    const long = "x".repeat(4500);
    await captured.dispatch.dispatcherOptions.deliver({
      text: long,
      channelData: { maxInlineKeyboard: [["Ещё"]] },
    });

    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledTimes(2);
    const first = fakeBot.api.sendMessageToChat.mock.calls[0][2];
    const last = fakeBot.api.sendMessageToChat.mock.calls[1][2];
    expect(first.attachments).toBeUndefined();
    expect(last.attachments).toEqual([
      {
        type: "inline_keyboard",
        payload: { buttons: [[{ type: "callback", text: "Ещё", payload: "Ещё" }]] },
      },
    ]);
  });

  it("keeps the keyboard off streaming drafts and lands it on the final edit", async () => {
    const { captured } = await setupDispatchedTurn("m-k3");
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "draft-1" } } });

    await captured.dispatch.replyOptions.onPartialReply({ text: "Частичный ответ" });
    const draftCall = fakeBot.api.sendMessageToChat.mock.calls.at(-1)!;
    expect(draftCall[2]).toEqual({ format: "markdown" });

    await captured.dispatch.dispatcherOptions.deliver({
      text: "Финальный ответ",
      channelData: { maxInlineKeyboard: [["Готово"]] },
    });

    expect(fakeBot.api.editMessage).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({
        text: "Финальный ответ",
        attachments: [
          {
            type: "inline_keyboard",
            payload: { buttons: [[{ type: "callback", text: "Готово", payload: "Готово" }]] },
          },
        ],
      }),
    );
  });

  it("delivers text without a keyboard when channelData is invalid", async () => {
    const { api, captured } = await setupDispatchedTurn("m-k4");
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "plain-1" } } });

    const result = await captured.dispatch.dispatcherOptions.deliver({
      text: "Спокойно",
      channelData: { maxInlineKeyboard: [["a", "b", "c", "d", "e", "f", "g", "h"]] },
    });

    expect(result).toEqual({ messageIds: ["plain-1"] });
    const sendArgs = fakeBot.api.sendMessageToChat.mock.calls[0];
    expect(sendArgs[2]).toEqual({ format: "markdown" });
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/invalid inline keyboard/),
    );
  });

  it("maps portable presentation buttons onto the inline keyboard", async () => {
    const { captured } = await setupDispatchedTurn("m-k5");
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "pres-1" } } });

    await captured.dispatch.dispatcherOptions.deliver({
      text: "Выбирай",
      presentation: {
        blocks: [
          { type: "text", text: "Выбирай" },
          {
            type: "buttons",
            buttons: [
              { label: "Да", value: "yes" },
              { label: "Сайт", url: "https://max.ru" },
            ],
          },
        ],
      },
    });

    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledWith(
      5050,
      "Выбирай",
      expect.objectContaining({
        attachments: [
          {
            type: "inline_keyboard",
            payload: {
              buttons: [
                [
                  { type: "callback", text: "Да", payload: "yes" },
                  { type: "link", text: "Сайт", url: "https://max.ru" },
                ],
              ],
            },
          },
        ],
      }),
    );
  });

  it("maps legacy interactive buttons and lands them on the final draft edit", async () => {
    const { captured } = await setupDispatchedTurn("m-k6");
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "draft-6" } } });

    await captured.dispatch.replyOptions.onPartialReply({ text: "Черновик" });

    await captured.dispatch.dispatcherOptions.deliver({
      text: "Финал",
      interactive: {
        blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
      },
    });

    expect(fakeBot.api.editMessage).toHaveBeenCalledWith(
      "draft-6",
      expect.objectContaining({
        text: "Финал",
        attachments: [
          {
            type: "inline_keyboard",
            payload: { buttons: [[{ type: "callback", text: "OK", payload: "ok" }]] },
          },
        ],
      }),
    );
  });

  it("prefers channelData.maxInlineKeyboard over presentation buttons", async () => {
    const { captured } = await setupDispatchedTurn("m-k7");
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "both-1" } } });

    await captured.dispatch.dispatcherOptions.deliver({
      text: "Оба",
      channelData: { maxInlineKeyboard: [["Explicit"]] },
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "P", value: "p" }] }],
      },
    });

    const sendArgs = fakeBot.api.sendMessageToChat.mock.calls[0];
    expect(sendArgs[2].attachments).toEqual([
      {
        type: "inline_keyboard",
        payload: { buttons: [[{ type: "callback", text: "Explicit", payload: "Explicit" }]] },
      },
    ]);
  });
});
