import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resetStickerCacheForTest, rememberStickerCode } from "./stickers.js";

/**
 * Tests for the plugin-owned message-tool actions adapter (edit / delete /
 * pin / unpin / sticker / sendAttachment). The MAX API client is mocked at the
 * channel boundary (`ensureBotForOutbound` → fakeBot); `sendMaxBody` stays
 * real so the wire serialization itself is what gets asserted. No network.
 */

const fakeBot = {
  api: {
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    pinMessage: vi.fn(),
    unpinMessage: vi.fn(),
    // edit/delete chat resolution (GET /messages/{mid})
    getMessage: vi.fn(),
    raw: {
      messages: {
        // sendMaxBody send path (stickers, locations, contacts)
        send: vi.fn(async (body: Record<string, unknown>) => ({
          message: { body: { mid: "mid-out-1" } },
        })),
      },
    },
  },
};

vi.mock("../channel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channel.js")>();
  return { ...actual, ensureBotForOutbound: () => fakeBot as any };
});

import { maxMessageActions, resetActionChatCachesForTest } from "./actions.js";

function makeCfg(token?: string, sectionExtra?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: { max: token ? { token, ...sectionExtra } : { ...sectionExtra } },
  } as unknown as OpenClawConfig;
}

const CTX = { cfg: makeCfg("test-token"), accountId: undefined };

beforeEach(() => {
  vi.clearAllMocks();
  resetStickerCacheForTest();
  resetActionChatCachesForTest();
  // Default: messages resolve to a dialog (DM), which is always admitted.
  fakeBot.api.getMessage.mockResolvedValue({
    recipient: { chat_id: 5050, chat_type: "dialog" },
    body: { mid: "m-x" },
  });
});

describe("describeMessageTool", () => {
  it("lists channel actions only when the token is configured", () => {
    expect(maxMessageActions.describeMessageTool?.({ cfg: makeCfg("t") })).toEqual({
      actions: ["edit", "delete", "pin", "unpin", "sticker", "sendAttachment"],
      capabilities: ["presentation"],
    });
    expect(maxMessageActions.describeMessageTool?.({ cfg: makeCfg() })).toBeNull();
  });
});

describe("prepareSendPayload", () => {
  it("passes the payload through so the core keeps channelData on the tool send path", async () => {
    const payload = {
      text: "Выбери день:",
      channelData: { maxInlineKeyboard: [[{ text: "Пн", payload: "mon" }]] },
    };
    const result = await maxMessageActions.prepareSendPayload?.({
      payload,
    } as any);
    expect(result).toBe(payload);
  });
});

describe("supportsAction", () => {
  it("owns edit/delete/pin/unpin/sticker/sendAttachment and nothing else", () => {
    const supports = (action: string) =>
      maxMessageActions.supportsAction?.({ action } as any) ?? false;
    expect(supports("edit")).toBe(true);
    expect(supports("delete")).toBe(true);
    expect(supports("pin")).toBe(true);
    expect(supports("unpin")).toBe(true);
    expect(supports("sticker")).toBe(true);
    expect(supports("sendAttachment")).toBe(true);
    expect(supports("send")).toBe(false);
    expect(supports("react")).toBe(false);
  });
});

describe("extractToolSend", () => {
  it("strips the max: routing prefix from targets", () => {
    expect(
      maxMessageActions.extractToolSend?.({ args: { target: "max:5050" } } as any),
    ).toEqual({ to: "5050", accountId: undefined });
  });

  it("routes messageId-only actions through the placeholder target", () => {
    expect(
      maxMessageActions.extractToolSend?.({ args: { messageId: "m-1" } } as any),
    ).toMatchObject({ to: "__message_action__" });
  });

  it("returns null when there is neither target nor messageId", () => {
    expect(maxMessageActions.extractToolSend?.({ args: {} } as any)).toBeNull();
  });
});

describe("handleAction: edit", () => {
  it("edits a bot message as markdown and reports the messageId", async () => {
    fakeBot.api.editMessage.mockResolvedValueOnce({});
    const res = await maxMessageActions.handleAction!({
      action: "edit",
      params: { messageId: "m-1", message: "fixed text" },
      ...CTX,
    } as any);

    expect(fakeBot.api.editMessage).toHaveBeenCalledWith("m-1", {
      text: "fixed text",
      format: "markdown",
    });
    expect(res.details).toEqual({ ok: true, messageId: "m-1" });
  });

  it("surfaces the edit limits (7 days in dialogs) on API errors", async () => {
    fakeBot.api.editMessage.mockRejectedValueOnce(new Error("chat.modifyForbidden"));
    await expect(
      maxMessageActions.handleAction!({
        action: "edit",
        params: { messageId: "m-2", message: "x" },
        ...CTX,
      } as any),
    ).rejects.toThrow(/7 days in dialogs/);
  });
});

