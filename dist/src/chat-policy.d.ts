/**
 * Chat-level admission of a GROUP chat under the channels.max group policy —
 * the shared core of the inbound gate (index.ts checkGroupAccess) and the
 * moderation-actions gate (src/actions.ts). Sender-level rules
 * (groupAllowFrom, requireMention) are inbound-message concerns and are
 * deliberately NOT part of this check: an agent action targeted at an
 * admitted chat is allowed regardless of who "sent" it.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
export type ChatAdmission = {
    admitted: true;
} | {
    admitted: false;
    reason: string;
};
/**
 * - groupPolicy "disabled" → no group is admitted;
 * - "allowlist" → the chat must appear in `groups` (or via the "*" wildcard);
 * - per-group `enabled: false` switches a single group off;
 * - "open" (default) admits every group.
 */
export declare function groupChatAdmission(cfg: OpenClawConfig, chatId: string | number): ChatAdmission;
//# sourceMappingURL=chat-policy.d.ts.map