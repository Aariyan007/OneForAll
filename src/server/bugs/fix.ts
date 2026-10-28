import "server-only";
import { createHash } from "node:crypto";
import { applyEdits, unifiedDiff, type Edit } from "@/lib/bugs/patch";
import { buildValidation, MAX_FIX_FILES, syntaxAliasFor, type FileValidationInput } from "@/lib/bugs/validate";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";
import type { BugFixOutput } from "@/server/ai/jobs";
import { executeRun, startRun } from "@/server/ai/service";
import { createSnapshotReader } from "@/server/ai/supabase";
import { checkSyntax } from "@/server/ai/syntax";

// The approval-based fix workflow as the signed-in user. The AI produces a plan and edits; this module turns them into
// a verified patch against the STORED file text (the snapshot is never modified), stores it for approval through
// propose_bug_fix, and after approval re-validates and records the result through record_bug_fix_validation.
// Nothing here writes to a git provider.

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Failure = { ok: false; status: number; error: string };

export type PlanResult = { ok: true; fixId: string; version: number; confidence: string } | Failure;

export async function generateFix(
  bugId: string,
  projectId: string,
  signal: AbortSignal,
  feedback?: string,
): Promise<PlanResult> {
  const supabase = await createClient();
  const { data: bug } = await supabase
    .from("repository_bugs")
    .select("id, project_id, snapshot_id, file_path, start_line, end_line, title, description, category, severity, evidence, suggested_fix, status")
    .eq("id", bugId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!bug) return { ok: false, status: 404, error: "Not found." };
  if (bug.status !== "IN_PROGRESS") return { ok: false, status: 409, error: "Start work on the bug before asking for a fix." };

  const input = {
    path: bug.file_path,
    startLine: bug.start_line,
    endLine: bug.end_line,
    title: bug.title,
    description: bug.description,
    category: bug.category,
    severity: bug.severity,
    evidence: bug.evidence,
    suggestedFix: bug.suggested_fix,
    ...(feedback ? { feedback: feedback.slice(0, 1000) } : {}),
  };
  const started = await startRun(bug.snapshot_id, "bug_fix_plan", input);
  if (!started.ok) return { ok: false, status: started.status, error: started.error };
  const outcome = await executeRun({ ...started, projectId, snapshotId: bug.snapshot_id, job: "bug_fix_plan", input }, signal, () => undefined);
  if (outcome.status !== "completed" || !outcome.result) {
    return { ok: false, status: 502, error: outcome.error?.message ?? "The AI could not produce a fix. Try again." };
  }
  const output = outcome.result as BugFixOutput;

  // Group the edits per file; every file must be in the snapshot with stored text and the edits must quote the real code.
  const reader = await createSnapshotReader(bug.snapshot_id, projectId);
  const manifest = new Map((await reader.listFiles()).map((f) => [f.path, f]));
  const byPath = new Map<string, Edit[]>();
  for (const edit of output.edits) byPath.set(edit.path, [...(byPath.get(edit.path) ?? []), edit]);
  if (byPath.size > MAX_FIX_FILES) return { ok: false, status: 422, error: `The proposed fix touches more than ${MAX_FIX_FILES} files, so it was discarded. Try again.` };

  const { data: hashes } = await supabase.from("repository_files").select("path, content_hash").eq("snapshot_id", bug.snapshot_id).in("path", [...byPath.keys()]);
  const hashByPath = new Map((hashes ?? []).map((h) => [h.path, h.content_hash]));

  const files: { path: string; base_hash: string; patched_content: string; patched_hash: string }[] = [];
  const diffs: string[] = [];
  const editsOut: Edit[] = [];
  for (const [path, edits] of byPath) {
    const text = manifest.get(path)?.hasText ? await reader.readText(path) : null;
    const baseHash = hashByPath.get(path);
    if (text === null || !baseHash) return { ok: false, status: 422, error: `The proposed fix edits ${path}, which is not stored in this snapshot. It was discarded.` };
    const applied = applyEdits(text, edits);
    if (!applied.ok) return { ok: false, status: 422, error: `The proposed fix was rejected: ${applied.error} Try again.` };
    files.push({ path, base_hash: baseHash, patched_content: applied.patched, patched_hash: sha256(applied.patched) });
    diffs.push(unifiedDiff(path, text, applied.edits));
    editsOut.push(...applied.edits);
  }

  const plan = { summary: output.summary, steps: output.steps, risks: output.risks, testsToRun: output.testsToRun, confidence: output.confidence, missingContext: output.missingContext };
  const { data: fixId, error } = await supabase.rpc("propose_bug_fix", {
    p_bug_id: bug.id,
    p_plan: plan as unknown as Json,
    p_edits: editsOut as unknown as Json,
    p_diff: diffs.join(""),
    p_files: files as unknown as Json,
    p_model: outcome.model ?? "unknown",
    p_run_id: started.runId,
  });
  if (error || !fixId) {
    if (error?.code === "42501") return { ok: false, status: 403, error: "Only the assignee or an admin can propose a fix." };
    if (error?.code === "55000") return { ok: false, status: 409, error: error.message };
    return { ok: false, status: 500, error: "The fix could not be stored." };
  }
  const { data: row } = await supabase.from("repository_bug_fixes").select("version").eq("id", fixId).maybeSingle();
  return { ok: true, fixId, version: row?.version ?? 1, confidence: output.confidence };
}