describe("handleAction: delete", () => {
  it("deletes a bot message and reports the messageId", async () => {
    fakeBot.api.deleteMessage.mockResolvedValueOnce({});
    const res = await maxMessageActions.handleAction!({
      action: "delete",
      params: { messageId: "m-3" },
      ...CTX,
    } as any);

    expect(fakeBot.api.deleteMessage).toHaveBeenCalledWith("m-3");
    expect(res.details).toEqual({ ok: true, messageId: "m-3" });
  });

  it("states that delete has no time limit on API errors", async () => {
    fakeBot.api.deleteMessage.mockRejectedValueOnce(new Error("boom"));
    await expect(
      maxMessageActions.handleAction!({
        action: "delete",
        params: { messageId: "m-4" },
        ...CTX,
      } as any),
    ).rejects.toThrow(/MAX delete failed.*no time limit/s);
  });
});

describe("handleAction: pin/unpin", () => {
  it("pins a message in a chat, forwarding notify only when given", async () => {
    fakeBot.api.pinMessage.mockResolvedValue({});
    const res = await maxMessageActions.handleAction!({
      action: "pin",
      params: { target: "-900100", messageId: "m-5", notify: false },
      ...CTX,
    } as any);

    expect(fakeBot.api.pinMessage).toHaveBeenCalledWith(-900100, "m-5", { notify: false });
    expect(res.details).toEqual({ ok: true, to: "-900100", messageId: "m-5" });

    await maxMessageActions.handleAction!({
      action: "pin",
      params: { target: "max:5050", messageId: "m-6" },
      ...CTX,
    } as any);
    expect(fakeBot.api.pinMessage).toHaveBeenLastCalledWith(5050, "m-6", undefined);
  });

  it("unpins the currently pinned message in a chat", async () => {
    fakeBot.api.unpinMessage.mockResolvedValueOnce({});
    const res = await maxMessageActions.handleAction!({
      action: "unpin",
      params: { target: "-900100" },
      ...CTX,
    } as any);

    expect(fakeBot.api.unpinMessage).toHaveBeenCalledWith(-900100);
    expect(res.details).toEqual({ ok: true, to: "-900100" });
  });

  it("rejects user: targets and missing params with a clear error", async () => {
    await expect(
      maxMessageActions.handleAction!({
        action: "pin",
        params: { target: "user:777000", messageId: "m-7" },
        ...CTX,
      } as any),
    ).rejects.toThrow(/not chats/);
    await expect(
      maxMessageActions.handleAction!({
        action: "unpin",
        params: { target: "5050" },
        ...CTX,
      } as any),
    ).resolves.toBeDefined();
    expect(fakeBot.api.unpinMessage).toHaveBeenCalledWith(5050);
  });

  it("wraps API errors with a permissions hint", async () => {
    fakeBot.api.pinMessage.mockRejectedValueOnce(new Error("chat.accessForbidden"));
    await expect(
      maxMessageActions.handleAction!({
        action: "pin",
        params: { target: "5050", messageId: "m-8" },
        ...CTX,
      } as any),
    ).rejects.toThrow(/permission to pin/);
  });
});

