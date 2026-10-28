// Validation of an approved fix, computed from the stored patched files. Every check says what it did; a check that
// cannot be done is SKIPPED with the reason, never reported as passed. Tests are never executed by OneForAll.

export type Check = { name: string; status: "PASS" | "FAIL" | "SKIPPED"; detail: string };
export type Validation = { passed: boolean; checks: Check[]; validatedAt: string };

export const MAX_FIX_FILES = 3;
export const MAX_CHANGED_LINES = 200;

export function syntaxAliasFor(path: string): string | null {
  const ext = /\.([A-Za-z]+)$/.exec(path)?.[1]?.toLowerCase();
  const map: Record<string, string> = { ts: "ts", mts: "ts", cts: "ts", tsx: "tsx", js: "js", mjs: "js", cjs: "js", jsx: "jsx", py: "py", java: "java" };
  return ext ? (map[ext] ?? null) : null;
}

export type FileValidationInput = {
  path: string;
  storedHash: string; // hash of the file as it is stored now
  baseHash: string; // hash the patch was made against
  reapplied: { ok: true; patched: string; changedLines: number } | { ok: false; error: string };
  proposedPatched: string;
  syntaxBefore: boolean | null;
  syntaxAfter: boolean | null;
};

export function buildValidation(files: readonly FileValidationInput[], testsToRun: readonly string[], now: Date = new Date()): Validation {
  const checks: Check[] = [];

  const stale = files.filter((f) => f.storedHash !== f.baseHash);
  const mismatched = files.filter((f) => f.storedHash === f.baseHash && (!f.reapplied.ok || f.reapplied.patched !== f.proposedPatched));
  checks.push(
    stale.length > 0
      ? { name: "Patch applies to the stored files", status: "FAIL", detail: `${stale.map((f) => f.path).join(", ")} changed since the fix was proposed.` }
      : mismatched.length > 0
        ? { name: "Patch applies to the stored files", status: "FAIL", detail: `Re-applying the edits to ${mismatched.map((f) => f.path).join(", ")} did not give the proposed result.` }
        : { name: "Patch applies to the stored files", status: "PASS", detail: `${files.length} file(s): the edits apply cleanly and reproduce the proposed content.` },
  );

  for (const f of files) {
    if (f.syntaxAfter === null) {
      checks.push({ name: `Syntax: ${f.path}`, status: "SKIPPED", detail: "No parser for this file type, so syntax was not checked." });
    } else if (f.syntaxAfter) {
      checks.push({ name: `Syntax: ${f.path}`, status: "PASS", detail: "The patched file parses without errors." });
    } else if (f.syntaxBefore === false) {
      checks.push({ name: `Syntax: ${f.path}`, status: "SKIPPED", detail: "The original file already has syntax errors, so this check cannot tell them apart from the patch." });
    } else {
      checks.push({ name: `Syntax: ${f.path}`, status: "FAIL", detail: "The patched file no longer parses." });
    }
  }

  const changed = files.reduce((n, f) => n + (f.reapplied.ok ? f.reapplied.changedLines : 0), 0);
  checks.push(
    files.length > MAX_FIX_FILES || changed > MAX_CHANGED_LINES
      ? { name: "Scope", status: "FAIL", detail: `The fix touches ${files.length} files and ${changed} lines; the limit is ${MAX_FIX_FILES} files and ${MAX_CHANGED_LINES} lines.` }
      : { name: "Scope", status: "PASS", detail: `${files.length} file(s), ${changed} line(s) changed.` },
  );

  checks.push({
    name: "Tests",
    status: "SKIPPED",
    detail: `OneForAll does not run tests. Run them in your own repository before review${testsToRun.length > 0 ? `: ${testsToRun.join("; ")}` : ""}.`,
  });

  return { passed: !checks.some((c) => c.status === "FAIL"), checks, validatedAt: now.toISOString() };
}