export type DecisionResult = { ok: true; status: string; validationPassed?: boolean } | Failure;

export async function decideFix(fixId: string, decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES", note: string): Promise<DecisionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_bug_fix", { p_fix_id: fixId, p_decision: decision, p_note: note });
  if (error) return mapError(error.code, error.message);
  if (decision !== "APPROVE") return { ok: true, status: decision === "REJECT" ? "REJECTED" : "CHANGES_REQUESTED" };
  return applyApprovedFix(fixId);
}

// Re-validates the approved patch against what is stored NOW and records the result (which applies or sends back).
export async function applyApprovedFix(fixId: string): Promise<DecisionResult> {
  const supabase = await createClient();
  const { data: fix } = await supabase.from("repository_bug_fixes").select("id, bug_id, edits, plan, status").eq("id", fixId).maybeSingle();
  if (!fix) return { ok: false, status: 404, error: "Not found." };
  const { data: bug } = await supabase.from("repository_bugs").select("snapshot_id, project_id").eq("id", fix.bug_id).maybeSingle();
  const { data: patchedFiles } = await supabase.from("repository_bug_fix_files").select("path, base_hash, patched_content").eq("fix_id", fixId);
  if (!bug || !patchedFiles) return { ok: false, status: 404, error: "Not found." };

  const reader = await createSnapshotReader(bug.snapshot_id, bug.project_id);
  const { data: stored } = await supabase.from("repository_files").select("path, content_hash").eq("snapshot_id", bug.snapshot_id).in("path", patchedFiles.map((f) => f.path));
  const storedHash = new Map((stored ?? []).map((s) => [s.path, s.content_hash]));
  const allEdits = fix.edits as unknown as Edit[];

  const inputs: FileValidationInput[] = [];
  for (const file of patchedFiles) {
    const text = (await reader.readText(file.path)) ?? "";
    const alias = syntaxAliasFor(file.path);
    inputs.push({
      path: file.path,
      storedHash: storedHash.get(file.path) ?? "",
      baseHash: file.base_hash,
      reapplied: applyEdits(text, allEdits.filter((e) => e.path === file.path)),
      proposedPatched: file.patched_content,
      syntaxBefore: alias ? await checkSyntax(alias, text) : null,
      syntaxAfter: alias ? await checkSyntax(alias, file.patched_content) : null,
    });
  }
  const tests = ((fix.plan as { testsToRun?: string[] }).testsToRun ?? []).filter((t) => typeof t === "string");
  const validation = buildValidation(inputs, tests);
  const { error } = await supabase.rpc("record_bug_fix_validation", { p_fix_id: fixId, p_validation: validation as unknown as Json });
  if (error) return mapError(error.code, error.message);
  return { ok: true, status: validation.passed ? "APPLIED" : "VALIDATION_FAILED", validationPassed: validation.passed };
}

function mapError(code: string | undefined, message: string): Failure {
  if (code === "42501") return { ok: false, status: 403, error: "Only the assignee or an admin can do that." };
  if (code === "55000") return { ok: false, status: 409, error: message };
  if (code === "22023") return { ok: false, status: 422, error: message };
  return { ok: false, status: 500, error: "The request failed. Try again." };
}

export async function transitionBug(bugId: string, to: string, note: string): Promise<{ ok: true } | Failure> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("transition_bug", { p_bug_id: bugId, p_to: to, p_note: note });
  return error ? mapError(error.code, error.message) : { ok: true };
}

export async function commentOnBug(bugId: string, body: string): Promise<{ ok: true } | Failure> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_bug_comment", { p_bug_id: bugId, p_body: body });
  return error ? mapError(error.code, error.message) : { ok: true };
}
