/**
 * Operator controls pressed on presentation keyboards (message_callback):
 * durable approvals and ask_user answers are resolved through the canonical
 * gateway runtimes instead of entering the agent pipeline as text.
 *
 * The callback is answered with a message replacement (original text + status
 * line, keyboard dropped) so the buttons cannot be pressed twice; without a
 * source message (should not happen for bot messages) a plain notification
 * toast is sent instead.
 */

import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import type { MaxPresentationCallback } from "./presentation.js";

/** MAX NewMessageBody text limit (schema 0.0.33). */
const MAX_MESSAGE_TEXT_LIMIT = 4000;

type RuntimeControlAction = Extract<MaxPresentationCallback, { kind: "approval" | "question" }>;

/**
 * Approvals and ask_user answers are operator actions: only senders listed
 * explicitly in the account's allowFrom may press them (a wildcard is enough
 * for questions, never for approvals).
 */
export function isMaxRuntimeControlSender(
  allowFrom: readonly (string | number)[],
  senderId: string,
  kind: "approval" | "question",
): boolean {
  const allowed = allowFrom.map((entry) => String(entry).trim().replace(/^max:/i, ""));
  if (allowed.includes(senderId)) return true;
  return kind === "question" && allowed.includes("*");
}

function statusLine(action: RuntimeControlAction, result: string): string {
  return `${result}`;
}

export async function resolveMaxRuntimeControlCallback(params: {
  action: RuntimeControlAction;
  cfg: OpenClawConfig;
  accountId: string | null;
  senderId: string;
  allowFrom: readonly (string | number)[];
  /** Text of the message the keyboard was attached to (for replacement). */
  sourceText?: string;
  answerCallback: (body: { notification?: string; message?: { text: string } }) => Promise<void>;
  log?: { warn: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  const { action, cfg, accountId, senderId, sourceText, answerCallback, log } = params;
  let status: string;

  if (!isMaxRuntimeControlSender(params.allowFrom, senderId, action.kind)) {
    log?.warn(`[MAX] ${action.kind} button pressed by unauthorized sender ${senderId}`);
    status = "⛔ You are not allowed to answer this.";
  } else {
    try {
      if (action.kind === "approval") {
        const result = await resolveApprovalOverGateway({
          cfg,
          approvalId: action.approvalId,
          approvalKind: action.approvalKind,
          decision: action.decision,
          channel: "max",
          accountId,
          senderId,
        });
        status = result.applied
          ? `✅ Decision recorded: ${action.decision}.`
          : "ℹ️ This approval was already resolved.";
      } else {
        const result = await questionGatewayRuntime.resolveOption({
          cfg,
          questionId: action.questionId,
          optionValue: action.optionValue,
          senderId,
          authorize: () => isMaxRuntimeControlSender(params.allowFrom, senderId, "question"),
        });
        status =
          result.status === "answered"
            ? "✅ Answer recorded."
            : result.status === "denied"
              ? "⛔ You are not allowed to answer this."
              : "ℹ️ This question is no longer open.";
      }
    } catch (err) {
      log?.error(`[MAX] ${action.kind} callback failed: ${String(err)}`);
      status = "⚠️ Could not apply this action.";
    }
  }

  // Replace the keyboard message (buttons dropped) so a resolved control
  // cannot be pressed twice; fall back to a toast without a source message.
  const trimmedSource = sourceText?.trim() ?? "";
  try {
    if (trimmedSource) {
      const text = `${trimmedSource}\n\n${statusLine(action, status)}`.slice(
        0,
        MAX_MESSAGE_TEXT_LIMIT,
      );
      await answerCallback({ message: { text } });
    } else {
      await answerCallback({ notification: status });
    }
  } catch (err) {
    log?.warn(`[MAX] callback answer failed: ${String(err)}`);
  }
}
