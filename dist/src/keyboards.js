import { z } from "zod";
import { legacyInteractiveReplyToPresentation, normalizeLegacyInteractiveReply, normalizeMessagePresentation, resolveMessagePresentationButtonAction, resolveMessagePresentationControlValue, } from "openclaw/plugin-sdk/interactive-runtime";
/**
 * MAX inline keyboards: validation, limits and wire serialization.
 *
 * Wire format (MAX Bot API v2, `attachments` on send/edit):
 *   { type: "inline_keyboard", payload: { buttons: Button[][] } }
 * where each inner array is a row (ported from evgeniyvbystrov/openclaw-max
 * `send.ts`; types verified against `@maxhub/max-bot-api@0.3.1`).
 *
 * Official limits (dev.max.ru → «Клавиатуры»):
 *   - up to 210 buttons per keyboard
 *   - up to 30 rows
 *   - up to 7 buttons per row
 *   - up to 3 buttons per row when the row contains a button of a restricted
 *     type: link / open_app / request_geo_location / request_contact
 *   - link URL up to 2048 characters
 */
/** Official MAX inline keyboard limits (dev.max.ru). */
export const MAX_KEYBOARD_LIMITS = {
    maxButtons: 210,
    maxRows: 30,
    maxButtonsPerRow: 7,
    maxButtonsPerRowRestricted: 3,
    maxUrlLength: 2048,
};
/** Button types that cap their row at 3 buttons. */
const RESTRICTED_ROW_BUTTON_TYPES = new Set([
    "link",
    "open_app",
    "request_geo_location",
    "request_contact",
]);
/** Button types accepted by this plugin (MVP-1 scope). */
const CallbackButtonSchema = z.object({
    type: z.literal("callback"),
    text: z.string().min(1),
    payload: z.string(),
});
const LinkButtonSchema = z.object({
    type: z.literal("link"),
    text: z.string().min(1),
    url: z.string().url(),
});
const ClipboardButtonSchema = z.object({
    type: z.literal("clipboard"),
    text: z.string().min(1),
    payload: z.string(),
});
export const MaxButtonSchema = z.discriminatedUnion("type", [
    CallbackButtonSchema,
    LinkButtonSchema,
    ClipboardButtonSchema,
]);
/** Full wire-form keyboard: rows of ready buttons. */
const WireRowsSchema = z.array(z.array(MaxButtonSchema).min(1)).min(1);
/** Simplified button description (donor style): label + optional url/payload. */
const SimpleButtonSchema = z
    .object({
    text: z.string().min(1),
    url: z.string().url().optional(),
    payload: z.string().optional(),
})
    .strict();
// Full wire buttons must come first: zod objects strip unknown keys, so a
// simplified schema would silently drop `type` from ready wire buttons.
const ButtonInputSchema = z.union([MaxButtonSchema, SimpleButtonSchema, z.string().min(1)]);
/** Input accepted from `channelData`: rows of simplified or ready buttons. */
const RowsInputSchema = z.array(z.array(ButtonInputSchema).min(1)).min(1);
/** Keyboard error with a human-readable constraint message. */
export class MaxKeyboardError extends Error {
    constructor(message) {
        super(message);
        this.name = "MaxKeyboardError";
    }
}
/** Button types accepted by this plugin (MVP-1 scope). */
const SUPPORTED_BUTTON_TYPES = new Set(["callback", "link", "clipboard"]);
function normalizeInputButton(input) {
    if (typeof input === "string") {
        return { type: "callback", text: input, payload: input };
    }
    if ("type" in input) {
        const type = input.type;
        if (!SUPPORTED_BUTTON_TYPES.has(String(type))) {
            throw new MaxKeyboardError(`unsupported button type "${String(type)}" (supported: callback, link, clipboard)`);
        }
        return input;
    }
    // Simplified description: url wins (donor send.ts), otherwise callback.
    const { text, url, payload } = input;
    if (url !== undefined) {
        return { type: "link", text, url };
    }
    return { type: "callback", text, payload: payload ?? text };
}
function assertKeyboardLimits(rows) {
    if (rows.length > MAX_KEYBOARD_LIMITS.maxRows) {
        throw new MaxKeyboardError(`inline keyboard has ${rows.length} rows; MAX allows at most ${MAX_KEYBOARD_LIMITS.maxRows}`);
    }
    const total = rows.reduce((sum, row) => sum + row.length, 0);
    if (total > MAX_KEYBOARD_LIMITS.maxButtons) {
        throw new MaxKeyboardError(`inline keyboard has ${total} buttons; MAX allows at most ${MAX_KEYBOARD_LIMITS.maxButtons}`);
    }
    rows.forEach((row, rowIdx) => {
        const restricted = row.some((button) => RESTRICTED_ROW_BUTTON_TYPES.has(button.type));
        const maxPerRow = restricted
            ? MAX_KEYBOARD_LIMITS.maxButtonsPerRowRestricted
            : MAX_KEYBOARD_LIMITS.maxButtonsPerRow;
        if (row.length > maxPerRow) {
            throw new MaxKeyboardError(`inline keyboard row ${rowIdx + 1} has ${row.length} buttons; MAX allows at most ` +
                `${maxPerRow} in a row${restricted ? " containing link/open_app/request_geo_location/request_contact buttons" : ""}`);
        }
        for (const button of row) {
            if (button.type === "link" && button.url.length > MAX_KEYBOARD_LIMITS.maxUrlLength) {
                throw new MaxKeyboardError(`link button "${button.text}" URL is ${button.url.length} chars; MAX allows at most ${MAX_KEYBOARD_LIMITS.maxUrlLength}`);
            }
        }
    });
}
/**
 * Parse and validate an inline keyboard from `channelData.maxInlineKeyboard`.
 *
 * Accepts either simplified rows (`[[{text, url?, payload?}, "plain"]]`) or
 * full wire rows (`[[{type: "callback", text, payload}]]`). Plain strings
 * become callback buttons carrying their own text as payload.
 *
 * @throws MaxKeyboardError (and z.ZodError passthrough on malformed shapes)
 */
