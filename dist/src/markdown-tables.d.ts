/**
 * MAX markdown has no table syntax: a pipe table written by the model renders
 * as raw, misaligned text. This pass finds GitHub-style pipe tables in
 * outbound markdown and rewrites them as aligned monospace ``` blocks.
 *
 * Conservative by design: a block is a table only when a header row with ≥2
 * cells is followed by a dash separator row and at least one body row.
 * Content already inside code fences is left untouched.
 */
/** Rewrite pipe tables in `text` as aligned monospace blocks. */
export declare function alignMarkdownTables(text: string): string;
//# sourceMappingURL=markdown-tables.d.ts.map