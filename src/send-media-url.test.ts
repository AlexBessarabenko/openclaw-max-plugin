import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMaxSendOptions, sendMaxMedia } from "../channel.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

/**
 * G4/G5 quick wins: remote image URLs are attached by link (no re-upload,
 * private/loopback hosts refused) and per-message send options
 * (notify / disable_link_preview) resolve from channelData over config.
 */

const fakeBot = {
  api: {
    sendMessageToChat: vi.fn(async () => ({ message: { body: { mid: "mid-1" } } })),
    sendMessageToUser: vi.fn(async () => ({ message: { body: { mid: "mid-2" } } })),
    raw: {
      uploads: {
        getUploadUrl: vi.fn(),
      },
    },
  },
};

function makeCfg(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { max: section } } as unknown as OpenClawConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveMaxSendOptions", () => {
  it("omits unset options (server defaults apply)", () => {
    expect(resolveMaxSendOptions(makeCfg({}))).toEqual({});
  });

  it("reads channel config defaults", () => {
    expect(resolveMaxSendOptions(makeCfg({ notify: false, disableLinkPreview: true }))).toEqual({
      notify: false,
      disable_link_preview: true,
    });
  });

  it("channelData overrides config, other channelData keys are ignored", () => {
    expect(
      resolveMaxSendOptions(makeCfg({ notify: false }), {
        maxNotify: true,
        maxDisableLinkPreview: true,
        maxInlineKeyboard: [["OK"]],
      }),
    ).toEqual({ notify: true, disable_link_preview: true });
  });

  it("non-boolean values are ignored", () => {
    expect(
      resolveMaxSendOptions(makeCfg({ notify: "no" }), { maxNotify: "false" }),
    ).toEqual({});
  });
});

describe("sendMaxMedia: image by URL", () => {
  it("attaches a remote image by URL without an upload round trip", async () => {
    const mid = await sendMaxMedia(fakeBot as any, {
      to: "5050",
      text: "смотри",
      mediaUrl: "https://cdn.example.com/pic/photo.png",
      extra: { notify: false },
    });

    expect(mid).toBe("mid-1");
    expect(fakeBot.api.raw.uploads.getUploadUrl).not.toHaveBeenCalled();
    expect(fakeBot.api.sendMessageToChat).toHaveBeenCalledWith(5050, "смотри", {
      notify: false,
      attachments: [{ type: "image", payload: { url: "https://cdn.example.com/pic/photo.png" } }],
    });
  });

  it("refuses private/loopback image hosts", async () => {
    await expect(
      sendMaxMedia(fakeBot as any, {
        to: "5050",
        mediaUrl: "http://127.0.0.1/internal.png",
      }),
    ).rejects.toThrow(/private or loopback host/);
    await expect(
      sendMaxMedia(fakeBot as any, {
        to: "5050",
        mediaUrl: "http://localhost/x.png",
      }),
    ).rejects.toThrow(/private or loopback host/);
    expect(fakeBot.api.sendMessageToChat).not.toHaveBeenCalled();
  });
});
