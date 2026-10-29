// Applies the AI's line-range edits to a stored file and renders the result as a unified diff. Pure. The model never
// supplies the "before" text: it supplies a quote of it, which must equal the lines it wants to replace, so an edit
// can only land where the model has actually read the code.

export type Edit = { path: string; startLine: number; endLine: number; originalQuote: string; replacement: string };

export const MAX_EDIT_LINES = 80;
export const MAX_REPLACEMENT_LINES = 160;

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const stripNumbers = (text: string) => text.split("\n").map((l) => l.replace(/^\s*\d+\|\s?/, "")).join("\n");

function split(text: string): { lines: string[]; eol: string; trailingNewline: boolean } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  return { lines, eol, trailingNewline };
}

export type ApplyResult = { ok: true; patched: string; changedLines: number; edits: Edit[] } | { ok: false; error: string };

export function applyEdits(text: string, edits: readonly Edit[]): ApplyResult {
  if (edits.length === 0) return { ok: false, error: "The fix contains no edits." };
  const { lines, eol, trailingNewline } = split(text);
  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (!Number.isInteger(e.startLine) || !Number.isInteger(e.endLine) || e.startLine < 1 || e.endLine < e.startLine || e.endLine > lines.length) {
      return { ok: false, error: `Edit ${i + 1} points at lines that do not exist (${e.startLine}-${e.endLine} of ${lines.length}).` };
    }
    if (e.endLine - e.startLine + 1 > MAX_EDIT_LINES) return { ok: false, error: `Edit ${i + 1} replaces more than ${MAX_EDIT_LINES} lines.` };
    if (e.replacement.split("\n").length > MAX_REPLACEMENT_LINES) return { ok: false, error: `Edit ${i + 1} adds more than ${MAX_REPLACEMENT_LINES} lines.` };
    if (i > 0 && e.startLine <= sorted[i - 1].endLine) return { ok: false, error: "Edits overlap." };
    const actual = squash(lines.slice(e.startLine - 1, e.endLine).join("\n"));
    if (squash(stripNumbers(e.originalQuote)) !== actual) return { ok: false, error: `Edit ${i + 1} does not quote the code at lines ${e.startLine}-${e.endLine}.` };
  }
  const out: string[] = [];
  let cursor = 0;
  let changed = 0;
  for (const e of sorted) {
    out.push(...lines.slice(cursor, e.startLine - 1));
    const replacement = e.replacement === "" ? [] : e.replacement.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    out.push(...replacement);
    changed += Math.max(e.endLine - e.startLine + 1, replacement.length);
    cursor = e.endLine;
  }
  out.push(...lines.slice(cursor));
  return { ok: true, patched: out.join(eol) + (trailingNewline ? eol : ""), changedLines: changed, edits: sorted };
}

// Unified diff of one file from the edits that produced it (3 lines of context; hunks whose context touches are merged).
export function unifiedDiff(path: string, before: string, edits: readonly Edit[], context = 3): string {
  const { lines } = split(before);
  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine);
  const groups: Edit[][] = [];
  for (const e of sorted) {
    const last = groups[groups.length - 1];
    if (last && e.startLine - context <= last[last.length - 1].endLine + context + 1) last.push(e);
    else groups.push([e]);
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let delta = 0;
  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    const from = Math.max(1, first.startLine - context);
    const to = Math.min(lines.length, last.endLine + context);
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let line = from;
    for (const e of group) {
      for (; line < e.startLine; line++) {
        body.push(` ${lines[line - 1]}`);
        oldCount++;
        newCount++;
      }
      for (; line <= e.endLine; line++) {
        body.push(`-${lines[line - 1]}`);
        oldCount++;
      }
      const replacement = e.replacement === "" ? [] : e.replacement.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
      for (const r of replacement) {
        body.push(`+${r}`);
        newCount++;
      }
    }
    for (; line <= to; line++) {
      body.push(` ${lines[line - 1]}`);
      oldCount++;
      newCount++;
    }
    out.push(`@@ -${from},${oldCount} +${from + delta},${newCount} @@`, ...body);
    delta += newCount - oldCount;
  }
  return `${out.join("\n")}\n`;
}
