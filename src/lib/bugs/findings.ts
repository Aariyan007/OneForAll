import { bugFingerprint, verifyEvidence } from "./scan";

// Turns the model's findings for one batch into rows that may be stored, dropping everything that cannot be checked
// against the code: a finding must point at a file of the batch, at real lines, and quote code that is really there.

export type RawFinding = {
  title: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  severityReason: string;
  path: string;
  startLine: number;
  endLine: number;
  description: string;
  evidence: string;
  confidence: number;
  suggestedFix: string;
  validationSteps: string;
};

export type StoredFinding = {
  path: string;
  start_line: number;
  end_line: number;
  title: string;
  description: string;
  category: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  severity_reason: string;
  confidence: number;
  evidence: string;
  suggested_fix: string;
  validation_steps: string;
  fingerprint: string;
};

export type DropCounts = { notInBatch: number; badLines: number; evidenceNotFound: number; duplicate: number };

export async function verifyFindings(
  raw: readonly RawFinding[],
  batchPaths: ReadonlySet<string>,
  readText: (path: string) => Promise<string | null>,
): Promise<{ stored: StoredFinding[]; dropped: DropCounts }> {
  const dropped: DropCounts = { notInBatch: 0, badLines: 0, evidenceNotFound: 0, duplicate: 0 };
  const stored: StoredFinding[] = [];
  const seen = new Set<string>();
  const texts = new Map<string, string | null>();
  for (const finding of raw) {
    if (!batchPaths.has(finding.path)) {
      dropped.notInBatch++;
      continue;
    }
    if (!texts.has(finding.path)) texts.set(finding.path, await readText(finding.path));
    const text = texts.get(finding.path);
    if (text == null) {
      dropped.notInBatch++;
      continue;
    }
    const lines = text.split("\n").length;
    if (finding.startLine < 1 || finding.endLine < finding.startLine || finding.endLine > lines) {
      dropped.badLines++;
      continue;
    }
    if (!verifyEvidence(finding.evidence, text, finding.startLine, finding.endLine)) {
      dropped.evidenceNotFound++;
      continue;
    }
    const fingerprint = bugFingerprint(finding.path, finding.evidence);
    if (seen.has(fingerprint)) {
      dropped.duplicate++;
      continue;
    }
    seen.add(fingerprint);
    stored.push({
      path: finding.path,
      start_line: finding.startLine,
      end_line: finding.endLine,
      title: finding.title.slice(0, 200),
      description: finding.description.slice(0, 2000),
      category: finding.category,
      severity: finding.severity.toUpperCase() as StoredFinding["severity"],
      severity_reason: finding.severityReason.slice(0, 600),
      confidence: Math.round(Math.min(1, Math.max(0, finding.confidence)) * 100) / 100,
      evidence: finding.evidence.replace(/^\s*\d+\|\s?/gm, "").slice(0, 1000),
      suggested_fix: finding.suggestedFix.slice(0, 2000),
      validation_steps: finding.validationSteps.slice(0, 1000),
      fingerprint,
    });
  }
  return { stored, dropped };
}
