import { describe, expect, it } from "vitest";
import {
  MAX_KEYBOARD_LIMITS,
  MaxKeyboardError,
  parseInlineKeyboardInput,
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
