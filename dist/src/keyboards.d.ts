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
//# sourceMappingURL=keyboards.d.ts.map