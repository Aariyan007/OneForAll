// Deterministic context shaping: numbered excerpts, log and stack-trace compression, JSON extraction. Done in code so
// no model call is spent on mechanical work, and nothing needed to diagnose a problem is summarized away.

export const MAX_EXCERPT_LINES = 400;

function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); // a trailing newline ends the last line
  return lines.map((line) => line.replace(/\r$/, ""));
}

export function lineCount(content: string): number {
  return splitLines(content).length;
}

// Lines startLine..endLine (1-based, inclusive), clamped to the file and to `maxLines`, prefixed "N| " so the model can
// cite exact lines.
export function numberedExcerpt(
  content: string,
  startLine: number,
  endLine: number,
  maxLines: number = MAX_EXCERPT_LINES,
): { text: string; startLine: number; endLine: number; totalLines: number } {
  const lines = splitLines(content);
  const total = lines.length;
  const start = Math.min(Math.max(1, Math.floor(startLine)), Math.max(total, 1));
  const end = Math.min(Math.max(start, Math.floor(endLine)), total, start + maxLines - 1);
  const text = lines
    .slice(start - 1, end)
    .map((line, i) => `${start + i}| ${line}`)
    .join("\n");
  return { text, startLine: start, endLine: end, totalLines: total };
}

export function collapseRepeatedLines(text: string): string {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(lines[i]);
    if (j - i > 1) out.push(`[... previous line repeated ${j - i - 1} more times]`);
    i = j;
  }
  return out.join("\n");
}

const JS_FRAME = /\(?((?:[\w.@-]+\/)*[\w.@-]+\.(?:[cm]?[jt]sx?)):(\d+):\d+\)?/g;
const PY_FRAME = /File "([^"]+)", line (\d+)/g;
const JAVA_FRAME = /\(([\w$]+\.java):(\d+)\)/g;

// Project frames of a stack trace (relative paths only: absolute paths and dependency folders are runtime or library
// code, not the snapshot), in order, without duplicates.
export function stackFrames(text: string): { path: string; line: number }[] {
  const frames: { path: string; line: number }[] = [];
  const seen = new Set<string>();
  for (const pattern of [JS_FRAME, PY_FRAME, JAVA_FRAME]) {
    for (const match of text.matchAll(pattern)) {
      const path = match[1];
      if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("node_modules/") || path.includes("site-packages/")) continue;
      const key = `${path}:${match[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      frames.push({ path, line: Number(match[2]) });
    }
  }
  return frames;
}

// The JSON object in a model reply: the whole reply, or the first ```json fenced block, or the outermost {...}.
export function extractJson(text: string): unknown {
  const candidates: string[] = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value !== null && typeof value === "object") return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
