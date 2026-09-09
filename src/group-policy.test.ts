import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Group policy tests: groupPolicy (open/allowlist/disabled), groupAllowFrom
 * sender checks, requireMention via @username / reply-to-bot, the "*" wildcard
 * with per-group overrides, and the open-without-allowlist startup warning.
 * Blocked traffic must cause zero downloads and zero dispatches (B3 principle).
 */

const fetchSpy = vi.fn(async () => new Response("bytes", { status: 200 }));

const fakeBot = {
  api: {
    sendMessageToChat: vi.fn(),
    sendMessageToUser: vi.fn(),
    editMessage: vi.fn(),
    answerOnCallback: vi.fn(),
    sendAction: vi.fn(),
    getMyInfo: vi.fn(async () => ({ user_id: 777, username: "test_bot" })),
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
import { resolveGroupPolicyWarning } from "../channel.js";

function makeApi(channelConfig: Record<string, unknown>) {
  const captured: { inboundArgs?: any } = {};
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
            captured.inboundArgs = args;
            const turn = await args.adapter.resolveTurn();
            await turn.runDispatch();
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
function groupMessage(text: string, opts: { chatId?: number; senderId?: number; link?: any; withAttachment?: boolean } = {}) {
  return {
    update_type: "message_created",
    message: {
      sender: { user_id: opts.senderId ?? 100200, name: "Egor" },
      recipient: { chat_id: opts.chatId ?? -900100, chat_type: "chat" },
      body: { mid: `g-${++midSeq}`, text },
      ...(opts.link ? { link: opts.link } : {}),
      attachments: opts.withAttachment
        ? [{ type: "image", payload: { url: "https://cdn.max.ru/pic.jpg" } }]
        : undefined,
      timestamp: 1757190000,
    },
  };
}

function groupCallback(chatId = -900100) {
  return {
    update_type: "message_callback",
    callback: {
      timestamp: 1757191000,
      callback_id: `cb-g-${++midSeq}`,
      payload: "vote:yes",
      user: { user_id: 100200, name: "Egor" },
    },
    message: { recipient: { chat_id: chatId, chat_type: "chat" }, body: { mid: "m-cb" } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("groupPolicy", () => {
  it("disabled: group traffic is ignored entirely (no download, no dispatch)", async () => {
    const { api } = makeApi({ groupPolicy: "disabled" });
    await handleUpdate(api as any, groupMessage("привет", { withAttachment: true }), "tok");
    expect(api.runtime.channel.inbound.run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("default (no config) stays open — pre-0.5 behavior preserved", async () => {
    const { api } = makeApi({});
    await handleUpdate(api as any, groupMessage("привет"), "tok");
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("allowlist: only chats in groups (or via wildcard) pass", async () => {
    const { api } = makeApi({ groupPolicy: "allowlist", groups: { "-111": {} } });
    await handleUpdate(api as any, groupMessage("нет", { chatId: -900100 }), "tok");
    expect(api.runtime.channel.inbound.run).not.toHaveBeenCalled();

    await handleUpdate(api as any, groupMessage("да", { chatId: -111 }), "tok");
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);

    const wild = makeApi({ groupPolicy: "allowlist", groups: { "*": {} } });
    await handleUpdate(wild.api as any, groupMessage("все", { chatId: -222 }), "tok");
    expect(wild.api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("allowlist + groupAllowFrom: sender must be listed when the list is non-empty", async () => {
    const { api } = makeApi({
      groupPolicy: "allowlist",
      groups: { "*": {} },
      groupAllowFrom: ["555000"],
    });
    await handleUpdate(api as any, groupMessage("чужой", { senderId: 100200 }), "tok");
    expect(api.runtime.channel.inbound.run).not.toHaveBeenCalled();

    await handleUpdate(api as any, groupMessage("свой", { senderId: 555000 }), "tok");
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("per-group enabled: false switches a single group off", async () => {
    const { api } = makeApi({ groupPolicy: "open", groups: { "-900100": { enabled: false } } });
    await handleUpdate(api as any, groupMessage("тишина"), "tok");
    expect(api.runtime.channel.inbound.run).not.toHaveBeenCalled();
  });
});

describe("requireMention", () => {
  const cfg = { groups: { "*": { requireMention: true } } };

  it("message without a mention is dropped before any download", async () => {
    const { api } = makeApi(cfg);
    await handleUpdate(api as any, groupMessage("просто текст", { withAttachment: true }), "tok");
    expect(api.runtime.channel.inbound.run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("@username mention passes", async () => {
    const { api } = makeApi(cfg);
    await handleUpdate(api as any, groupMessage("@test_bot привет"), "tok");
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("reply to the bot's message counts as a mention", async () => {
    const { api } = makeApi(cfg);
    await handleUpdate(
      api as any,
      groupMessage("ответ", { link: { type: "reply", sender: { user_id: 777, is_bot: true } } }),
      "tok",
    );
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("reply to another user is not a mention", async () => {
    const { api } = makeApi(cfg);
    await handleUpdate(
      api as any,
      groupMessage("ответ", { link: { type: "reply", sender: { user_id: 999, is_bot: false } } }),
      "tok",
    );
    expect(api.runtime.channel.inbound.run).not.toHaveBeenCalled();
  });

  it("per-group requireMention overrides the wildcard", async () => {
    const { api } = makeApi({
      groups: { "*": { requireMention: true }, "-900100": { requireMention: false } },
    });
    await handleUpdate(api as any, groupMessage("без упоминания"), "tok");
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("button presses in groups count as mentions but obey the policy", async () => {
    const { api } = makeApi(cfg);
    await handleUpdate(api as any, groupCallback(), "tok");
    expect(api.runtime.channel.inbound.run).toHaveBeenCalledTimes(1);

    const blocked = makeApi({ groupPolicy: "allowlist", groups: { "-111": {} } });
    await handleUpdate(blocked.api as any, groupCallback(-900100), "tok");
    expect(blocked.api.runtime.channel.inbound.run).not.toHaveBeenCalled();
  });
});

describe("group policy startup warning", () => {
  it("warns on open without groupAllowFrom, silent otherwise", () => {
    expect(resolveGroupPolicyWarning({})).toMatch(/groupPolicy is "open"/);
    expect(resolveGroupPolicyWarning({ groupPolicy: "open", groupAllowFrom: ["1"] })).toBeNull();
    expect(resolveGroupPolicyWarning({ groupPolicy: "allowlist" })).toBeNull();
    expect(resolveGroupPolicyWarning({ groupPolicy: "disabled" })).toBeNull();
  });
});
