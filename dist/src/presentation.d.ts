/**
 * Portable MessagePresentation (core interactive-runtime) → MAX text + inline
 * keyboard, and the private callback envelopes that carry typed actions back.
 *
 * Envelopes (callback payload is transport-private, ≤1024 bytes):
 * - callback → "mxcb1:<value>": opaque, delivered to the agent labelled
 *   "callback_data: <value>", never parsed as a slash command;
 * - approval → "mxa1:<e|p|s>:<o|a|d>:<approvalId>": resolved through the
 *   canonical approval runtime (approval-gateway-runtime);
 * - question → "mxq1:<questionId>:<optionValue>": resolved through
 *   question-gateway-runtime;
 * - command → the command text itself ("/status"): re-enters as a user
 *   message and takes core's native command path;
 * - url / URL-backed web-app → a MAX `link` button.
 *
 * Buttons supplied verbatim via channelData.maxInlineKeyboard are NOT
 * enveloped — their payloads arrive as message text, as documented.
 */
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { MaxButton } from "./keyboards.js";
export type MaxApprovalKind = "exec" | "plugin" | "system-agent";
export type MaxApprovalDecision = "allow-once" | "allow-always" | "deny";
export type MaxPresentationCallback = {
    kind: "callback";
    value: string;
} | {
    kind: "approval";
    approvalId: string;
    approvalKind: MaxApprovalKind;
    decision: MaxApprovalDecision;
} | {
    kind: "question";
    questionId: string;
    optionValue: string;
};
/** Decode a payload produced by this renderer; null for anything else. */
export declare function decodeMaxPresentationCallback(payload: string | undefined | null): MaxPresentationCallback | null;
/** Schema 0.0.33: Button.text maxLength 128, CallbackButton.payload maxLength 1024. */
export declare const MAX_BUTTON_TEXT_LIMIT = 128;
export declare const MAX_CALLBACK_PAYLOAD_BYTES = 1024;
/** Monospace-aligned table (MAX renders ``` fences as preformatted blocks). */
export declare function monospaceTable(headers: string[], rows: string[][]): string;
export declare const MAX_PRESENTATION_BUTTONS_PER_ROW = 3;
export declare const MAX_PRESENTATION_SELECT_PER_ROW = 2;
export type MaxRenderedPresentation = {
    text: string;
    buttons: MaxButton[][];
};
/**
 * Pure mapping of an (already core-adapted) presentation to MAX markdown text
 * + inline keyboard rows. Controls that cannot be carried (oversized payload,
 * widget-only web-app, custom-input questions, …) degrade to a label-only
 * text fallback so the user still sees what was offered.
 */
export declare function renderMaxPresentationParts(params: {
    presentation: MessagePresentation;
    text?: string | null;
}): MaxRenderedPresentation;
//# sourceMappingURL=presentation.d.ts.map