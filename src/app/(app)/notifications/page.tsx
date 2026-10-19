import Link from "next/link";
import { MarkReadButton } from "@/components/notifications/mark-read";
import { Card } from "@/components/ui/card";
import { EmptyState, formatDateTime } from "@/components/ui/data";
import { IconBell } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { cx } from "@/lib/cx";
import { requireUser } from "@/server/auth/session";
import { listNotifications } from "@/server/notifications/queries";

export const metadata = { title: "Notifications · OneForAll" };

export default async function NotificationsPage() {
  await requireUser();
  const notifications = await listNotifications(100);
  const unread = notifications.filter((n) => !n.read_at).length;
  return (
    <PageBody width="narrow">
      <PageHeader
        crumbs={[{ label: "Notifications" }]}
        icon={<IconBell size={18} />}
        title="Notifications"
        description="In-app notifications about your tasks, reviews and handoffs. They are not sent by email."
        actions={unread > 0 && <MarkReadButton />}
      />
      {notifications.length === 0 ? (
        <EmptyState icon={<IconBell size={20} />} title="No notifications" description="You will be notified here when work is assigned to you, reviewed or handed to your team." />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {notifications.map((n) => (
              <li key={n.id} className={cx("flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-start sm:justify-between", !n.read_at && "bg-accent/[0.04]")}>
                <div className="min-w-0">
                  <p className="text-[13.5px] text-fg">
                    {!n.read_at && <span className="mr-2 inline-block size-2 rounded-full bg-accent align-middle" aria-label="Unread" />}
                    {n.link ? (
                      <Link href={n.link} className="font-medium hover:underline">
                        {n.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{n.title}</span>
                    )}
                  </p>
                  {n.body && <p className="t-small whitespace-pre-line text-fg-2">{n.body}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[12px] text-fg-3">{formatDateTime(n.created_at)}</span>
                  {!n.read_at && <MarkReadButton ids={[n.id]} label="Mark read" />}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </PageBody>
  );
}
