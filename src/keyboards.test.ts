import { describe, expect, it } from "vitest";
import {
  MAX_KEYBOARD_LIMITS,
  MaxKeyboardError,
  interactiveToMaxButtons,
  parseInlineKeyboardInput,
  presentationToMaxButtons,
  resolvePayloadKeyboardButtons,
  resolveReplyKeyboardButtons,
  toInlineKeyboardAttachment,
} from "./keyboards.js";

describe("parseInlineKeyboardInput", () => {
  it("normalizes simplified buttons into wire buttons", () => {
    const rows = parseInlineKeyboardInput([
      [
        { text: "Да", payload: "vote:yes" },
        { text: "Нет" }, // payload defaults to the label
        { text: "Docs", url: "https://dev.max.ru" },
      ],
      ["Plain string"],
    ]);
    expect(rows).toEqual([
      [
        { type: "callback", text: "Да", payload: "vote:yes" },
        { type: "callback", text: "Нет", payload: "Нет" },
        { type: "link", text: "Docs", url: "https://dev.max.ru" },
      ],
      [{ type: "callback", text: "Plain string", payload: "Plain string" }],
    ]);
  });

  it("accepts ready wire buttons and passes them through", () => {
    const wire = [[{ type: "clipboard", text: "Copy", payload: "abc" }]];
    expect(parseInlineKeyboardInput(wire)).toEqual(wire);
  });

  it("returns empty rows for absent input", () => {
    expect(parseInlineKeyboardInput(undefined)).toEqual([]);
    expect(parseInlineKeyboardInput(null)).toEqual([]);
  });

  it("rejects malformed shapes", () => {
    expect(() => parseInlineKeyboardInput("not-rows")).toThrow();
    expect(() => parseInlineKeyboardInput([[]])).toThrow(); // empty row
    expect(() => parseInlineKeyboardInput([[{ text: "" }]])).toThrow(); // empty label
    expect(() => parseInlineKeyboardInput([[{ type: "unknown" as any, text: "x" }]])).toThrow();
    expect(() => parseInlineKeyboardInput([[{ text: "x", url: "not-a-url" }]])).toThrow();
  });
});

describe("MAX keyboard limits", () => {
  const button = (text: string) => ({ type: "callback" as const, text, payload: text });
  const link = (text: string) => ({
    type: "link" as const,
    text,
    url: "https://max.ru",
  });

  it("accepts the maximum keyboard: 30 rows x 7 callback buttons = 210", () => {
    const rows = Array.from({ length: MAX_KEYBOARD_LIMITS.maxRows }, (_, i) =>
      Array.from({ length: MAX_KEYBOARD_LIMITS.maxButtonsPerRow }, (_, j) => button(`b${i}-${j}`)),
    );
    expect(parseInlineKeyboardInput(rows)).toHaveLength(MAX_KEYBOARD_LIMITS.maxRows);
  });

  it("rejects more than 30 rows", () => {
    const rows = Array.from({ length: MAX_KEYBOARD_LIMITS.maxRows + 1 }, (_, i) => [button(`r${i}`)]);
    expect(() => parseInlineKeyboardInput(rows)).toThrow(MaxKeyboardError);
    expect(() => parseInlineKeyboardInput(rows)).toThrow(/at most 30/);
  });

  it("rejects more than 210 buttons", () => {
    // 30 rows x 7 buttons = 210 is the exact grid maximum; one more button
    // necessarily violates a row or count limit first.
    const rows = Array.from({ length: 30 }, (_, i) =>
      Array.from({ length: 7 }, (_, j) => button(`b${i}-${j}`)),
    );
    rows.push([button("overflow")]); // 31 rows, 211 buttons
    expect(() => parseInlineKeyboardInput(rows)).toThrow(MaxKeyboardError);
    expect(() => parseInlineKeyboardInput(rows)).toThrow(/211 buttons|31 rows/);
  });

  it("rejects rows longer than 7 buttons", () => {
    const rows = [Array.from({ length: 8 }, (_, i) => button(`b${i}`))];
    expect(() => parseInlineKeyboardInput(rows)).toThrow(/row 1 has 8 buttons/);
  });

  it("caps rows containing restricted button types at 3", () => {
    expect(() => parseInlineKeyboardInput([[link("a"), link("b"), link("c"), link("d")]])).toThrow(
      /at most 3/,
    );
    // a single link button caps the whole row
    expect(() =>
      parseInlineKeyboardInput([[link("a"), button("1"), button("2"), button("3")]]),
    ).toThrow(/at most 3/);
    // exactly 3 in a restricted row is fine
    expect(parseInlineKeyboardInput([[link("a"), button("1"), button("2")]])).toHaveLength(1);
  });

  it("rejects link URLs longer than 2048 characters", () => {
    const longUrl = `https://max.ru/${"a".repeat(MAX_KEYBOARD_LIMITS.maxUrlLength)}`;
    expect(() => parseInlineKeyboardInput([[{ text: "x", url: longUrl }]])).toThrow(
      /at most 2048/,
    );
    const okUrl = `https://max.ru/${"a".repeat(MAX_KEYBOARD_LIMITS.maxUrlLength - 16)}`;
    expect(parseInlineKeyboardInput([[{ text: "x", url: okUrl }]])).toHaveLength(1);
  });
});

describe("toInlineKeyboardAttachment", () => {
  it("serializes rows into the MAX attachments wire format", () => {
    const rows = parseInlineKeyboardInput([[{ text: "OK", payload: "ok" }]]);
    expect(toInlineKeyboardAttachment(rows)).toEqual({
      type: "inline_keyboard",
      payload: { buttons: [[{ type: "callback", text: "OK", payload: "ok" }]] },
    });
  });
});

