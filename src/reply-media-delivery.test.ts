import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reply-path media delivery: payloads carrying mediaUrl/mediaUrls (TTS audio
 * from the media store, tool attachments) must be uploaded and sent — the text
 * path alone must not swallow them. Same mocking approach as
 * keyboard-delivery.test.ts; sendMaxMedia is stubbed (upload covered elsewhere).
 */

const fakeBot = {
  api: {
    sendMessageToChat: vi.fn(),
    sendMessageToUser: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    answerOnCallback: vi.fn(),
    sendAction: vi.fn(),
  },
};

const sendMaxMediaMock = vi.hoisted(() => vi.fn(async () => "media-mid-1"));

vi.mock("../channel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channel.js")>();
  return { ...actual, getBot: () => fakeBot as any, sendMaxMedia: sendMaxMediaMock };
});

import { handleUpdate } from "../index.js";

type Captured = {
  dispatch?: any;
};

function makeApi(extraCfg?: Record<string, unknown>): { api: any; captured: Captured } {
  const captured: Captured = {};
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      config: { current: () => ({ channels: { max: { dmPolicy: "open" } }, ...extraCfg }) },
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

function messageCreatedUpdate(mid: string, attachments?: any[]) {
  return {
    update_type: "message_created",
    message: {
      sender: { user_id: 100200, name: "Egor" },
      recipient: { chat_id: 5050, chat_type: "dialog" },
      body: { mid, text: "привет", ...(attachments ? { attachments } : {}) },
      timestamp: 1757190000,
    },
  };
}

async function setupDispatchedTurn(
  mid: string,
  extraCfg?: Record<string, unknown>,
  attachments?: any[],
): Promise<Captured> {
  const { api, captured } = makeApi(extraCfg);
  await handleUpdate(api as any, messageCreatedUpdate(mid, attachments), "tok");
  expect(captured.dispatch).toBeDefined();
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMaxMediaMock.mockResolvedValue("media-mid-1");
});

describe("inbound logging", () => {
  it("logs metadata only by default (no text preview)", async () => {
    const { api } = makeApi();
    await handleUpdate(api as any, messageCreatedUpdate("m-log1"), "tok");
    const line = api.logger.info.mock.calls.map((c) => String(c[0])).find((m) => m.includes("[MAX] inbound"));
    expect(line).toContain("chars=6");
    expect(line).not.toContain("привет");
  });

  it("logs a text preview when channels.max.logInboundPreview is true", async () => {
    const { api } = makeApi({ channels: { max: { dmPolicy: "open", logInboundPreview: true } } });
    await handleUpdate(api as any, messageCreatedUpdate("m-log2"), "tok");
    const line = api.logger.info.mock.calls.map((c) => String(c[0])).find((m) => m.includes("[MAX] inbound"));
    expect(line).toContain('preview="привет"');
  });
});

