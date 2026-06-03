import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { Bot } from "@maxhub/max-bot-api";

type ResolvedAccount = {
  accountId: string | null;
  token: string;
  allowFrom: string[];
  dmPolicy: string | undefined;
};

function resolveAccountId(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): string {
  return params.accountId ?? "default";
}

function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAccount {
  const section = (cfg.channels as Record<string, any>)?.["max"];
  const token = section?.token;
  if (!token) throw new Error("max: token is required");
  return {
    accountId: accountId ?? null,
    token,
    allowFrom: section?.allowFrom ?? [],
    dmPolicy: section?.dmSecurity,
  };
}

// Store bot instance for outbound messaging
let botInstance: Bot | null = null;

export const maxPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: {
    id: "max",
    meta: {
      id: "max",
      label: "MAX Messenger",
      selectionLabel: "MAX Messenger (plugin)",
      blurb: "Connect OpenClaw to MAX messenger.",
      docsPath: "/plugins/max",
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      reactions: false,
      threads: false,
      media: true,
      nativeCommands: false,
    },
    setup: {
      resolveAccountId,
      applyAccountConfig(params) {
        return params.cfg;
      },
    },
    config: {
      resolveAccount,
      listAccountIds(cfg) {
        return ["default"];
      },
    },
  },

  // DM security: who can message the bot
  security: {
    dm: {
      channelKey: "max",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  // Pairing: approval flow for new DM contacts
  pairing: {
    text: {
      idLabel: "MAX user ID",
      message: "Send this code to verify your identity:",
      notify: async (params: {
        cfg: OpenClawConfig;
        id: string;
        accountId?: string;
        runtime?: any;
        message: string;
      }) => {
        if (botInstance) {
          await botInstance.api.sendMessageToUser(
            Number(params.id),
            params.message,
            { format: "markdown" }
          );
        }
      },
    },
  },

  // Threading: how replies are delivered
  threading: { topLevelReplyToMode: "reply" },

  // Outbound: send messages to the platform
  outbound: {
    base: {
      deliveryMode: "direct",
    },
    attachedResults: {
      channel: "max",
      sendText: async (params) => {
        if (!botInstance) {
          throw new Error("MAX bot not initialized");
        }
        await botInstance.api.sendMessageToUser(
          Number(params.to),
          params.text,
          { format: "markdown" }
        );
        return { messageId: String(Date.now()) };
      },
    },
  },
});

// Initialize bot function
export function initializeBot(token: string): Bot {
  botInstance = new Bot(token);
  return botInstance;
}

// Get current bot instance
export function getBot(): Bot | null {
  return botInstance;
}
