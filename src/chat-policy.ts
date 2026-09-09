/**
 * Chat-level admission of a GROUP chat under the channels.max group policy —
 * the shared core of the inbound gate (index.ts checkGroupAccess) and the
 * moderation-actions gate (src/actions.ts). Sender-level rules
 * (groupAllowFrom, requireMention) are inbound-message concerns and are
 * deliberately NOT part of this check: an agent action targeted at an
 * admitted chat is allowed regardless of who "sent" it.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { MAX_CHANNEL_ID } from "../channel.js";

export type ChatAdmission = { admitted: true } | { admitted: false; reason: string };

/**
 * - groupPolicy "disabled" → no group is admitted;
 * - "allowlist" → the chat must appear in `groups` (or via the "*" wildcard);
 * - per-group `enabled: false` switches a single group off;
 * - "open" (default) admits every group.
 */
export function groupChatAdmission(cfg: OpenClawConfig, chatId: string | number): ChatAdmission {
  const section = ((cfg.channels as Record<string, any>)?.[MAX_CHANNEL_ID] ?? {}) as Record<
    string,
    any
  >;
  const groupPolicy: string = section.groupPolicy ?? "open";
  if (groupPolicy === "disabled") return { admitted: false, reason: "groupPolicy=disabled" };
  const groups: Record<string, any> = section.groups ?? {};
  const key = String(chatId);
  if (groupPolicy === "allowlist" && !(key in groups) && !("*" in groups)) {
    return { admitted: false, reason: "chat not in groups allowlist" };
  }
  const groupCfg = groups[key] ?? groups["*"];
  if (groupCfg?.enabled === false) {
    return { admitted: false, reason: "group disabled via groups config" };
  }
  return { admitted: true };
}
