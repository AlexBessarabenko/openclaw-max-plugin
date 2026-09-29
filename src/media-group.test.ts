import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outbound albums: images/videos group up to 12 per message, audio/files go
 * one per message. Caption rides on the first message; the result carries all
 * message ids.
 */

const uploadSpy = vi.hoisted(() => vi.fn(async () => new Response(JSON.stringify({ token: "up-token" }), { status: 200 })));

vi.mock("../certs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../certs.js")>();
  return { ...actual, createMaxScopedFetch: () => uploadSpy as any };
});

import { groupMaxMediaUrls, sendMaxMediaGroup, MAX_ALBUM_SIZE } from "../channel.js";
import { resetMaxSendLimiterForTests } from "./send-limiter.js";

let midSeq = 0;
const fakeBot = {
  api: {
    sendMessageToChat: vi.fn(async () => ({ message: { body: { mid: `m-${++midSeq}` } } })),
    sendMessageToUser: vi.fn(async () => ({ message: { body: { mid: `m-${++midSeq}` } } })),
    raw: {
      uploads: {
        getUploadUrl: vi.fn(async () => ({ url: "https://uploads.max.ru/x", token: "up-token" })),
      },
    },
  },
};

const readFile = vi.fn(async () => Buffer.from("bytes"));

beforeEach(() => {
  vi.clearAllMocks();
  resetMaxSendLimiterForTests();
});

describe("groupMaxMediaUrls", () => {
  it("groups images/videos, singles audio/files, keeps order", () => {
    expect(
      groupMaxMediaUrls(["/a/1.png", "/a/2.mp4", "/a/voice.ogg", "/a/3.jpg", "/a/doc.pdf"]),
    ).toEqual([["/a/1.png", "/a/2.mp4"], ["/a/voice.ogg"], ["/a/3.jpg"], ["/a/doc.pdf"]]);
  });

  it("splits albums at the 12-item limit", async () => {
    const urls = Array.from({ length: 13 }, (_, i) => `/a/${i}.png`);
    const groups = groupMaxMediaUrls(urls);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(MAX_ALBUM_SIZE);
    expect(groups[1]).toHaveLength(1);
  });
});

describe("sendMaxMediaGroup", () => {
  it("sends 3 photos as one message with 3 attachments", async () => {
    const messageIds = await sendMaxMediaGroup(fakeBot as any, {
      to: "5050",
      text: "альбом",
      mediaUrls: [
        "https://cdn.example.com/1.png",
        "https://cdn.example.com/2.jpg",
        "https://cdn.example.com/3.webp",
      ],
    });
    expect(messageIds).toHaveLength(1);
    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledTimes(1);
    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledWith(5050, "альбом", {
      attachments: [
        { type: "image", payload: { url: "https://cdn.example.com/1.png" } },
        { type: "image", payload: { url: "https://cdn.example.com/2.jpg" } },
        { type: "image", payload: { url: "https://cdn.example.com/3.webp" } },
      ],
    });
  });

  it("splits photo+audio into two messages (caption on the first)", async () => {
    const messageIds = await sendMaxMediaGroup(fakeBot as any, {
      to: "5050",
      text: "с подписью",
      mediaUrls: ["https://cdn.example.com/pic.png", "/media/voice.ogg"],
      mediaReadFile: readFile,
    });
    expect(messageIds).toHaveLength(2);
    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledTimes(2);
    const [first, second] = fakeBot.api.sendMessageToChat.mock.calls;
    expect(first[1]).toBe("с подписью");
    expect(first[2].attachments).toEqual([
      { type: "image", payload: { url: "https://cdn.example.com/pic.png" } },
    ]);
    expect(second[1]).toBe("");
    expect(second[2].attachments).toEqual([{ type: "audio", payload: { token: "up-token" } }]);
  });

  it("splits 13 photos into 12+1 messages", async () => {
    const mediaUrls = Array.from(
      { length: 13 },
      (_, i) => `https://cdn.example.com/${i}.png`,
    );
    const messageIds = await sendMaxMediaGroup(fakeBot as any, { to: "5050", mediaUrls });
    expect(messageIds).toHaveLength(2);
    const calls = fakeBot.api.sendMessageToChat.mock.calls;
    expect(calls[0][2].attachments).toHaveLength(12);
    expect(calls[1][2].attachments).toHaveLength(1);
  });
});
