import Link from "next/link";
import { BugSeverityBadge, BugStatusBadge, categoryLabel } from "@/components/bugs/badges";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState, MetricCard } from "@/components/ui/data";
import { IconAlert, IconCheckCircle, IconTask } from "@/components/ui/icons";
import { PageBody, PageHeader, SectionHeader } from "@/components/ui/page";
import { requireUser } from "@/server/auth/session";
import { getMyBugs } from "@/server/bugs/overview";

export const metadata = { title: "My bugs · OneForAll" };

type Item = Awaited<ReturnType<typeof getMyBugs>>["assigned"][number];

function List({ items }: { items: Item[] }) {
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-border">
        {items.map((b) => (
          <li key={b.id}>
            <Link href={b.href} className="flex flex-col gap-1 px-5 py-3 transition-colors hover:bg-surface-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-medium text-fg">{b.title}</p>
                <p className="truncate text-[12px] text-fg-3">
                  {b.organizationName} · {b.projectName} · <span className="font-mono">{b.filePath}</span>
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <BugSeverityBadge severity={b.severity} />
                <Badge tone="muted">{categoryLabel(b.category)}</Badge>
                <BugStatusBadge status={b.status} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default async function MyBugsPage() {
  const user = await requireUser();
  const { assigned, toReview } = await getMyBugs(user.id);
  const waiting = assigned.filter((b) => b.status === "AWAITING_APPROVAL");
  return (
    <PageBody>
      <PageHeader crumbs={[{ label: "My bugs" }]} icon={<IconAlert size={18} />} title="My bugs" description="Bugs assigned to you, fix proposals waiting for your approval, and fixes waiting for your review or verification." />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <MetricCard label="Assigned to me" value={assigned.length} icon={<IconTask size={15} />} />
        <MetricCard label="Awaiting my approval" value={waiting.length} icon={<IconCheckCircle size={15} />} />
        <MetricCard label="To review or verify" value={toReview.length} icon={<IconAlert size={15} />} />
      </div>
      {waiting.length > 0 && (
        <section className="mb-6">
          <SectionHeader title="Awaiting your approval" description="The AI prepared a fix plan and patch. Nothing is applied until you decide." />
          <List items={waiting} />
        </section>
      )}
      <section className="mb-6">
        <SectionHeader title="Assigned to me" />
        {assigned.length === 0 ? <EmptyState icon={<IconTask size={20} />} title="No bugs assigned to you" description="When an admin assigns a bug, or auto-assignment picks you, it appears here and you are notified." /> : <List items={assigned} />}
      </section>
      {toReview.length > 0 && (
        <section>
          <SectionHeader title="Waiting for a review or verification" description="Bugs other people fixed that are in code review or QA. You cannot review your own fix." />
          <List items={toReview} />
        </section>
      )}
    </PageBody>
  );
}
