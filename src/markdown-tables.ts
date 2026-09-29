/**
 * MAX markdown has no table syntax: a pipe table written by the model renders
 * as raw, misaligned text. This pass finds GitHub-style pipe tables in
 * outbound markdown and rewrites them as aligned monospace ``` blocks.
 *
 * Conservative by design: a block is a table only when a header row with ≥2
 * cells is followed by a dash separator row and at least one body row.
 * Content already inside code fences is left untouched.
 */

const SEPARATOR_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/u;

function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.map((cell) => cell.trim());
}

function isTableHeader(line: string): boolean {
  if (!line.includes("|")) return false;
  return splitRow(line).length >= 2;
}

/** Align one parsed table into a fenced monospace block. */
function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((cell, column) =>
    Math.max(
      Array.from(cell).length,
      ...rows.map((row) => Array.from(row[column] ?? "").length),
      1,
    ),
  );
  const pad = (cells: string[]) =>
    cells
      .map(
        (cell, column) => cell + " ".repeat(Math.max(0, widths[column] - Array.from(cell).length)),
      )
      .join(" | ")
      .trimEnd();
  const lines = [pad(header), widths.map((width) => "-".repeat(width)).join("-+-"), ...rows.map(pad)];
  return ["```", ...lines, "```"].join("\n");
}

/** Rewrite pipe tables in `text` as aligned monospace blocks. */
export function alignMarkdownTables(text: string): string {
  if (!text.includes("|") || !text.includes("-")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (
      !inFence &&
      i + 2 < lines.length &&
      isTableHeader(line) &&
      SEPARATOR_RE.test(lines[i + 1]) &&
      lines[i + 2].includes("|")
    ) {
      const header = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        rows.push(splitRow(lines[j]));
        j++;
      }
      out.push(renderTable(header, rows));
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
