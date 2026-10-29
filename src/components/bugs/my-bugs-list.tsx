import Link from "next/link";
import { BugSeverityBadge, BugStatusBadge, categoryLabel } from "@/components/bugs/badges";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { MyBugItem } from "@/lib/bugs/my-bugs";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

// A person's bugs with what they need to start: reference, severity, category, file, status, when it was assigned, the AI's
// explanation and fix plan when there are some, and a direct link to the bug workspace.
export function MyBugsList({ items }: { items: MyBugItem[] }) {
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-border">
        {items.map((b) => (
          <li key={b.id} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-[13.5px] font-medium text-fg">
                <span className="mr-2 font-mono text-[11.5px] font-normal text-fg-3">{b.ref}</span>
                {b.title}
              </p>
              <p className="truncate text-[12px] text-fg-3">
                {b.organizationName} · {b.projectName} · <span className="font-mono">{b.filePath}</span>
                {b.assignedAt ? ` · assigned ${new Date(b.assignedAt).toLocaleDateString()}` : ""}
              </p>
              {b.explanation && <p className="text-[12.5px] text-fg-2">{clip(b.explanation, 220)}</p>}
              {b.fixPlan && (
                <p className="text-[12.5px] text-fg-2">
                  <span className="font-medium text-fg">Fix plan:</span> {clip(b.fixPlan, 220)}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
              <div className="flex flex-wrap items-center gap-2">
                <BugSeverityBadge severity={b.severity} />
                <Badge tone="muted">{categoryLabel(b.category)}</Badge>
                <BugStatusBadge status={b.status} />
              </div>
              <Link href={b.href} className="text-[12.5px] font-medium text-accent underline-offset-2 hover:underline">
                Open bug workspace
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
