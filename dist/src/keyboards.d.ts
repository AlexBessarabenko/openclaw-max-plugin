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
export declare const MAX_KEYBOARD_LIMITS: {
    readonly maxButtons: 210;
    readonly maxRows: 30;
    readonly maxButtonsPerRow: 7;
    readonly maxButtonsPerRowRestricted: 3;
    readonly maxUrlLength: 2048;
};
export declare const MaxButtonSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"callback">;
    text: z.ZodString;
    payload: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"link">;
    text: z.ZodString;
    url: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"clipboard">;
    text: z.ZodString;
    payload: z.ZodString;
}, z.core.$strip>], "type">;
export type MaxButton = z.infer<typeof MaxButtonSchema>;
/** Keyboard error with a human-readable constraint message. */
export declare class MaxKeyboardError extends Error {
    constructor(message: string);
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
export declare function parseInlineKeyboardInput(raw: unknown): MaxButton[][];
/** Serialize validated buttons into the MAX `attachments` wire format. */
export type MaxInlineKeyboardAttachment = {
    type: "inline_keyboard";
    payload: {
        buttons: MaxButton[][];
    };
};
export declare function toInlineKeyboardAttachment(buttons: MaxButton[][]): MaxInlineKeyboardAttachment;
/**
 * Extract the reply keyboard from an outbound reply payload's `channelData`.
 *
 * - no `channelData.maxInlineKeyboard` key → null (nothing to attach)
 * - malformed or over-limit keyboard → throws MaxKeyboardError
 *   (callers warn and still deliver the text reply)
 */
export declare function resolveReplyKeyboardButtons(channelData: unknown): MaxButton[][] | null;
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
export declare const MAX_PRESENTATION_ROW_SIZE = 3;
export declare function presentationToMaxButtons(rawPresentation: unknown): MaxButton[][] | null;
/** Legacy `interactive` reply payloads → MAX rows (via the presentation shape). */
export declare function interactiveToMaxButtons(rawInteractive: unknown): MaxButton[][] | null;
/**
 * Resolve the keyboard for any reply/outbound payload. Precedence mirrors the
 * core Telegram adapter: explicit `channelData.maxInlineKeyboard` wins, then
 * legacy `interactive`, then portable `presentation` buttons blocks.
 *
 * @throws MaxKeyboardError (callers warn and deliver without a keyboard)
 */
export declare function resolvePayloadKeyboardButtons(payload: {
    channelData?: unknown;
    interactive?: unknown;
    presentation?: unknown;
} | null | undefined): MaxButton[][] | null;
//# sourceMappingURL=keyboards.d.ts.map