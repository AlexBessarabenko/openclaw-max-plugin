/**
 * Chat-level admission of a GROUP chat under the channels.max group policy —
 * the shared core of the inbound gate (index.ts checkGroupAccess) and the
 * moderation-actions gate (src/actions.ts). Sender-level rules
 * (groupAllowFrom, requireMention) are inbound-message concerns and are
 * deliberately NOT part of this check: an agent action targeted at an
 * admitted chat is allowed regardless of who "sent" it.
 */
import { MAX_CHANNEL_ID } from "../channel.js";
/**
 * - groupPolicy "disabled" → no group is admitted;
 * - "allowlist" → the chat must appear in `groups` (or via the "*" wildcard);
 * - per-group `enabled: false` switches a single group off;
 * - "open" (default) admits every group.
 */
export function groupChatAdmission(cfg, chatId) {
    const section = (cfg.channels?.[MAX_CHANNEL_ID] ?? {});
    const groupPolicy = section.groupPolicy ?? "open";
    if (groupPolicy === "disabled")
        return { admitted: false, reason: "groupPolicy=disabled" };
    const groups = section.groups ?? {};
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
//# sourceMappingURL=chat-policy.js.map