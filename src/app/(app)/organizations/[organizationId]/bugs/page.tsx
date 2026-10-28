import Link from "next/link";
import { notFound } from "next/navigation";
import { BugSeverityBadge, BugStatusBadge } from "@/components/bugs/badges";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, MetricCard } from "@/components/ui/data";
import { IconAlert, IconBranch, IconNetwork, IconUsers } from "@/components/ui/icons";
import { PageBody, PageHeader, SectionHeader } from "@/components/ui/page";
import { createClient } from "@/lib/supabase/server";
import { idSchema } from "@/server/departments/schema";
import { getOrgBugOverview } from "@/server/bugs/overview";

export const metadata = { title: "Repositories and bugs · OneForAll" };

export default async function OrganizationBugsPage({ params }: PageProps<"/organizations/[organizationId]/bugs">) {
  const { organizationId } = await params;
  if (!idSchema.safeParse(organizationId).success) notFound();
  const supabase = await createClient();
  const { data: organization } = await supabase.from("organizations").select("id, name").eq("id", organizationId).maybeSingle();
  if (!organization) notFound();
  const { data: auth } = await supabase.auth.getUser();
  const { data: member } = await supabase.from("organization_members").select("role").eq("organization_id", organizationId).eq("user_id", auth.user?.id ?? "").maybeSingle();
  if (!member) notFound();
  const isAdmin = member.role === "OWNER" || member.role === "ADMIN";
  const data = await getOrgBugOverview(organizationId, isAdmin);

  return (
    <PageBody>
      <PageHeader
        crumbs={[{ label: organization.name, href: `/organizations/${organization.id}/overview` }, { label: "Repositories and bugs" }]}
        icon={<IconAlert size={18} />}
        title="Repositories and bugs"
        description={isAdmin ? "Every repository with its project graph, every bug, the approval queue, who is carrying what, and what the AI analysis costs." : "The repositories you can see with their project graphs, and the bugs in them."}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Open bugs" value={data.open.length} icon={<IconAlert size={15} />} />
        <MetricCard label="Critical + high" value={data.bySeverity.CRITICAL + data.bySeverity.HIGH} icon={<IconAlert size={15} />} />
        <MetricCard label="Unassigned" value={data.unassigned.length} icon={<IconUsers size={15} />} />
        <MetricCard label="Awaiting approval" value={data.awaitingApproval.length} icon={<IconBranch size={15} />} />
      </div>

      <section className="mb-6">
        <SectionHeader title="Repositories" description="Open the project graph of the latest import." />
        {data.projects.filter((p) => p.repository).length === 0 ? (
          <EmptyState icon={<IconBranch size={20} />} title="No repositories yet" description="Connect and import a repository in a project to see its graph here." />
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-border">
              {data.projects
                .filter((p) => p.repository)
                .map((p) => (
                  <li key={p.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-medium text-fg">
                        {p.name} <span className="font-normal text-fg-3">· {p.teamName}</span>
                      </p>
                      <p className="truncate text-[12px] text-fg-3">
                        {p.repository!.owner}/{p.repository!.name}
                        {p.snapshot ? ` · ${p.snapshot.branch ?? "snapshot"} @ ${p.snapshot.commit.slice(0, 7)}` : " · not imported yet"}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Badge tone={p.openBugs > 0 ? "warning" : "muted"}>{p.openBugs} open bug{p.openBugs === 1 ? "" : "s"}</Badge>
                      {p.snapshot && (
                        <ButtonLink href={`${p.path}/repository/snapshots/${p.snapshot.id}/project-graph`} variant="secondary" size="sm">
                          <IconNetwork size={14} />
                          Project graph
                        </ButtonLink>
                      )}
                      <ButtonLink href={`${p.path}/bugs`} variant="secondary" size="sm">
                        Bugs
                      </ButtonLink>
                    </div>
                  </li>
                ))}
            </ul>
          </Card>
        )}
      </section>

      {isAdmin && data.awaitingApproval.length > 0 && (
        <section className="mb-6">
          <SectionHeader title="Approval queue" description="AI fix proposals waiting for a decision." />
          <BugList items={data.awaitingApproval} />
        </section>
      )}

      {isAdmin && (
        <section className="mb-6 grid gap-4 lg:grid-cols-2">
          <div>
            <SectionHeader title="Workload" description="Open bugs per person." />
            <Card className="overflow-hidden">
              {data.workload.length === 0 ? (
                <p className="p-4 text-[13px] text-fg-3">No bug is assigned yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.workload.map((w) => (
                    <li key={w.id} className="flex items-center justify-between px-5 py-2.5 text-[13px]">
                      <span className="text-fg">{w.name}</span>
                      <span className="text-fg-2">
                        {w.open} open{w.critical > 0 ? ` · ${w.critical} critical/high` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <div>
            <SectionHeader title="AI usage, last 30 days" description="Bug scans and fix plans." />
            <Card className="p-4 text-[13px] text-fg-2">
              {data.usage ? (
                <ul className="space-y-1">
                  <li>{data.usage.scans} scans, {data.usage.runs} AI runs</li>
                  <li>{data.usage.tokens.toLocaleString()} tokens</li>
                  <li>
                    Estimated paid-tier cost ${data.usage.costUsd.toFixed(4)} <span className="text-fg-3">(the free tier costs nothing; this is the list-price estimate)</span>
                  </li>
                </ul>
              ) : null}
            </Card>
          </div>
        </section>
      )}

      <section>
        <SectionHeader title="Open bugs" description="Most severe first." />
        {data.open.length === 0 ? <EmptyState icon={<IconAlert size={20} />} title="No open bugs" description="Scan a repository from its Bugs page." /> : <BugList items={data.open.slice(0, 100)} />}
      </section>
    </PageBody>
  );
}

function BugList({ items }: { items: Awaited<ReturnType<typeof getOrgBugOverview>>["open"] }) {
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-border">
        {items.map((b) => (
          <li key={b.id}>
            <Link href={b.href} className="flex flex-col gap-1 px-5 py-3 transition-colors hover:bg-surface-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-medium text-fg">{b.title}</p>
                <p className="truncate text-[12px] text-fg-3">
                  {b.projectName} · <span className="font-mono">{b.filePath}</span>
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <BugSeverityBadge severity={b.severity} />
                <BugStatusBadge status={b.status} />
                <span className="w-28 truncate text-right text-[12px] text-fg-2">{b.assigneeName ?? "Unassigned"}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
