import { Badge, type Tone } from "@/components/ui/badge";
import { BUG_CATEGORY_LABELS, BUG_STATUS_LABELS, type BugCategory, type BugSeverity, type BugStatus } from "@/lib/bugs/model";

const SEVERITY_TONE: Record<BugSeverity, Tone> = { CRITICAL: "danger", HIGH: "danger", MEDIUM: "warning", LOW: "info", INFO: "muted" };

export function BugSeverityBadge({ severity }: { severity: BugSeverity }) {
  return (
    <Badge tone={SEVERITY_TONE[severity]} dot>
      {severity.charAt(0) + severity.slice(1).toLowerCase()}
    </Badge>
  );
}

const STATUS_TONE: Partial<Record<BugStatus, Tone>> = {
  DETECTED: "neutral",
  TRIAGED: "info",
  ASSIGNED: "accent",
  IN_PROGRESS: "accent",
  FIX_PROPOSED: "warning",
  AWAITING_APPROVAL: "warning",
  FIX_APPLIED: "info",
  TESTING: "info",
  CODE_REVIEW: "info",
  QA_VERIFICATION: "info",
  RESOLVED: "success",
  REJECTED: "muted",
  BLOCKED: "danger",
  REOPENED: "warning",
  CANCELLED: "muted",
};

export function BugStatusBadge({ status }: { status: string }) {
  const known = status in BUG_STATUS_LABELS;
  return <Badge tone={STATUS_TONE[status as BugStatus] ?? "neutral"}>{known ? BUG_STATUS_LABELS[status as BugStatus] : status}</Badge>;
}

export function categoryLabel(category: string): string {
  return BUG_CATEGORY_LABELS[category as BugCategory] ?? category;
}