export function parseInlineKeyboardInput(raw) {
    if (raw === undefined || raw === null)
        return [];
    const parsed = RowsInputSchema.parse(raw);
    const rows = parsed.map((row) => row.map(normalizeInputButton));
    assertKeyboardLimits(rows);
    return rows;
}
export function toInlineKeyboardAttachment(buttons) {
    return { type: "inline_keyboard", payload: { buttons } };
}
/**
 * Extract the reply keyboard from an outbound reply payload's `channelData`.
 *
 * - no `channelData.maxInlineKeyboard` key → null (nothing to attach)
 * - malformed or over-limit keyboard → throws MaxKeyboardError
 *   (callers warn and still deliver the text reply)
 */
export function resolveReplyKeyboardButtons(channelData) {
    if (!channelData || typeof channelData !== "object" || Array.isArray(channelData))
        return null;
    const raw = channelData.maxInlineKeyboard;
    if (raw === undefined || raw === null)
        return null;
    const buttons = parseInlineKeyboardInput(raw);
    return buttons.length > 0 ? buttons : null;
}
/**
 * Portable `presentation`/`interactive` reply payloads (core 2026.9.x) → MAX
 * inline keyboard rows. Buttons pack 3 per row (matches the restricted-type
 * row cap, so link and callback buttons can mix freely).
 *
 * Mapping (mirrors the core Telegram adapter):
 *   - action url / web-app with a URL → link button (MAX has no web-app type)
 *   - action callback / command, or a plain `value` → callback button
 *   - disabled buttons and buttons with no resolvable action are dropped
 *
 * @throws MaxKeyboardError when the result exceeds the MAX keyboard limits
 */
export const MAX_PRESENTATION_ROW_SIZE = 3;
function presentationButtonToMaxButton(button) {
    if (button.disabled === true)
        return null;
    const label = typeof button.label === "string" ? button.label.trim() : "";
    if (!label)
        return null;
    const action = resolveMessagePresentationButtonAction(button);
    if (!action)
        return null;
    if ((action.type === "url" || action.type === "web-app") && action.url) {
        return { type: "link", text: label, url: action.url };
    }
    const value = resolveMessagePresentationControlValue(button);
    if (typeof value === "string" && value.trim()) {
        return { type: "callback", text: label, payload: value };
    }
    return null;
}
export function presentationToMaxButtons(rawPresentation) {
    const presentation = normalizeMessagePresentation(rawPresentation);
    if (!presentation)
        return null;
    const rows = [];
    let row = [];
    const flush = () => {
        if (row.length > 0) {
            rows.push(row);
            row = [];
        }
    };
    for (const block of presentation.blocks) {
        if (block.type !== "buttons")
            continue;
        for (const button of block.buttons) {
            const rendered = presentationButtonToMaxButton(button);
            if (!rendered)
                continue;
            row.push(rendered);
            if (row.length === MAX_PRESENTATION_ROW_SIZE)
                flush();
        }
    }
    flush();
    if (rows.length === 0)
        return null;
    assertKeyboardLimits(rows);
    return rows;
}
/** Legacy `interactive` reply payloads → MAX rows (via the presentation shape). */
export function interactiveToMaxButtons(rawInteractive) {
    const interactive = normalizeLegacyInteractiveReply(rawInteractive);
    if (!interactive)
        return null;
    const presentation = legacyInteractiveReplyToPresentation(interactive);
    if (!presentation)
        return null;
    return presentationToMaxButtons(presentation);
}
/**
 * Resolve the keyboard for any reply/outbound payload. Precedence mirrors the
 * core Telegram adapter: explicit `channelData.maxInlineKeyboard` wins, then
 * legacy `interactive`, then portable `presentation` buttons blocks.
 *
 * @throws MaxKeyboardError (callers warn and deliver without a keyboard)
 */
export function resolvePayloadKeyboardButtons(payload) {
    if (!payload || typeof payload !== "object")
        return null;
    const fromChannelData = resolveReplyKeyboardButtons(payload.channelData);
    if (fromChannelData)
        return fromChannelData;
    return interactiveToMaxButtons(payload.interactive) ?? presentationToMaxButtons(payload.presentation);
}
//# sourceMappingURL=keyboards.js.map