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
import { renderMessagePresentationFallbackText, resolveMessagePresentationButtonAction, resolveMessagePresentationOptionAction, } from "openclaw/plugin-sdk/interactive-runtime";
// ── Callback envelopes ──
const CALLBACK_PREFIX = "mxcb1:";
const APPROVAL_PREFIX = "mxa1:";
const QUESTION_PREFIX = "mxq1:";
const APPROVAL_KIND_CODES = {
    exec: "e",
    plugin: "p",
    "system-agent": "s",
};
const APPROVAL_DECISION_CODES = {
    "allow-once": "o",
    "allow-always": "a",
    deny: "d",
};
/** Decode a payload produced by this renderer; null for anything else. */
export function decodeMaxPresentationCallback(payload) {
    if (!payload)
        return null;
    if (payload.startsWith(CALLBACK_PREFIX)) {
        const value = payload.slice(CALLBACK_PREFIX.length);
        return value ? { kind: "callback", value } : null;
    }
    if (payload.startsWith(APPROVAL_PREFIX)) {
        const match = /^mxa1:([eps]):([oad]):(.+)$/su.exec(payload);
        if (!match)
            return null;
        const approvalKind = Object.keys(APPROVAL_KIND_CODES).find((kind) => APPROVAL_KIND_CODES[kind] === match[1]);
        const decision = Object.keys(APPROVAL_DECISION_CODES).find((code) => APPROVAL_DECISION_CODES[code] === match[2]);
        return approvalKind && decision
            ? { kind: "approval", approvalKind, decision, approvalId: match[3] }
            : null;
    }
    if (payload.startsWith(QUESTION_PREFIX)) {
        const rest = payload.slice(QUESTION_PREFIX.length);
        const separator = rest.indexOf(":");
        if (separator <= 0 || separator === rest.length - 1)
            return null;
        return {
            kind: "question",
            questionId: rest.slice(0, separator),
            optionValue: rest.slice(separator + 1),
        };
    }
    return null;
}
// ── Controls ──
/** Schema 0.0.33: Button.text maxLength 128, CallbackButton.payload maxLength 1024. */
export const MAX_BUTTON_TEXT_LIMIT = 128;
export const MAX_CALLBACK_PAYLOAD_BYTES = 1024;
function clipLabel(label) {
    const chars = Array.from(label.trim());
    return chars.length <= MAX_BUTTON_TEXT_LIMIT
        ? chars.join("")
        : `${chars.slice(0, MAX_BUTTON_TEXT_LIMIT - 1).join("")}…`;
}
function fitsPayload(payload) {
    // Leave headroom for the envelope prefix inside the 1024-byte limit.
    return payload.length > 0 && Buffer.byteLength(payload, "utf8") <= MAX_CALLBACK_PAYLOAD_BYTES;
}
function callbackButton(label, payload) {
    return fitsPayload(payload)
        ? { button: { type: "callback", text: clipLabel(label), payload } }
        : { dropped: label };
}
function linkButton(label, url) {
    const trimmed = url.trim();
    if (!/^https?:\/\//iu.test(trimmed) || trimmed.length > 2048)
        return { dropped: label };
    return { button: { text: clipLabel(label), type: "link", url: trimmed } };
}
function commandPayload(command) {
    const trimmed = command.trim();
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
function toControl(button) {
    const label = button.label;
    const action = resolveMessagePresentationButtonAction(button);
    if (!action || button.disabled)
        return { dropped: label };
    switch (action.type) {
        case "url":
            return linkButton(label, action.url);
        case "web-app":
            // MAX open_app addresses a bot's mini app by name, not by URL.
            return action.url ? linkButton(label, action.url) : { dropped: label };
        case "command":
            return action.command.trim()
                ? callbackButton(label, commandPayload(action.command))
                : { dropped: label };
        case "callback":
            return callbackButton(label, `${CALLBACK_PREFIX}${action.value}`);
        case "approval": {
            const kind = APPROVAL_KIND_CODES[action.approvalKind];
            const decision = APPROVAL_DECISION_CODES[action.decision];
            if (!kind || !decision || !action.approvalId)
                return { dropped: label };
            return callbackButton(label, `${APPROVAL_PREFIX}${kind}:${decision}:${action.approvalId}`);
        }
        case "question":
            // custom-input needs a free-text composer target MAX cannot address; the
            // producer states the text route in the message, so the control is omitted.
            if ("intent" in action || action.questionId.includes(":"))
                return { dropped: label };
            return callbackButton(label, `${QUESTION_PREFIX}${action.questionId}:${action.optionValue}`);
        default:
            return { dropped: label };
    }
}
function toOptionControl(option) {
    const action = resolveMessagePresentationOptionAction(option);
    if (!action)
        return { dropped: option.label };
    return action.type === "command"
        ? callbackButton(option.label, commandPayload(action.command))
        : callbackButton(option.label, `${CALLBACK_PREFIX}${action.value}`);
}
// ── Text blocks ──
const TONE_PREFIX = {
    info: "ℹ️",
    success: "✅",
    warning: "⚠️",
    danger: "⛔",
};
function collapse(value) {
    return String(value).replace(/\s+/gu, " ").replace(/`/gu, "'").trim();
}
/** Monospace-aligned table (MAX renders ``` fences as preformatted blocks). */
export function monospaceTable(headers, rows) {
    const widths = headers.map((header, column) => Math.max(Array.from(header).length, ...rows.map((row) => Array.from(row[column] ?? "").length)));
    const pad = (cells) => cells
        .map((cell, column) => cell + " ".repeat(Math.max(0, widths[column] - Array.from(cell).length)))
        .join(" | ")
        .trimEnd();
    const lines = [
        pad(headers),
        widths.map((width) => "-".repeat(Math.max(1, width))).join("-+-"),
        ...rows.map(pad),
    ];
    return ["```", ...lines, "```"].join("\n");
}
function renderDataBlock(block) {
    if (block.type === "table") {
        return [
            `**${collapse(block.caption)}**`,
            monospaceTable(block.headers.map(collapse), block.rows.map((row) => row.map(collapse))),
        ].join("\n");
    }
    if (block.chartType === "pie") {
        const total = block.segments.reduce((sum, segment) => sum + segment.value, 0);
        const rows = block.segments.map((segment) => [
            collapse(segment.label),
            collapse(segment.value),
            total > 0 ? `${((segment.value / total) * 100).toFixed(1)}%` : "",
        ]);
        return [`**${collapse(block.title)}** (pie)`, monospaceTable(["", "", "%"], rows)].join("\n");
    }
    const headers = [
        collapse(block.xLabel ?? ""),
        ...block.series.map((series) => collapse(series.name)),
    ];
    const rows = block.categories.map((category, index) => [
        collapse(category),
        ...block.series.map((series) => collapse(series.values[index] ?? "")),
    ]);
    const axis = block.yLabel ? `, ${collapse(block.yLabel)}` : "";
    return [
        `**${collapse(block.title)}** (${block.chartType}${axis})`,
        monospaceTable(headers, rows),
    ].join("\n");
}
function renderContext(text) {
    const trimmed = text.trim();
    return /[_*\n]/u.test(trimmed) ? trimmed : `_${trimmed}_`;
}
function chunk(items, size) {
    const rows = [];
    for (let index = 0; index < items.length; index += size)
        rows.push(items.slice(index, index + size));
    return rows;
}
export const MAX_PRESENTATION_BUTTONS_PER_ROW = 3;
export const MAX_PRESENTATION_SELECT_PER_ROW = 2;
/**
 * Pure mapping of an (already core-adapted) presentation to MAX markdown text
 * + inline keyboard rows. Controls that cannot be carried (oversized payload,
 * widget-only web-app, custom-input questions, …) degrade to a label-only
 * text fallback so the user still sees what was offered.
 */
export function renderMaxPresentationParts(params) {
    const { presentation } = params;
    const baseText = params.text?.trim() ?? "";
    const parts = [];
    const title = presentation.title?.trim();
    if (title && !baseText.startsWith(title)) {
        const tone = presentation.tone ? TONE_PREFIX[presentation.tone] : undefined;
        parts.push(tone ? `${tone} **${title}**` : `**${title}**`);
    }
    if (baseText)
        parts.push(baseText);
    const rows = [];
    const dropped = [];
    const pushRows = (candidates) => {
        for (const row of candidates) {
            if (row.length > 0)
                rows.push(row);
        }
        // Hard keyboard limits are enforced by assertKeyboardLimits downstream;
        // canonicalizeMaxPresentationPayload degrades to text-only on throw.
    };
    for (const block of presentation.blocks) {
        switch (block.type) {
            case "text":
                if (block.text.trim())
                    parts.push(block.text.trim());
                break;
            case "context":
                if (block.text.trim())
                    parts.push(renderContext(block.text));
                break;
            case "divider":
                parts.push("———");
                break;
            case "table":
            case "chart":
                parts.push(renderDataBlock(block));
                break;
            case "buttons": {
                const buttons = [];
                for (const control of block.buttons.map(toControl)) {
                    if ("button" in control)
                        buttons.push(control.button);
                    else
                        dropped.push(control.dropped);
                }
                pushRows(chunk(buttons, MAX_PRESENTATION_BUTTONS_PER_ROW));
                break;
            }
            case "select": {
                if (block.placeholder?.trim())
                    parts.push(`_${collapse(block.placeholder)}_`);
                const options = [];
                for (const control of block.options.map(toOptionControl)) {
                    if ("button" in control)
                        options.push(control.button);
                    else
                        dropped.push(control.dropped);
                }
                pushRows(chunk(options, MAX_PRESENTATION_SELECT_PER_ROW));
                break;
            }
        }
    }
    if (dropped.length > 0) {
        // Label-only fallback, as core renders controls a channel cannot carry.
        const fallback = renderMessagePresentationFallbackText({
            presentation: {
                blocks: [
                    { type: "buttons", buttons: dropped.map((label) => ({ label, value: "unavailable" })) },
                ],
            },
        });
        if (fallback)
            parts.push(fallback);
    }
    return { text: parts.join("\n\n"), buttons: rows };
}
//# sourceMappingURL=presentation.js.map