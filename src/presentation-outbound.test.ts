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
          { type: "callback", text: "Да", payload: "mxcb1:yes" },
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

    expect(result.text).toBe("**Заказ**\n\nВзять заказ #12?");
    expect(result.channelData?.maxInlineKeyboard).toEqual([
      [{ type: "callback", text: "Взять", payload: "mxcb1:take" }],
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
      maxInlineKeyboard: [[{ type: "callback", text: "OK", payload: "mxcb1:ok" }]],
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

  it("prefixes a toned title with the tone emoji", () => {
    const result = canonicalizeMaxPresentationPayload({
      presentation: {
        title: "Отчёт готов",
        tone: "success",
        blocks: [{ type: "text", text: "Собрано 12 строк." }],
      },
    } as any);
    expect(result.text).toBe("✅ **Отчёт готов**\n\nСобрано 12 строк.");
  });

  it("renders tables as aligned monospace blocks", () => {
    const result = canonicalizeMaxPresentationPayload({
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Продажи",
            headers: ["Месяц", "Сумма"],
            rows: [
              ["Янв", 10],
              ["Февраль", 200],
            ],
          },
        ],
      },
    } as any);
    expect(result.text).toBe(
      "**Продажи**\n```\nМесяц   | Сумма\n--------+------\nЯнв     | 10\nФевраль | 200\n```",
    );
  });

  it("renders select options as callback buttons with enveloped payloads", () => {
    const result = canonicalizeMaxPresentationPayload({
      presentation: {
        blocks: [
          {
            type: "select",
            placeholder: "Выбери язык",
            options: [
              { label: "Русский", value: "ru" },
              { label: "English", value: "en" },
              { label: "Deutsch", value: "de" },
            ],
          },
        ],
      },
    } as any);
    expect(result.text).toBe("_Выбери язык_");
    expect(result.channelData?.maxInlineKeyboard).toEqual([
      [
        { type: "callback", text: "Русский", payload: "mxcb1:ru" },
        { type: "callback", text: "English", payload: "mxcb1:en" },
      ],
      [{ type: "callback", text: "Deutsch", payload: "mxcb1:de" }],
    ]);
  });

  it("encodes approval and question actions into private envelopes", () => {
    const result = canonicalizeMaxPresentationPayload({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Разрешить",
                action: { type: "approval", approvalId: "ap1", approvalKind: "exec", decision: "allow-once" },
              },
              {
                label: "Запретить",
                action: { type: "approval", approvalId: "ap1", approvalKind: "exec", decision: "deny" },
              },
            ],
          },
        ],
      },
    } as any);
    expect(result.channelData?.maxInlineKeyboard).toEqual([
      [
        { type: "callback", text: "Разрешить", payload: "mxa1:e:o:ap1" },
        { type: "callback", text: "Запретить", payload: "mxa1:e:d:ap1" },
      ],
    ]);
  });

  it("replaces core fallback text instead of duplicating it", () => {
    const result = canonicalizeMaxPresentationPayload({
      text: "Заголовок\n\nТекст блока",
      presentationTextMode: "fallback",
      presentation: {
        title: "Заголовок",
        blocks: [{ type: "text", text: "Текст блока" }],
      },
    } as any);
    expect(result.text).toBe("**Заголовок**\n\nТекст блока");
  });
});
