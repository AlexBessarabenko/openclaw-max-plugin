import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Inbound audio: a server-side `transcription` field wins over the gateway
 * STT pipeline (transcribeSavedAudio is not called, media is marked
 * transcribed); without it the message falls back to download + STT.
 */

const fetchSpy = vi.fn(async () => new Response("bytes", { status: 200 }));
const saveMediaBufferSpy = vi.fn(async () => ({
  path: "/media/inbound/voice.ogg",
  contentType: "audio/ogg",
}));
const transcribeAudioFileSpy = vi.fn(async () => ({ text: "расшифровка от stt" }));

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

function makeApi() {
  const captured: { ctxPayload?: any } = {};
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      config: { current: () => ({ channels: { max: { dmPolicy: "open" } } }) },
      mediaUnderstanding: { transcribeAudioFile: transcribeAudioFileSpy },
      channel: {
        media: { saveMediaBuffer: saveMediaBufferSpy },
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
            captured.ctxPayload = turn.ctxPayload;
          }),
          buildContext: (x: any) => ({ ...x }),
        },
        reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => ({})) },
      },
    },
  };
  return { api, captured };
}

let midSeq = 0;
function voiceMessage(attachment: Record<string, unknown>) {
  return {
    update_type: "message_created",
    message: {
      sender: { user_id: 100200, name: "Egor" },
      recipient: { chat_id: 5050, chat_type: "dialog" },
      body: { mid: `v-${++midSeq}`, text: "" },
      attachments: [attachment],
      timestamp: 1757190000,
    },
  };
}

const AUDIO_URL = "https://cdn.max.ru/voice.ogg";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("audio transcription-first", () => {
  it("uses the server transcription and skips gateway STT", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(
      api as any,
      voiceMessage({
        type: "audio",
        payload: { url: AUDIO_URL, contentType: "audio/ogg" },
        transcription: "  привет от max  ",
      }),
      "tok",
    );
    expect(captured.ctxPayload.message.body).toBe("[Voice]: привет от max");
    expect(transcribeAudioFileSpy).not.toHaveBeenCalled();
    expect(captured.ctxPayload.media).toEqual([
      {
        path: "/media/inbound/voice.ogg",
        url: "/media/inbound/voice.ogg",
        contentType: "audio/ogg",
        kind: "audio",
        transcribed: true,
      },
    ]);
  });

  it("falls back to gateway STT when MAX sends no transcription", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(
      api as any,
      voiceMessage({ type: "audio", payload: { url: AUDIO_URL, contentType: "audio/ogg" } }),
      "tok",
    );
    expect(transcribeAudioFileSpy).toHaveBeenCalledTimes(1);
    expect(captured.ctxPayload.message.body).toBe("[Voice]: расшифровка от stt");
    expect(captured.ctxPayload.media?.[0]?.transcribed).toBe(true);
  });

  it("treats a blank transcription as absent (STT fallback)", async () => {
    const { api, captured } = makeApi();
    await handleUpdate(
      api as any,
      voiceMessage({
        type: "audio",
        payload: { url: AUDIO_URL },
        transcription: "   ",
      }),
      "tok",
    );
    expect(transcribeAudioFileSpy).toHaveBeenCalledTimes(1);
    expect(captured.ctxPayload.message.body).toBe("[Voice]: расшифровка от stt");
  });
});
