import Link from "next/link";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, MetricCard, formatDateTime } from "@/components/ui/data";
import { IconArrowRight, IconBranch, IconCommit, IconNetwork, IconPlus } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status";
import { getRepositoryContext, listSnapshots } from "@/server/repository-snapshots/queries";
import { STATUS_LABELS } from "@/server/repository-snapshots/schema";
import { getAnalysisStatuses } from "@/server/repository-structure/queries";

export const metadata = { title: "Snapshots · OneForAll" };

export default async function SnapshotsPage({
  params,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/repository/snapshots">) {
  const { organizationId, departmentId, teamId, projectId } = await params;
  const context = await getRepositoryContext(organizationId, departmentId, teamId, projectId);
  // 404 for malformed, mismatched, cross-tenant, not-permitted or repository-less paths alike (no existence leak).
  if (!context) notFound();
  const { organization, department, team, project, repository, canManage } = context;

  const snapshots = await listSnapshots(repository.id);
  // The graph link is offered only where a completed structure analysis exists.
  const analysisStatus = await getAnalysisStatuses(snapshots.map((s) => s.id));
  const projectPath = `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}`;
  const teamsHref = `/organizations/${organization.id}/departments/${department.id}/teams`;
  const completed = snapshots.filter((s) => s.status === "COMPLETED").length;
  const failed = snapshots.filter((s) => s.status === "FAILED").length;

  return (
    <PageBody>
      <PageHeader
        crumbs={[
          { label: team.name, href: `${teamsHref}/${team.id}/projects` },
          { label: project.name, href: projectPath },
          { label: "Repository", href: `${projectPath}#repository` },
          { label: "Snapshots" },
        ]}
        icon={<IconCommit size={18} />}
        title="Snapshots"
        description={
          <span className="inline-flex items-center gap-1.5">
            <IconBranch size={14} className="text-fg-3" />
            {repository.owner} / {repository.name}
          </span>
        }
        actions={
          /* UI hint only. The database enforces who may actually create snapshots. */
          canManage && (
            <ButtonLink href={`${projectPath}/repository/snapshots/new`} variant="primary">
              <IconPlus size={15} />
              Create snapshot
            </ButtonLink>
          )
        }
      />

      {snapshots.length === 0 ? (
        <EmptyState
          icon={<IconCommit size={20} />}
          title="No snapshots available"
          description="A snapshot records this repository at a specific commit so it can be analysed."
          action={
            canManage && (
              <ButtonLink href={`${projectPath}/repository/snapshots/new`} variant="primary">
                <IconPlus size={15} />
                Create snapshot
              </ButtonLink>
            )
          }
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-3 gap-3 lg:max-w-2xl">
            <MetricCard label="Snapshots" value={snapshots.length} />
            <MetricCard label="Completed" value={completed} tone={completed > 0 ? "success" : "default"} />
            <MetricCard label="Failed" value={failed} tone={failed > 0 ? "danger" : "default"} />
          </div>
          <Card className="overflow-hidden">
            <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_120px_100px_150px] gap-4 border-b border-border bg-surface-2/50 px-5 py-2.5 md:grid">
              {["Commit", "Branch", "Status", "Files", "Created"].map((h) => (
                <span key={h} className="t-caption text-fg-3">
                  {h}
                </span>
              ))}
            </div>
            <ul className="divide-y divide-border">
              {snapshots.map((snapshot) => (
                <li key={snapshot.id} className="px-5 py-3.5 transition-colors hover:bg-surface-2/50">
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_120px_100px_150px] md:items-center md:gap-4">
                    <Link
                      href={`${projectPath}/repository/snapshots/${snapshot.id}`}
                      className="truncate font-mono text-[12.5px] text-fg underline-offset-2 transition-colors hover:text-accent hover:underline"
                      title={`Open snapshot ${snapshot.commit_sha}`}
                    >
                      {snapshot.commit_sha}
                    </Link>
                    <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[12px] text-fg-2">
                      <IconBranch size={12} className="shrink-0 text-fg-3" />
                      <span className="truncate">{snapshot.branch}</span>
                    </span>
                    <span>
                      <StatusBadge
                        kind="snapshot"
                        value={snapshot.status}
                        label={(STATUS_LABELS as Record<string, string>)[snapshot.status] ?? snapshot.status}
                      />
                    </span>
                    <span className="t-small text-fg-2 tabular-nums">
                      {snapshot.fileCount} {snapshot.fileCount === 1 ? "file" : "files"} recorded
                    </span>
                    <span className="t-small text-fg-3">{formatDateTime(snapshot.created_at)}</span>
                  </div>
                  {snapshot.error_message && <p className="mt-2 text-[12.5px] text-danger">{snapshot.error_message}</p>}
                  {snapshot.status === "COMPLETED" && (
                    <Link
                      href={`${projectPath}/repository/snapshots/${snapshot.id}/project-graph`}
                      className="mr-4 mt-2 inline-flex items-center gap-1 text-[12.5px] text-fg-2 transition-colors hover:text-accent"
                    >
                      <IconNetwork size={13} />
                      Project graph
                      <IconArrowRight size={12} />
                    </Link>
                  )}
                  {snapshot.status === "COMPLETED" && analysisStatus.get(snapshot.id) === "COMPLETED" && (
                    <Link
                      href={`${projectPath}/repository/snapshots/${snapshot.id}/graph`}
                      className="mt-2 inline-flex items-center gap-1 text-[12.5px] text-fg-2 transition-colors hover:text-accent"
                    >
                      <IconNetwork size={13} />
                      Symbol graph
                      <IconArrowRight size={12} />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </PageBody>
  );
}
