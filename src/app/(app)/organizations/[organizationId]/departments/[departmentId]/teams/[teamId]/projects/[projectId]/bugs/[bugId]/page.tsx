import Link from "next/link";
import { notFound } from "next/navigation";
import { AssignPanel, CommentBox, FixWorkflow, Panel } from "@/components/bugs/bug-actions";
import { BugSeverityBadge, BugStatusBadge, categoryLabel } from "@/components/bugs/badges";
import { BugSubgraphView } from "@/components/bugs/bug-subgraph";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { formatDateTime } from "@/components/ui/data";
import { IconAlert, IconArrowLeft } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { cx } from "@/lib/cx";
import { BUG_STATUS_LABELS, type BugSeverity, type BugStatus } from "@/lib/bugs/model";
import { getBugDetail, loadBugCode, loadBugSubgraph, type BugEvent } from "@/server/bugs/detail";

export const metadata = { title: "Bug · OneForAll" };

const EVENT_TEXT: Record<string, string> = {
  detected: "detected by the AI scan",
  rescanned: "seen again by a later scan",
  reopened_by_scan: "reopened because a later scan found it again",
  assigned: "assigned",
  unassigned: "unassigned",
  status_changed: "changed the status",
  comment: "commented",
  fix_proposed: "AI fix proposed",
  awaiting_approval: "fix awaiting approval",
  fix_approved: "approved the fix",
  fix_rejected: "rejected the fix",
  fix_changes_requested: "requested changes to the fix",
  fix_applied: "fix applied to the working copy",
  fix_validation_failed: "fix failed validation",
};

function describe(e: BugEvent): string {
  const base = EVENT_TEXT[e.type] ?? e.type.replace(/_/g, " ");
  const label = (s: string | null) => (s && s in BUG_STATUS_LABELS ? BUG_STATUS_LABELS[s as BugStatus] : s);
  if (e.type === "status_changed") return `${base}: ${label(e.fromStatus)} → ${label(e.toStatus)}`;
  if (e.type === "assigned") return `${base} (${String(e.details.source ?? "").toLowerCase()})`;
  return base;
}