describe("resolveReplyKeyboardButtons", () => {
  it("returns null without channelData or without the maxInlineKeyboard key", () => {
    expect(resolveReplyKeyboardButtons(undefined)).toBeNull();
    expect(resolveReplyKeyboardButtons(null)).toBeNull();
    expect(resolveReplyKeyboardButtons("nope")).toBeNull();
    expect(resolveReplyKeyboardButtons({})).toBeNull();
    expect(resolveReplyKeyboardButtons({ other: [["x"]] })).toBeNull();
    expect(resolveReplyKeyboardButtons({ maxInlineKeyboard: null })).toBeNull();
  });

  it("extracts and validates the keyboard from channelData", () => {
    expect(
      resolveReplyKeyboardButtons({ maxInlineKeyboard: [[{ text: "Go", payload: "go" }]] }),
    ).toEqual([[{ type: "callback", text: "Go", payload: "go" }]]);
  });

  it("throws MaxKeyboardError for over-limit keyboards", () => {
    const rows = [Array.from({ length: 8 }, (_, i) => `b${i}`)];
    expect(() => resolveReplyKeyboardButtons({ maxInlineKeyboard: rows })).toThrow(
      MaxKeyboardError,
    );
  });
});

describe("presentationToMaxButtons", () => {
  it("maps url and callback buttons onto MAX wire rows, 3 per row", () => {
    const rows = presentationToMaxButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Да", value: "vote:yes" },
            { label: "Нет", action: { type: "callback", value: "vote:no" } },
            { label: "Docs", url: "https://dev.max.ru" },
            { label: "Ещё", action: { type: "command", command: "/more" } },
          ],
        },
      ],
    });
    expect(rows).toEqual([
      [
        { type: "callback", text: "Да", payload: "vote:yes" },
        { type: "callback", text: "Нет", payload: "vote:no" },
        { type: "link", text: "Docs", url: "https://dev.max.ru" },
      ],
      [{ type: "callback", text: "Ещё", payload: "/more" }],
    ]);
  });

  it("degrades web-app buttons to plain link buttons", () => {
    expect(
      presentationToMaxButtons({
        blocks: [{ type: "buttons", buttons: [{ label: "App", webApp: { url: "https://app.max.ru" } }] }],
      }),
    ).toEqual([[{ type: "link", text: "App", url: "https://app.max.ru" }]]);
  });

  it("ignores text blocks and drops disabled/actionless buttons", () => {
    const rows = presentationToMaxButtons({
      title: "Выбор",
      blocks: [
        { type: "text", text: "Взять заказ?" },
        {
          type: "buttons",
          buttons: [
            { label: "Взять", value: "take" },
            { label: "Позже", value: "later", disabled: true },
            { label: "Пустая" },
          ],
        },
      ],
    });
    expect(rows).toEqual([[{ type: "callback", text: "Взять", payload: "take" }]]);
  });

  it("returns null when nothing is renderable", () => {
    expect(presentationToMaxButtons(undefined)).toBeNull();
    expect(presentationToMaxButtons({ blocks: [{ type: "text", text: "hi" }] })).toBeNull();
    expect(
      presentationToMaxButtons({ blocks: [{ type: "buttons", buttons: [{ label: "x" }] }] }),
    ).toBeNull();
  });

  it("throws MaxKeyboardError when the result exceeds MAX limits", () => {
    // 100 buttons pack 3 per row → 34 rows > 30-row cap.
    const buttons = Array.from({ length: 100 }, (_, i) => ({ label: `b${i}`, value: `v${i}` }));
    expect(() =>
      presentationToMaxButtons({ blocks: [{ type: "buttons", buttons }] }),
    ).toThrow(MaxKeyboardError);
  });
});

describe("interactiveToMaxButtons", () => {
  it("maps legacy interactive buttons blocks", () => {
    expect(
      interactiveToMaxButtons({
        blocks: [
          { type: "text", text: "pick one" },
          { type: "buttons", buttons: [{ label: "OK", value: "ok" }] },
        ],
      }),
    ).toEqual([[{ type: "callback", text: "OK", payload: "ok" }]]);
  });

  it("returns null for non-interactive input", () => {
    expect(interactiveToMaxButtons(undefined)).toBeNull();
    expect(interactiveToMaxButtons({ blocks: [] })).toBeNull();
  });
});

describe("resolvePayloadKeyboardButtons", () => {
  it("prefers channelData.maxInlineKeyboard over interactive and presentation", () => {
    const payload = {
      channelData: { maxInlineKeyboard: [["Explicit"]] },
      interactive: { blocks: [{ type: "buttons", buttons: [{ label: "I", value: "i" }] }] },
      presentation: { blocks: [{ type: "buttons", buttons: [{ label: "P", value: "p" }] }] },
    };
    expect(resolvePayloadKeyboardButtons(payload)).toEqual([
      [{ type: "callback", text: "Explicit", payload: "Explicit" }],
    ]);
  });

  it("falls back to interactive, then presentation", () => {
    expect(
      resolvePayloadKeyboardButtons({
        interactive: { blocks: [{ type: "buttons", buttons: [{ label: "I", value: "i" }] }] },
        presentation: { blocks: [{ type: "buttons", buttons: [{ label: "P", value: "p" }] }] },
      }),
    ).toEqual([[{ type: "callback", text: "I", payload: "i" }]]);
    expect(
      resolvePayloadKeyboardButtons({
        presentation: { blocks: [{ type: "buttons", buttons: [{ label: "P", value: "p" }] }] },
      }),
    ).toEqual([[{ type: "callback", text: "P", payload: "p" }]]);
  });

  it("returns null for payloads without any keyboard", () => {
    expect(resolvePayloadKeyboardButtons(null)).toBeNull();
    expect(resolvePayloadKeyboardButtons({ text: "hi" })).toBeNull();
  });
});