describe("deliver with media payloads", () => {
  it("sends voice (TTS) payloads as audio only — no text copy", async () => {
    const captured = await setupDispatchedTurn("m-md1");

    const result = await captured.dispatch.dispatcherOptions.deliver({
      text: "Голосовая справка отправлена!",
      mediaUrl: "/home/openclaw/.openclaw/media/tool-speech-synthesis/voice---x.mp3",
      audioAsVoice: true,
      trustedLocalMedia: true,
    });

    expect(fakeBot.api.sendMessageToChat).not.toHaveBeenCalled();
    expect(sendMaxMediaMock).toHaveBeenCalledTimes(1);
    expect(sendMaxMediaMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: "5050",
        text: "",
        mediaUrl: "/home/openclaw/.openclaw/media/tool-speech-synthesis/voice---x.mp3",
      }),
    );
    expect(result).toEqual({ messageIds: ["media-mid-1"] });
  });

  it("delivers media-only payloads (no text) instead of dropping them", async () => {
    const captured = await setupDispatchedTurn("m-md2");

    const result = await captured.dispatch.dispatcherOptions.deliver({
      mediaUrl: "/x/voice.mp3",
    });

    expect(fakeBot.api.sendMessageToChat).not.toHaveBeenCalled();
    expect(sendMaxMediaMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ messageIds: ["media-mid-1"] });
  });

  it("merges and dedupes mediaUrl + mediaUrls, sending each once", async () => {
    const captured = await setupDispatchedTurn("m-md3");
    sendMaxMediaMock.mockResolvedValueOnce("m-a").mockResolvedValueOnce("m-b");

    const result = await captured.dispatch.dispatcherOptions.deliver({
      mediaUrl: "/x/a.mp3",
      mediaUrls: [" /x/a.mp3 ", "/x/b.mp3"],
    });

    expect(sendMaxMediaMock).toHaveBeenCalledTimes(2);
    expect(sendMaxMediaMock.mock.calls.map((c) => c[1].mediaUrl)).toEqual(["/x/a.mp3", "/x/b.mp3"]);
    expect(result).toEqual({ messageIds: ["m-a", "m-b"] });
  });

  it("sends media after the final draft edit when streaming", async () => {
    const captured = await setupDispatchedTurn("m-md4");
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "draft-1" } } });

    await captured.dispatch.replyOptions.onPartialReply({ text: "Печатаю…" });
    const result = await captured.dispatch.dispatcherOptions.deliver({
      text: "Финал",
      mediaUrl: "/x/voice.mp3",
    });

    expect(fakeBot.api.editMessage).toHaveBeenCalledWith("draft-1", expect.objectContaining({ text: "Финал" }));
    expect(sendMaxMediaMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ messageIds: ["draft-1", "media-mid-1"] });
  });

  it("returns undefined for truly empty payloads", async () => {
    const captured = await setupDispatchedTurn("m-md5");
    const result = await captured.dispatch.dispatcherOptions.deliver({});
    expect(result).toBeUndefined();
    expect(sendMaxMediaMock).not.toHaveBeenCalled();
  });

  it("drops a second voice audio in the same turn (tool-TTS + auto-TTS)", async () => {
    const captured = await setupDispatchedTurn("m-md6");

    const first = await captured.dispatch.dispatcherOptions.deliver({
      text: "Вот голосовое",
      mediaUrl: "/x/voice-1.mp3",
      audioAsVoice: true,
    });
    const second = await captured.dispatch.dispatcherOptions.deliver({
      text: "Вот голосовое",
      mediaUrl: "/x/voice-2.mp3",
      audioAsVoice: true,
    });

    expect(first).toEqual({ messageIds: ["media-mid-1"] });
    expect(second).toBeUndefined();
    expect(sendMaxMediaMock).toHaveBeenCalledTimes(1);
    expect(sendMaxMediaMock.mock.calls[0][1].mediaUrl).toBe("/x/voice-1.mp3");
    expect(fakeBot.api.sendMessageToChat).not.toHaveBeenCalled();
  });

  it("keeps only the first audio in one voice payload, other media still sent", async () => {
    const captured = await setupDispatchedTurn("m-md7");
    sendMaxMediaMock.mockResolvedValueOnce("m-a").mockResolvedValueOnce("m-pic");

    const result = await captured.dispatch.dispatcherOptions.deliver({
      text: "Голос + картинка",
      mediaUrls: ["/x/voice-a.mp3", "/x/voice-b.mp3", "/x/pic.png"],
      spokenText: "Голос + картинка",
    });

    expect(sendMaxMediaMock).toHaveBeenCalledTimes(2);
    expect(sendMaxMediaMock.mock.calls.map((c) => c[1].mediaUrl)).toEqual(["/x/voice-a.mp3", "/x/pic.png"]);
    expect(fakeBot.api.sendMessageToChat).not.toHaveBeenCalled();
    expect(result).toEqual({ messageIds: ["m-a", "m-pic"] });
  });

  it("falls back to text when a voice payload has no audio (TTS failed)", async () => {
    const captured = await setupDispatchedTurn("m-md8");
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "text-1" } } });

    const result = await captured.dispatch.dispatcherOptions.deliver({
      text: "Текстовый фолбэк",
      audioAsVoice: true,
    });

    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledWith(
      5050,
      "Текстовый фолбэк",
      expect.objectContaining({ format: "markdown" }),
    );
    expect(sendMaxMediaMock).not.toHaveBeenCalled();
    expect(result).toEqual({ messageIds: ["text-1"] });
  });

  it("drops a voice payload's audio when unmarked audio already went out this turn", async () => {
    const captured = await setupDispatchedTurn("m-md10");

    // Tool-TTS media may arrive on a payload WITHOUT voice markers…
    const first = await captured.dispatch.dispatcherOptions.deliver({
      mediaUrl: "/x/tool-voice.mp3",
    });
    // …and the auto-TTS supplement then carries a second synthesis.
    const second = await captured.dispatch.dispatcherOptions.deliver({
      text: "Голосовой ответ отправлен: …",
      mediaUrl: "/x/auto-voice.mp3",
      audioAsVoice: true,
    });

    expect(first).toEqual({ messageIds: ["media-mid-1"] });
    expect(second).toBeUndefined();
    expect(sendMaxMediaMock).toHaveBeenCalledTimes(1);
    expect(sendMaxMediaMock.mock.calls[0][1].mediaUrl).toBe("/x/tool-voice.mp3");
    expect(fakeBot.api.sendMessageToChat).not.toHaveBeenCalled();
  });

  it("still sends non-audio media of later payloads after audio went out", async () => {
    const captured = await setupDispatchedTurn("m-md11");
    sendMaxMediaMock.mockResolvedValueOnce("m-a").mockResolvedValueOnce("m-pic");

    await captured.dispatch.dispatcherOptions.deliver({
      mediaUrl: "/x/voice.mp3",
      audioAsVoice: true,
    });
    const result = await captured.dispatch.dispatcherOptions.deliver({
      mediaUrl: "/x/pic.png",
    });

    expect(sendMaxMediaMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ messageIds: ["m-pic"] });
  });

  it("with tts.auto=inbound and voice inbound, no draft is created — voice only", async () => {
    const captured = await setupDispatchedTurn(
      "m-md12",
      { tts: { auto: "inbound" } },
      [{ type: "audio", payload: {} }],
    );

    // Streaming partials are suppressed for voice turns — no flicker.
    const partialUsed = await captured.dispatch.replyOptions.onPartialReply({ text: "Голосовое получено…" });
    expect(partialUsed).toBe(false);

    // Tool-TTS media on an unmarked payload that also carries narration text.
    const first = await captured.dispatch.dispatcherOptions.deliver({
      text: "Голосовой ответ отправлен",
      mediaUrl: "/x/tool-voice.mp3",
    });
    // The auto-TTS supplement afterwards is dropped entirely.
    const second = await captured.dispatch.dispatcherOptions.deliver({
      text: "Голосовой ответ отправлен",
      mediaUrl: "/x/auto-voice.mp3",
      audioAsVoice: true,
    });

    expect(fakeBot.api.sendMessageToChat).not.toHaveBeenCalled();
    expect(fakeBot.api.deleteMessage).not.toHaveBeenCalled();
    expect(sendMaxMediaMock).toHaveBeenCalledTimes(1);
    expect(sendMaxMediaMock.mock.calls[0][1].mediaUrl).toBe("/x/tool-voice.mp3");
    expect(first).toEqual({ messageIds: ["media-mid-1"] });
    expect(second).toBeUndefined();
  });

  it("with tts.auto off, audio+text payload keeps text and audio", async () => {
    const captured = await setupDispatchedTurn("m-md13", { messages: { tts: { auto: "off" } } });
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "text-1" } } });

    const result = await captured.dispatch.dispatcherOptions.deliver({
      text: "Держи песню",
      mediaUrl: "/x/song.mp3",
    });

    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledWith(
      5050,
      "Держи песню",
      expect.objectContaining({ format: "markdown" }),
    );
    expect(sendMaxMediaMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ messageIds: ["text-1", "media-mid-1"] });
  });

  it("deletes the streaming draft when the final reply is voice-only", async () => {
    const captured = await setupDispatchedTurn("m-md9");
    fakeBot.api.sendMessageToChat.mockResolvedValue({ message: { body: { mid: "draft-1" } } });

    await captured.dispatch.replyOptions.onPartialReply({ text: "Печатаю…" });
    const result = await captured.dispatch.dispatcherOptions.deliver({
      text: "Финал",
      mediaUrl: "/x/voice.mp3",
      audioAsVoice: true,
    });

    expect(fakeBot.api.deleteMessage).toHaveBeenCalledWith("draft-1");
    expect(fakeBot.api.editMessage).not.toHaveBeenCalled();
    expect(sendMaxMediaMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ messageIds: ["media-mid-1"] });
  });
});
