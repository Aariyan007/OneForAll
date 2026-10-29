import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getMyRepository } from "@/server/repositories/queries";
import { getProjectContext } from "@/server/requirements/queries";
import { aiConfigured } from "@/server/ai/service";
import type { Validation } from "@/lib/bugs/validate";

// Everything the bug workspace shows, read as the signed-in user (RLS limits every row to the projects they can see).

export type BugEvent = { id: number; type: string; fromStatus: string | null; toStatus: string | null; details: Record<string, unknown>; at: string; actor: string };
export type FixPlan = { summary: string; steps: string[]; risks: string[]; testsToRun: string[]; confidence: string; missingContext: string[] };
export type FixView = {
  id: string;
  version: number;
  status: string;
  plan: FixPlan;
  diff: string;
  validation: Validation | null;
  model: string | null;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  files: string[];
};

export async function getBugDetail(organizationId: string, departmentId: string, teamId: string, projectId: string, bugId: string) {
  const context = await getProjectContext(organizationId, departmentId, teamId, projectId);
  if (!context) return null;
  const supabase = await createClient();
  const { data: bug } = await supabase.from("repository_bugs").select("*").eq("id", bugId).eq("project_id", context.project.id).maybeSingle();
  if (!bug) return null;
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id ?? null;

  const { data: eventRows } = await supabase.from("repository_bug_events").select("id, type, from_status, to_status, details, created_at, actor_id").eq("bug_id", bug.id).order("id", { ascending: true }).limit(300);
  const { data: fixRows } = await supabase.from("repository_bug_fixes").select("id, version, status, plan, diff, validation, model, decision_note, decided_by, decided_at, created_at").eq("bug_id", bug.id).order("version", { ascending: false }).limit(10);
  const fixIds = (fixRows ?? []).map((f) => f.id);
  const { data: fileRows } = fixIds.length > 0 ? await supabase.from("repository_bug_fix_files").select("fix_id, path").in("fix_id", fixIds) : { data: [] as { fix_id: string; path: string }[] };

  const people = [...new Set([...(eventRows ?? []).map((e) => e.actor_id), ...(fixRows ?? []).map((f) => f.decided_by), bug.assigned_to, bug.assigned_by].filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (people.length > 0) {
    const { data: profiles } = await supabase.from("profiles").select("id, display_name, email").in("id", people);
    for (const p of profiles ?? []) names.set(p.id, p.display_name?.trim() || p.email || "Someone");
  }
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? "Someone") : "System");

  const events: BugEvent[] = (eventRows ?? []).map((e) => ({
    id: e.id,
    type: e.type,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    details: (e.details ?? {}) as Record<string, unknown>,
    at: e.created_at,
    actor: nameOf(e.actor_id),
  }));
  const fixes: FixView[] = (fixRows ?? []).map((f) => ({
    id: f.id,
    version: f.version,
    status: f.status,
    plan: f.plan as unknown as FixPlan,
    diff: f.diff,
    validation: (f.validation as unknown as Validation | null) ?? null,
    model: f.model,
    decisionNote: f.decision_note,
    decidedBy: f.decided_by ? nameOf(f.decided_by) : null,
    decidedAt: f.decided_at,
    createdAt: f.created_at,
    files: (fileRows ?? []).filter((r) => r.fix_id === f.id).map((r) => r.path),
  }));

  const repository = await getMyRepository(context.project.id);
  const role = context.organization.role;
  const isAdmin = role === "OWNER" || role === "ADMIN";
  const isAssignee = !!userId && bug.assigned_to === userId;
  return {
    ...context,
    repository,
    bug,
    assigneeName: bug.assigned_to ? nameOf(bug.assigned_to) : null,
    assignedByName: bug.assigned_by ? nameOf(bug.assigned_by) : null,
    events,
    fixes,
    userId,
    isAdmin,
    isAssignee,
    canWork: isAdmin || isAssignee,
    aiConfigured: aiConfigured(),
  };
}

export type CodeWindow = { path: string; language: string | null; lines: { n: number; text: string }[]; startLine: number; endLine: number; total: number; highlightFrom: number; highlightTo: number } | null;

// The lines around the bug from the stored text, numbered like the AI saw them.
export async function loadBugCode(bug: { snapshot_id: string; file_path: string; start_line: number; end_line: number }): Promise<CodeWindow> {
  const supabase = await createClient();
  const { data: file } = await supabase.from("repository_files").select("id, language").eq("snapshot_id", bug.snapshot_id).eq("path", bug.file_path).maybeSingle();
  if (!file) return null;
  const { data: content } = await supabase.from("repository_file_contents").select("content").eq("file_id", file.id).maybeSingle();
  if (!content) return null;
  const all = content.content.split("\n");
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const from = Math.max(1, bug.start_line - 14);
  const to = Math.min(all.length, bug.end_line + 30, from + 119);
  return {
    path: bug.file_path,
    language: file.language,
    lines: all.slice(from - 1, to).map((text, i) => ({ n: from + i, text: text.replace(/\r$/, "") })),
    startLine: from,
    endLine: to,
    total: all.length,
    highlightFrom: bug.start_line,
    highlightTo: bug.end_line,
  };
}

