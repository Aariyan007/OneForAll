import Link from "next/link";
import { notFound } from "next/navigation";
import { BugScanPanel, type PublicScan } from "@/components/bugs/bug-scan-panel";
import { BugSeverityBadge, BugStatusBadge, categoryLabel } from "@/components/bugs/badges";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, MetricCard } from "@/components/ui/data";
import { IconAlert, IconBranch, IconCheckCircle, IconTask, IconUsers } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { BUG_CATEGORIES, BUG_CATEGORY_LABELS, BUG_SEVERITIES, BUG_STATUSES, BUG_STATUS_LABELS } from "@/lib/bugs/model";
import { getBugsPage, parseBugFilters } from "@/server/bugs/queries";

export const metadata = { title: "Bugs · OneForAll" };

const SELECT = "h-9 rounded-lg border border-border bg-surface-2 px-2 text-[13px] text-fg";

export default async function BugsPage({
  params,
  searchParams,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/bugs">) {
  const { organizationId, departmentId, teamId, projectId } = await params;
  const filters = parseBugFilters(await searchParams);
  const data = await getBugsPage(organizationId, departmentId, teamId, projectId, filters);
  // 404 for malformed, mismatched, cross-tenant or not-permitted paths alike.
  if (!data) notFound();
  const { organization, department, team, project, counts } = data;
  const projectPath = `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}`;
  const filtered = Object.keys(filters).length > 0;
  const scan = data.scan ? ({ ...data.scan, plan: undefined } as unknown as PublicScan) : null;

  return (
    <PageBody>
      <PageHeader
        crumbs={[
          { label: team.name, href: `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects` },
          { label: project.name, href: projectPath },
          { label: "Bugs" },
        ]}
        icon={<IconAlert size={18} />}
        title="Bugs"
        description="Defects found by scanning the whole imported project, with the code that proves each one. Assign them, fix them with approval, and hand them on for review."
      />

      {!data.repository || !data.snapshot ? (
        <EmptyState
          icon={<IconBranch size={20} />}
          title={data.repository ? "No completed import yet" : "Connect a repository first"}
          description="Bugs are found by scanning an imported repository. Import the latest commit of a branch and come back."
          action={
            <ButtonLink href={`${projectPath}#repository`} variant="primary">
              Go to repository
            </ButtonLink>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Open bugs" value={counts.open} icon={<IconAlert size={15} />} hint={`${counts.total} found in total`} />
            <MetricCard label="Critical + high" value={(counts.bySeverity.CRITICAL ?? 0) + (counts.bySeverity.HIGH ?? 0)} icon={<IconAlert size={15} />} />
            <MetricCard label="Unassigned" value={counts.unassigned} icon={<IconUsers size={15} />} />
            <MetricCard label="Resolved" value={counts.byStatus.RESOLVED ?? 0} icon={<IconCheckCircle size={15} />} hint={`${counts.mine} open and assigned to you`} />
          </div>

          {data.canManage ? (
            <BugScanPanel
              endpoint={`${projectPath}/bugs/scan`}
              snapshotId={data.snapshot.id}
              snapshotLabel={`${data.repository.owner}/${data.repository.name} @ ${data.snapshot.branch ?? "snapshot"} ${data.snapshot.commit_sha.slice(0, 7)}`}
              initialScan={scan}
              configured={data.aiConfigured}
            />
          ) : (
            <Card className="p-4 text-[13px] text-fg-2">
              Scans are started by organization owners and admins.{" "}
              {scan ? `Last scan: ${scan.status.toLowerCase()}, ${scan.bugs_found} findings.` : "No scan has been run on the latest import yet."}
            </Card>
          )}

          <Card className="overflow-hidden">
            <form method="get" className="flex flex-wrap items-center gap-2 border-b border-border p-3">
              <input name="q" defaultValue={filters.q ?? ""} placeholder="Search title or file" aria-label="Search bugs" className="h-9 min-w-[180px] flex-1 rounded-lg border border-border bg-surface-2 px-3 text-[13px] text-fg" />
              <select name="severity" defaultValue={filters.severity ?? ""} aria-label="Severity" className={SELECT}>
                <option value="">All severities</option>
                {BUG_SEVERITIES.map((s) => (
                  <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>
                ))}
              </select>
              <select name="status" defaultValue={filters.status ?? ""} aria-label="Status" className={SELECT}>
                <option value="">All statuses</option>
                {BUG_STATUSES.map((s) => (
                  <option key={s} value={s}>{BUG_STATUS_LABELS[s]}</option>
                ))}
              </select>
              <select name="category" defaultValue={filters.category ?? ""} aria-label="Category" className={SELECT}>
                <option value="">All categories</option>
                {BUG_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{BUG_CATEGORY_LABELS[c]}</option>
                ))}
              </select>
              <select name="assignee" defaultValue={filters.assignee ?? ""} aria-label="Assignee" className={SELECT}>
                <option value="">Anyone</option>
                <option value="me">Assigned to me</option>
                <option value="none">Unassigned</option>
              </select>
              <label className="flex items-center gap-1.5 text-[13px] text-fg-2">
                <input type="checkbox" name="open" value="1" defaultChecked={filters.open === "1"} /> Open only
              </label>
              <button className="h-9 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg">Filter</button>
              {filtered && (
                <Link href={`${projectPath}/bugs`} className="text-[13px] text-fg-2 underline underline-offset-2">
                  Clear
                </Link>
              )}
            </form>

            {data.bugs.length === 0 ? (
              <EmptyState
                icon={<IconTask size={20} />}
                title={filtered ? "No bugs match these filters" : "No bugs yet"}
                description={filtered ? "Clear the filters to see every bug." : data.canManage ? "Run a scan above. Nothing is listed until the AI has found something it can quote." : "An owner or admin has not scanned this import yet."}
              />
            ) : (
              <ul className="divide-y divide-border">
                {data.bugs.map((bug) => (
                  <li key={bug.id}>
                    <Link href={`${projectPath}/bugs/${bug.id}`} className="flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium text-fg">{bug.title}</p>
                        <p className="truncate font-mono text-[12px] text-fg-3">
                          {bug.filePath}:{bug.startLine}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <BugSeverityBadge severity={bug.severity} />
                        <Badge tone="muted">{categoryLabel(bug.category)}</Badge>
                        <BugStatusBadge status={bug.status} />
                        <span className="text-[12px] text-fg-3" title="Model confidence">
                          {Math.round(bug.confidence * 100)}%
                        </span>
                        <span className="w-28 truncate text-right text-[12px] text-fg-2">{bug.assigneeName ?? "Unassigned"}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {data.truncated && <p className="border-t border-border px-4 py-2 text-[12px] text-fg-3">Showing the first 300 matches. Narrow the filters to see others.</p>}
          </Card>
        </div>
      )}
    </PageBody>
  );
}
