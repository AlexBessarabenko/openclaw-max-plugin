import { describe, expect, it, vi } from "vitest";
import { maskMaxToken, maxPlugin, sendMaxPairingApproval } from "../channel.js";

/**
 * G1/G2 quick wins: the pairing adapter notifies the approved user in MAX,
 * and config.inspectAccount reports diagnostics without leaking the token.
 */

const fakeBot = {
  api: {
    sendMessageToUser: vi.fn(),
  },
};

describe("pairing notifyApproval", () => {
  it("is a full adapter (no text shorthand) with notifyApproval wired", () => {
    const pairing = (maxPlugin as any).pairing;
    expect(pairing).toBeDefined();
    expect(pairing.text).toBeUndefined();
    expect(pairing.idLabel).toBe("MAX user ID");
    expect(typeof pairing.notifyApproval).toBe("function");
  });

  it("sends the approval notice to the MAX user id", async () => {
    await sendMaxPairingApproval(fakeBot as any, "100200");
    expect(fakeBot.api.sendMessageToUser).toHaveBeenCalledWith(
      100200,
      expect.stringContaining("✅ Доступ одобрен"),
      { format: "markdown" },
    );
  });

  it("strips a user: prefix from the pairing id", async () => {
    await sendMaxPairingApproval(fakeBot as any, "user:777000");
    expect(fakeBot.api.sendMessageToUser).toHaveBeenCalledWith(
      777000,
      expect.any(String),
      expect.anything(),
    );
  });

  it("rejects ids that are not MAX user ids", async () => {
    await expect(sendMaxPairingApproval(fakeBot as any, "not-a-user")).rejects.toThrow(
      /not a MAX user id/,
    );
  });
});

describe("config.inspectAccount", () => {
  const inspect = (section: Record<string, unknown>) =>
    (maxPlugin as any).config.inspectAccount(
      { channels: { max: section } },
      undefined,
    ) as Record<string, unknown>;

  it("reports config diagnostics with a masked token preview", () => {
    const info = inspect({
      token: "1234567890abcdefTOKEN",
      dmPolicy: "open",
      groupPolicy: "allowlist",
      webhookUrl: "https://example.com/max/webhook",
      httpProxy: "http://proxy:3128",
      streaming: false,
    });
    expect(info).toMatchObject({
      accountId: "default",
      enabled: true,
      configured: true,
      tokenSource: "config",
      dmPolicy: "open",
      groupPolicy: "allowlist",
      webhook: "webhook",
      streaming: false,
      httpProxy: true,
    });
    expect(info.tokenPreview).toBe("1234…OKEN");
    expect(JSON.stringify(info)).not.toContain("1234567890abcdefTOKEN");
  });

  it("masks short tokens entirely", () => {
    expect(maskMaxToken("short")).toBe("****");
    expect(maskMaxToken("")).toBeNull();
  });

  it("reports defaults for an unconfigured section", () => {
    const info = inspect({});
    expect(info).toMatchObject({
      configured: false,
      tokenSource: "none",
      tokenPreview: null,
      dmPolicy: "allowlist",
      groupPolicy: "open",
      webhook: "polling",
      streaming: true,
      httpProxy: false,
    });
  });
});
