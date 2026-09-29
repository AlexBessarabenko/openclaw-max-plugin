import { describe, expect, it } from "vitest";
import { alignMarkdownTables } from "./markdown-tables.js";

describe("alignMarkdownTables", () => {
  it("rewrites a pipe table as an aligned monospace block", () => {
    const input = [
      "Детализация:",
      "",
      "| Показатель | Значение |",
      "|------------|----------|",
      "| Продажи | 1 480 000 ₽ |",
      "| Сделок | 47 |",
      "",
      "Что дальше?",
    ].join("\n");
    expect(alignMarkdownTables(input)).toBe(
      [
        "Детализация:",
        "",
        "```",
        "Показатель | Значение",
        "-----------+------------",
        "Продажи    | 1 480 000 ₽",
        "Сделок     | 47",
        "```",
        "",
        "Что дальше?",
      ].join("\n"),
    );
  });

  it("handles tables without edge pipes and with alignment colons", () => {
    const input = ["a | bb", "--- | ---:", "ccc | d"].join("\n");
    expect(alignMarkdownTables(input)).toBe("```\na   | bb\n----+---\nccc | d\n```");
  });

  it("leaves non-table pipe text and fenced content untouched", () => {
    const code = ["```", "| a | b |", "|---|---|", "| 1 | 2 |", "```"].join("\n");
    expect(alignMarkdownTables(code)).toBe(code);
    expect(alignMarkdownTables("fish | chips — просто текст")).toBe(
      "fish | chips — просто текст",
    );
  });

  it("requires a body row", () => {
    const input = ["| a | b |", "|---|---|"].join("\n");
    expect(alignMarkdownTables(input)).toBe(input);
  });

  it("aligns cyrillic cells by display width", () => {
    const input = ["| Имя | V |", "|---|---|", "| Я | 1 |", "| Длинное | 22 |"].join("\n");
    const out = alignMarkdownTables(input);
    const lines = out.split("\n");
    // the "|" column separator sits at the same display column in every
    // content row (the right edge stays ragged — trailing pad is trimmed)
    const contentRows = lines.slice(1, -1).filter((line) => !line.includes("+"));
    const pipeAt = contentRows.map((line) => Array.from(line).indexOf("|"));
    expect(new Set(pipeAt).size).toBe(1);
  });
});
