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
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { MaxPresentationCallback } from "./presentation.js";
type RuntimeControlAction = Extract<MaxPresentationCallback, {
    kind: "approval" | "question";
}>;
/**
 * Approvals and ask_user answers are operator actions: only senders listed
 * explicitly in the account's allowFrom may press them (a wildcard is enough
 * for questions, never for approvals).
 */
export declare function isMaxRuntimeControlSender(allowFrom: readonly (string | number)[], senderId: string, kind: "approval" | "question"): boolean;
export declare function resolveMaxRuntimeControlCallback(params: {
    action: RuntimeControlAction;
    cfg: OpenClawConfig;
    accountId: string | null;
    senderId: string;
    allowFrom: readonly (string | number)[];
    /** Text of the message the keyboard was attached to (for replacement). */
    sourceText?: string;
    answerCallback: (body: {
        notification?: string;
        message?: {
            text: string;
        };
    }) => Promise<void>;
    log?: {
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
}): Promise<void>;
export {};
//# sourceMappingURL=runtime-controls.d.ts.map