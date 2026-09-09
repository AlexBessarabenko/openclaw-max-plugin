import { describe, expect, it } from "vitest";
import { canonicalizeMaxPresentationPayload } from "../channel.js";

/**
 * canonicalizeMaxPresentationPayload is the plugin side of the core
 * `renderPresentation` hook (see outbound.renderPresentation in channel.ts):
 * portable presentation payloads become the single MAX payload shape —
 * buttons blocks land on channelData.maxInlineKeyboard, the rest degrades to
 * fallback text.
 */

describe("canonicalizeMaxPresentationPayload", () => {
  it("moves buttons blocks onto channelData.maxInlineKeyboard and strips presentation", () => {
    const result = canonicalizeMaxPresentationPayload({
      text: "Выбирай",
      presentation: {
        blocks: [
          { type: "text", text: "Выбирай" },
          {
            type: "buttons",
            buttons: [
              { label: "Да", value: "yes" },
              { label: "Сайт", url: "https://max.ru" },
            ],
          },
        ],
      },
    } as any);

    expect(result.presentation).toBeUndefined();
    expect(result.text).toBe("Выбирай");
    expect(result.channelData).toEqual({
      maxInlineKeyboard: [
        [
          { type: "callback", text: "Да", payload: "yes" },
          { type: "link", text: "Сайт", url: "https://max.ru" },
        ],
      ],
    });
  });

  it("builds text from text blocks and the title when the payload has none", () => {
    const result = canonicalizeMaxPresentationPayload({
      presentation: {
        title: "Заказ",
        blocks: [
          { type: "text", text: "Взять заказ #12?" },
          { type: "buttons", buttons: [{ label: "Взять", value: "take" }] },
        ],
      },
    } as any);

    expect(result.text).toBe("Заказ\n\nВзять заказ #12?");
    expect(result.channelData?.maxInlineKeyboard).toEqual([
      [{ type: "callback", text: "Взять", payload: "take" }],
    ]);
  });

  it("uses the control-only fallback when only buttons remain", () => {
    const result = canonicalizeMaxPresentationPayload({
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
      },
    } as any);

    expect(result.text).toBe("Choose an option.");
    expect(result.channelData?.maxInlineKeyboard).toBeDefined();
  });

  it("keeps existing channelData and merges the keyboard in", () => {
    const result = canonicalizeMaxPresentationPayload({
      text: "тихо",
      channelData: { maxNotify: false },
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
      },
    } as any);

    expect(result.channelData).toEqual({
      maxNotify: false,
      maxInlineKeyboard: [[{ type: "callback", text: "OK", payload: "ok" }]],
    });
  });

  it("degrades over-limit keyboards to text without channelData", () => {
    const buttons = Array.from({ length: 100 }, (_, i) => ({ label: `b${i}`, value: `v${i}` }));
    const result = canonicalizeMaxPresentationPayload({
      text: "много кнопок",
      presentation: { blocks: [{ type: "buttons", buttons }] },
    } as any);

    expect(result.channelData).toBeUndefined();
    expect(result.text).toBe("много кнопок");
  });

  it("returns the payload unchanged without a presentation", () => {
    const payload = { text: "plain" } as any;
    expect(canonicalizeMaxPresentationPayload(payload)).toBe(payload);
  });
});
