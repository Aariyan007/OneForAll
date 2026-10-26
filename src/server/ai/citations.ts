import type { Citation } from "./types";

// A model's citations are claims, not facts. Keep only those that point at a file of the snapshot and at lines that
// exist in it; everything else is dropped and counted so the UI can say so.
export function validateCitations(
  citations: readonly Citation[],
  lineCounts: ReadonlyMap<string, number>,
): { valid: Citation[]; dropped: number } {
  const valid: Citation[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const citation of citations) {
    const total = lineCounts.get(citation.path);
    const ok =
      total !== undefined &&
      Number.isInteger(citation.startLine) &&
      Number.isInteger(citation.endLine) &&
      citation.startLine >= 1 &&
      citation.endLine >= citation.startLine &&
      citation.endLine <= total;
    if (!ok) {
      dropped++;
      continue;
    }
    const key = `${citation.path}:${citation.startLine}:${citation.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ path: citation.path, startLine: citation.startLine, endLine: citation.endLine });
  }
  return { valid, dropped };
}