describe("handleAction: sticker", () => {
  it("sends an explicit code as a sticker attachment without a text field", async () => {
    const res = await maxMessageActions.handleAction!({
      action: "sticker",
      params: { to: "max:5050", stickerId: "2d03" },
      ...CTX,
    } as any);

    expect(fakeBot.api.raw.messages.send).toHaveBeenCalledWith({
      chat_id: 5050,
      attachments: [{ type: "sticker", payload: { code: "2d03" } }],
    });
    const body = fakeBot.api.raw.messages.send.mock.calls[0][0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("text"); // MAX rejects sticker+empty text
    expect(res.details).toMatchObject({ ok: true, to: "5050", stickerCode: "2d03", messageId: "mid-out-1" });
  });

  it("falls back to the last sticker received in the chat", async () => {
    rememberStickerCode(5050, "9abc");
    await maxMessageActions.handleAction!({
      action: "sticker",
      params: { to: "5050" }, // no stickerId
      ...CTX,
    } as any);

    const body = fakeBot.api.raw.messages.send.mock.calls[0][0] as any;
    expect(body.attachments[0].payload.code).toBe("9abc");
  });

  it("requires a code when nothing was received", async () => {
    await expect(
      maxMessageActions.handleAction!({
        action: "sticker",
        params: { to: "5050" },
        ...CTX,
      } as any),
    ).rejects.toThrow(/stickerId is required/);
  });

  it("addresses user: targets through user_id and supports replyTo", async () => {
    await maxMessageActions.handleAction!({
      action: "sticker",
      params: { to: "user:777000", stickerId: "2d03", replyTo: "m-9" },
      ...CTX,
    } as any);

    expect(fakeBot.api.raw.messages.send).toHaveBeenCalledWith({
      user_id: 777000,
      attachments: [{ type: "sticker", payload: { code: "2d03" } }],
      link: { type: "reply", mid: "m-9" },
    });
  });
});

describe("handleAction: sendAttachment (location)", () => {
  it("sends a native location pin with top-level coordinates", async () => {
    const res = await maxMessageActions.handleAction!({
      action: "sendAttachment",
      params: { to: "5050", type: "location", latitude: "55.75", longitude: "37.62" },
      ...CTX,
    } as any);

    expect(fakeBot.api.raw.messages.send).toHaveBeenCalledWith({
      chat_id: 5050,
      attachments: [{ type: "location", latitude: 55.75, longitude: 37.62 }],
    });
    expect(res.details).toMatchObject({ ok: true, latitude: 55.75, longitude: 37.62 });
  });

  it("parses a 'LAT,LNG' location string and keeps the caption", async () => {
    await maxMessageActions.handleAction!({
      action: "sendAttachment",
      params: { to: "5050", location: "55.75, 37.62", message: "встречаемся тут" },
      ...CTX,
    } as any);

    expect(fakeBot.api.raw.messages.send).toHaveBeenCalledWith({
      chat_id: 5050,
      text: "встречаемся тут",
      attachments: [{ type: "location", latitude: 55.75, longitude: 37.62 }],
    });
  });

  it("rejects malformed coordinates", async () => {
    await expect(
      maxMessageActions.handleAction!({
        action: "sendAttachment",
        params: { to: "5050", type: "location" },
        ...CTX,
      } as any),
    ).rejects.toThrow(/Invalid location/);
  });
});

describe("handleAction: sendAttachment (contact)", () => {
  it("builds a VCard from contactName + vcfPhone (snake_case payload, HMAC hash)", async () => {
    await maxMessageActions.handleAction!({
      action: "sendAttachment",
      params: { to: "5050", type: "contact", contactName: "Катя", vcfPhone: "+79001234567" },
      ...CTX,
    } as any);

    const expectedVcf = "BEGIN:VCARD\nVERSION:3.0\nFN:Катя\nTEL:+79001234567\nEND:VCARD";
    const body = fakeBot.api.raw.messages.send.mock.calls[0][0] as any;
    expect(body.attachments[0].type).toBe("contact");
    expect(body.attachments[0].payload.vcf_info).toBe(expectedVcf);
    // hash = HMAC-SHA256(key = access token, data = vcf_info), hex
    expect(body.attachments[0].payload.hash).toBe(
      createHmac("sha256", "test-token").update(expectedVcf).digest("hex"),
    );
  });

  it("sends a MAX contact by user id via max_info", async () => {
    await maxMessageActions.handleAction!({
      action: "sendAttachment",
      params: { to: "5050", type: "contact", contactId: "777000" },
      ...CTX,
    } as any);

    const body = fakeBot.api.raw.messages.send.mock.calls[0][0] as any;
    expect(body.attachments[0].payload).toEqual({
      max_info: { user_id: 777000 },
    });
  });
});

describe("handleAction: unknown", () => {
  it("rejects actions outside the owned set", async () => {
    await expect(
      maxMessageActions.handleAction!({
        action: "sendPoll",
        params: {},
        ...CTX,
      } as any),
    ).rejects.toThrow(/not supported for provider max/);
  });
});

describe("handleAction: chat policy scoping", () => {
  const allowlistCfg = {
    cfg: makeCfg("test-token", {
      groupPolicy: "allowlist",
      groups: { "-900100": {} },
    }),
    accountId: undefined,
  };

  it("rejects pin in a group not admitted by the allowlist policy", async () => {
    await expect(
      maxMessageActions.handleAction!({
        action: "pin",
        params: { target: "-900200", messageId: "m-p1" },
        ...allowlistCfg,
      } as any),
    ).rejects.toThrow(/not admitted by the channels\.max group policy/);
    expect(fakeBot.api.pinMessage).not.toHaveBeenCalled();
  });

  it("allows pin in a group listed in groups", async () => {
    fakeBot.api.pinMessage.mockResolvedValueOnce({});
    const res = await maxMessageActions.handleAction!({
      action: "pin",
      params: { target: "-900100", messageId: "m-p2" },
      ...allowlistCfg,
    } as any);

    expect(fakeBot.api.pinMessage).toHaveBeenCalledWith(-900100, "m-p2", undefined);
    expect(res.details).toEqual({ ok: true, to: "-900100", messageId: "m-p2" });
  });

  it("allows group actions under groupPolicy=open without any chat-type API call", async () => {
    fakeBot.api.pinMessage.mockResolvedValueOnce({});
    await maxMessageActions.handleAction!({
      action: "pin",
      params: { target: "-900200", messageId: "m-p3" },
      ...CTX, // default cfg: no groupPolicy → open
    } as any);

    expect(fakeBot.api.pinMessage).toHaveBeenCalledWith(-900200, "m-p3", undefined);
    // explicit chat targets are classified by id sign — no getChat/getMessage
    expect(fakeBot.api.getMessage).not.toHaveBeenCalled();
  });

  it("allows edit when the message resolves to a dialog", async () => {
    fakeBot.api.editMessage.mockResolvedValueOnce({});
    await maxMessageActions.handleAction!({
      action: "edit",
      params: { messageId: "m-e1", message: "fixed" },
      ...allowlistCfg,
    } as any);

    expect(fakeBot.api.getMessage).toHaveBeenCalledWith("m-e1");
    expect(fakeBot.api.editMessage).toHaveBeenCalledWith("m-e1", {
      text: "fixed",
      format: "markdown",
    });
  });

  it("rejects edit when the message resolves to a group outside the policy", async () => {
    fakeBot.api.getMessage.mockResolvedValueOnce({
      recipient: { chat_id: -900200, chat_type: "chat" },
      body: { mid: "m-e2" },
    });
    await expect(
      maxMessageActions.handleAction!({
        action: "edit",
        params: { messageId: "m-e2", message: "x" },
        ...allowlistCfg,
      } as any),
    ).rejects.toThrow(/not admitted by the channels\.max group policy/);
    expect(fakeBot.api.editMessage).not.toHaveBeenCalled();
  });

  it("caches mid → chat resolution (second edit without another getMessage)", async () => {
    fakeBot.api.editMessage.mockResolvedValue({});
    await maxMessageActions.handleAction!({
      action: "edit",
      params: { messageId: "m-c1", message: "one" },
      ...CTX,
    } as any);
    await maxMessageActions.handleAction!({
      action: "edit",
      params: { messageId: "m-c1", message: "two" },
      ...CTX,
    } as any);

    expect(fakeBot.api.getMessage).toHaveBeenCalledTimes(1);
    expect(fakeBot.api.editMessage).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the message chat cannot be resolved", async () => {
    fakeBot.api.getMessage.mockRejectedValueOnce(new Error("network down"));
    await expect(
      maxMessageActions.handleAction!({
        action: "delete",
        params: { messageId: "m-x1" },
        ...CTX,
      } as any),
    ).rejects.toThrow(/fail-closed/);
    expect(fakeBot.api.deleteMessage).not.toHaveBeenCalled();
  });

  it("rejects sticker and sendAttachment in a group outside the policy", async () => {
    await expect(
      maxMessageActions.handleAction!({
        action: "sticker",
        params: { target: "-900200", stickerId: "code1" },
        ...allowlistCfg,
      } as any),
    ).rejects.toThrow(/not admitted by the channels\.max group policy/);

    await expect(
      maxMessageActions.handleAction!({
        action: "sendAttachment",
        params: { target: "-900200", type: "location", latitude: "55.75", longitude: "37.62" },
        ...allowlistCfg,
      } as any),
    ).rejects.toThrow(/not admitted by the channels\.max group policy/);

    expect(fakeBot.api.raw.messages.send).not.toHaveBeenCalled();
  });

  it("rejects every group when groupPolicy=disabled", async () => {
    await expect(
      maxMessageActions.handleAction!({
        action: "unpin",
        params: { target: "-900100" },
        cfg: makeCfg("test-token", { groupPolicy: "disabled", groups: { "-900100": {} } }),
        accountId: undefined,
      } as any),
    ).rejects.toThrow(/not admitted.*groupPolicy=disabled/);
    expect(fakeBot.api.unpinMessage).not.toHaveBeenCalled();
  });
});
