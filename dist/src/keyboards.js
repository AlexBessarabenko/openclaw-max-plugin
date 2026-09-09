import { z } from "zod";
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
//# sourceMappingURL=keyboards.js.map