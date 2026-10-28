import { Alert } from "@/components/ui/alert";
import { MyBugsList } from "@/components/bugs/my-bugs-list";
import { EmptyState, MetricCard } from "@/components/ui/data";
import { IconAlert, IconCheckCircle, IconTask } from "@/components/ui/icons";
import { PageBody, PageHeader, SectionHeader } from "@/components/ui/page";
import { describeMyBugs } from "@/lib/bugs/my-bugs";
import { requireUser } from "@/server/auth/session";
import { getMyBugs } from "@/server/bugs/overview";

export const metadata = { title: "My bugs · OneForAll" };

export default async function MyBugsPage() {
  const user = await requireUser();
  const view = describeMyBugs(await getMyBugs(user.id));
  return (
    <PageBody>
      <PageHeader crumbs={[{ label: "My bugs" }]} icon={<IconAlert size={18} />} title="My bugs" description="Bugs assigned to you, fix proposals waiting for your approval, and fixes waiting for your review or verification." />
      {view.kind === "error" && (
        <Alert tone="danger" title="Could not load your bugs">
          {view.message}
        </Alert>
      )}
      {view.kind === "empty" && <EmptyState icon={<IconTask size={20} />} title="No bugs assigned to you" description="When an admin assigns a bug, or auto-assignment picks you, it appears here and you are notified." />}
      {view.kind === "list" && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <MetricCard label="Assigned to me" value={view.assigned.length} icon={<IconTask size={15} />} />
            <MetricCard label="Awaiting my approval" value={view.waiting.length} icon={<IconCheckCircle size={15} />} />
            <MetricCard label="To review or verify" value={view.toReview.length} icon={<IconAlert size={15} />} />
          </div>
          {view.waiting.length > 0 && (
            <section className="mb-6">
              <SectionHeader title="Awaiting your approval" description="The AI prepared a fix plan and patch. Nothing is applied until you decide." />
              <MyBugsList items={view.waiting} />
            </section>
          )}
          <section className="mb-6">
            <SectionHeader title="Assigned to me" />
            {view.assigned.length === 0 ? <p className="t-small text-fg-3">No bugs are assigned to you right now.</p> : <MyBugsList items={view.assigned} />}
          </section>
          {view.toReview.length > 0 && (
            <section>
              <SectionHeader title="Waiting for a review or verification" description="Bugs other people fixed that are in code review or QA. You cannot review your own fix." />
              <MyBugsList items={view.toReview} />
            </section>
          )}
        </>
      )}
    </PageBody>
  );
}