export default async function BugPage({
  params,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/bugs/[bugId]">) {
  const { organizationId, departmentId, teamId, projectId, bugId } = await params;
  const data = await getBugDetail(organizationId, departmentId, teamId, projectId, bugId);
  // 404 for malformed, mismatched, cross-tenant or not-permitted paths alike.
  if (!data) notFound();
  const { organization, department, team, project, bug } = data;
  const projectPath = `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}`;
  const bugsPath = `${projectPath}/bugs`;
  const filesUrl = `${projectPath}/repository/snapshots/${bug.snapshot_id}/files`;
  const [code, graph] = await Promise.all([loadBugCode(bug), loadBugSubgraph(bug, data.fixes)]);
  const severity = bug.severity as BugSeverity;

  return (
    <PageBody>
      <PageHeader
        crumbs={[{ label: project.name, href: projectPath }, { label: "Bugs", href: bugsPath }, { label: bug.title }]}
        icon={<IconAlert size={18} />}
        title={bug.title}
        description={
          <span className="font-mono text-[12.5px]">
            {bug.file_path}:{bug.start_line}
            {bug.end_line > bug.start_line ? `-${bug.end_line}` : ""}
          </span>
        }
        badges={
          <>
            <BugSeverityBadge severity={severity} />
            <BugStatusBadge status={bug.status} />
            <Badge tone="muted">{categoryLabel(bug.category)}</Badge>
            <Badge tone="neutral">{Math.round(Number(bug.confidence) * 100)}% confidence</Badge>
          </>
        }
        actions={
          <ButtonLink href={bugsPath} variant="secondary">
            <IconArrowLeft size={15} />
            All bugs
          </ButtonLink>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)]">
        {/* 1. Bug details */}
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Bug details">
            <div className="space-y-3 text-[13px]">
              <p className="text-fg-2">{bug.description}</p>
              <div>
                <h3 className="text-[12px] font-medium text-fg">Why this severity</h3>
                <p className="text-fg-2">{bug.severity_reason}</p>
              </div>
              <div>
                <h3 className="text-[12px] font-medium text-fg">Evidence (quoted from the code)</h3>
                <pre className="mt-1 overflow-auto rounded-lg border border-border bg-bg-subtle p-2 font-mono text-[12px] text-fg-2">{bug.evidence}</pre>
              </div>
              {bug.suggested_fix && (
                <div>
                  <h3 className="text-[12px] font-medium text-fg">Suggested fix (from the scan)</h3>
                  <p className="text-fg-2">{bug.suggested_fix}</p>
                </div>
              )}
              {bug.validation_steps && (
                <div>
                  <h3 className="text-[12px] font-medium text-fg">How to validate</h3>
                  <p className="text-fg-2">{bug.validation_steps}</p>
                </div>
              )}
              <p className="text-[12px] text-fg-3">
                Found {formatDateTime(bug.created_at)} · seen in {bug.times_seen} scan{bug.times_seen === 1 ? "" : "s"}
              </p>
            </div>
          </Panel>
          <Panel title="Assignment">
            <AssignPanel
              bugId={bug.id}
              assignUrl={`${bugsPath}/assign`}
              status={bug.status}
              isAdmin={data.isAdmin}
              current={data.assigneeName ? { name: data.assigneeName, source: bug.assignment_source, reason: bug.assignment_reason } : null}
            />
          </Panel>
          <Panel title="History and comments">
            <ol className="space-y-2 text-[12.5px]">
              {data.events.map((e) => (
                <li key={e.id} className="border-l-2 border-border pl-3">
                  <p className="text-fg-2">
                    <span className="font-medium text-fg">{e.actor}</span> {describe(e)}
                    <span className="ml-2 text-fg-3">{formatDateTime(e.at)}</span>
                  </p>
                  {typeof e.details.note === "string" && e.details.note && <p className="text-fg-3">{e.details.note}</p>}
                  {typeof e.details.body === "string" && <p className="text-fg-2">{e.details.body}</p>}
                  {e.type === "assigned" && typeof e.details.reason === "string" && e.details.reason && <p className="text-fg-3">{e.details.reason}</p>}
                </li>
              ))}
            </ol>
            <div className="mt-3">
              <CommentBox actionUrl={`${bugsPath}/${bug.id}/actions`} />
            </div>
          </Panel>
        </div>

        {/* 2. Code and subgraph */}
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Code">
            {code ? (
              <>
                <div className="mb-2 flex items-center justify-between text-[12px] text-fg-3">
                  <span className="font-mono">
                    {code.path} · lines {code.startLine}-{code.endLine} of {code.total}
                  </span>
                  <Link href={`${filesUrl}?${new URLSearchParams({ path: code.path, from: String(code.highlightFrom), to: String(code.highlightTo) })}`} className="text-accent underline underline-offset-2">
                    Open full file
                  </Link>
                </div>
                <pre className="max-h-[420px] overflow-auto rounded-lg border border-border bg-bg-subtle py-1 font-mono text-[12px] leading-5" aria-label="Code around the bug">
                  {code.lines.map((l) => {
                    const hit = l.n >= code.highlightFrom && l.n <= code.highlightTo;
                    return (
                      <span key={l.n} id={`L${l.n}`} className={cx("flex px-2", hit ? "border-l-2 border-danger bg-danger/15" : "border-l-2 border-transparent")}>
                        <span className="mr-3 w-9 shrink-0 select-none text-right text-fg-3">{l.n}</span>
                        <span className="whitespace-pre text-fg">{l.text || " "}</span>
                      </span>
                    );
                  })}
                </pre>
              </>
            ) : (
              <p className="text-[13px] text-fg-3">The source text of this file is not stored, so it cannot be shown.</p>
            )}
          </Panel>
          <Panel title="Task graph">
            <BugSubgraphView graph={graph} filesUrl={filesUrl} centerPath={bug.file_path} />
          </Panel>
        </div>

        {/* 3. AI fix plan and approval */}
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Fix workflow">
            <FixWorkflow
              actionUrl={`${bugsPath}/${bug.id}/actions`}
              downloadUrl={`${bugsPath}/${bug.id}/actions`}
              status={bug.status}
              canWork={data.canWork}
              isAdmin={data.isAdmin}
              isAssignee={data.isAssignee}
              aiConfigured={data.aiConfigured}
              fixes={data.fixes}
            />
          </Panel>
        </div>
      </div>
    </PageBody>
  );
}