export type SubgraphNode = { id: string; kind: "bug" | "file" | "symbol" | "fix"; label: string; detail?: string; path?: string; bugs?: number; line?: number };
export type SubgraphEdge = { from: string; to: string; type: "CONTAINS" | "IMPORTS" | "ASSOCIATED_WITH" | "FIXED_BY" };
export type BugSubgraph = { nodes: SubgraphNode[]; edges: SubgraphEdge[]; note: string | null };

const NEIGHBOUR_CAP = 6;

// The task-specific graph: the bug, its file, the symbols whose lines contain it, the files it imports and the files that
// import it (from the stored import links), other open bugs in those files, and the applied fix. Only relations that are
// stored are drawn; nothing is inferred.
export async function loadBugSubgraph(bug: { id: string; snapshot_id: string; file_path: string; start_line: number; end_line: number; title: string; severity: string }, fixes: FixView[]): Promise<BugSubgraph> {
  const supabase = await createClient();
  const nodes: SubgraphNode[] = [{ id: "bug", kind: "bug", label: bug.title, detail: `${bug.severity} · lines ${bug.start_line}-${bug.end_line}` }];
  const edges: SubgraphEdge[] = [];
  const { data: file } = await supabase.from("repository_files").select("id, path").eq("snapshot_id", bug.snapshot_id).eq("path", bug.file_path).maybeSingle();
  if (!file) return { nodes, edges, note: "The file of this bug is not part of the stored snapshot." };

  nodes.push({ id: `f:${file.path}`, kind: "file", label: file.path.split("/").pop() ?? file.path, path: file.path, detail: file.path });
  edges.push({ from: "bug", to: `f:${file.path}`, type: "ASSOCIATED_WITH" });

  const { data: analysis } = await supabase.from("repository_structure_analyses").select("id").eq("snapshot_id", bug.snapshot_id).eq("status", "COMPLETED").maybeSingle();
  let note: string | null = null;
  if (analysis) {
    const { data: symbols } = await supabase.rpc("repository_graph_symbols", { p_analysis_id: analysis.id, p_file_id: file.id, p_limit: 300 });
    const containing = (symbols ?? []).filter((s) => s.kind !== "MODULE" && s.start_line + 1 <= bug.end_line && s.end_line + 1 >= bug.start_line).sort((a, b) => b.start_line - a.start_line).slice(0, 4);
    for (const s of containing) {
      nodes.push({ id: `s:${s.id}`, kind: "symbol", label: s.name, detail: `${s.kind} · lines ${s.start_line + 1}-${s.end_line + 1}`, path: file.path, line: s.start_line + 1 });
      edges.push({ from: `f:${file.path}`, to: `s:${s.id}`, type: "CONTAINS" }, { from: "bug", to: `s:${s.id}`, type: "ASSOCIATED_WITH" });
    }
  } else note = "The structure analysis of this snapshot is not completed, so symbols are not shown.";

  const { data: outgoing } = await supabase.from("repository_file_edges").select("target_file_id").eq("source_file_id", file.id).limit(NEIGHBOUR_CAP);
  const { data: incoming } = await supabase.from("repository_file_edges").select("source_file_id").eq("target_file_id", file.id).limit(NEIGHBOUR_CAP);
  const neighbourIds = [...new Set([...(outgoing ?? []).map((e) => e.target_file_id), ...(incoming ?? []).map((e) => e.source_file_id)])];
  if (neighbourIds.length > 0) {
    const { data: neighbours } = await supabase.from("repository_files").select("id, path").in("id", neighbourIds);
    const byId = new Map((neighbours ?? []).map((n) => [n.id, n.path]));
    const { data: others } = await supabase.from("repository_bugs").select("file_path").eq("snapshot_id", bug.snapshot_id).neq("id", bug.id).in("file_path", [...byId.values()]).not("status", "in", "(RESOLVED,REJECTED,CANCELLED)");
    const bugCount = new Map<string, number>();
    for (const o of others ?? []) bugCount.set(o.file_path, (bugCount.get(o.file_path) ?? 0) + 1);
    for (const [id, path] of byId) {
      void id;
      nodes.push({ id: `f:${path}`, kind: "file", label: path.split("/").pop() ?? path, path, detail: path, bugs: bugCount.get(path) ?? 0 });
    }
    for (const e of outgoing ?? []) if (byId.has(e.target_file_id)) edges.push({ from: `f:${file.path}`, to: `f:${byId.get(e.target_file_id)}`, type: "IMPORTS" });
    for (const e of incoming ?? []) if (byId.has(e.source_file_id)) edges.push({ from: `f:${byId.get(e.source_file_id)}`, to: `f:${file.path}`, type: "IMPORTS" });
  }

  const applied = fixes.find((f) => f.status === "APPLIED");
  if (applied) {
    nodes.push({ id: "fix", kind: "fix", label: `Fix v${applied.version}`, detail: `Applied; validation ${applied.validation?.passed ? "passed" : "not passed"}` });
    edges.push({ from: "bug", to: "fix", type: "FIXED_BY" });
  }
  return { nodes, edges, note };
}
