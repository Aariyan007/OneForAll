import { ROLE_LABELS, isOrgRole } from "@/lib/authz/permissions";
import { Badge, type Tone } from "./badge";

// Presentation only: maps the status/priority/role strings the database already returns onto badge tones
// and readable labels. Unknown values fall back to a neutral badge with the raw value (never hidden).

type Kind = "project" | "projectType" | "requirement" | "task" | "repository" | "snapshot" | "analysis" | "priority" | "role" | "visibility" | "availability" | "invitation" | "handoff" | "membership" | "defect";

const TONE_MAP: Record<Kind, Record<string, Tone>> = {
  project: { DRAFT: "neutral", ACTIVE: "success", ARCHIVED: "muted" },
  projectType: { GREENFIELD: "accent", BROWNFIELD: "info" },
  requirement: { DRAFT: "neutral", READY: "info", IN_PROGRESS: "accent", COMPLETED: "success", CANCELLED: "muted" },
  task: { TODO: "neutral", IN_PROGRESS: "accent", BLOCKED: "danger", IN_REVIEW: "info", IN_QA: "warning", COMPLETED: "success", CANCELLED: "muted" },
  repository: { PENDING: "warning", CONNECTED: "success", DISCONNECTED: "muted", ERROR: "danger" },
  snapshot: { PENDING: "warning", PROCESSING: "info", COMPLETED: "success", FAILED: "danger" },
  analysis: { PENDING: "warning", PROCESSING: "info", COMPLETED: "success", FAILED: "danger" },
  priority: { LOW: "muted", MEDIUM: "neutral", HIGH: "warning", CRITICAL: "danger" },
  role: { OWNER: "accent", ADMIN: "info", MEMBER: "neutral" },
  visibility: { PUBLIC: "neutral", PRIVATE: "neutral", INTERNAL: "neutral", UNKNOWN: "muted" },
  availability: { AVAILABLE: "success", BUSY: "warning", UNAVAILABLE: "muted" },
  invitation: { PENDING: "warning", ACCEPTED: "success", REVOKED: "muted", EXPIRED: "muted" },
  handoff: { PENDING: "warning", ACCEPTED: "success", DECLINED: "danger", CANCELLED: "muted" },
  membership: { ACTIVE: "success", SUSPENDED: "danger" },
  defect: { OPEN: "danger", RESOLVED: "success" },
};

export function humanize(value: string): string {
  const lower = value.replaceAll("_", " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function toneFor(kind: Kind, value: string): Tone {
  return TONE_MAP[kind][value] ?? "neutral";
}

export function StatusBadge({ kind, value, label }: { kind: Kind; value: string; label?: string }) {
  const tone = toneFor(kind, value);
  const live = (kind === "snapshot" || kind === "analysis") && value === "PROCESSING";
  const withDot = kind !== "priority" && kind !== "projectType" && kind !== "role" && kind !== "visibility";
  return (
    <Badge tone={tone} dot={withDot} pulse={live}>
      {label ?? (kind === "role" && isOrgRole(value) ? ROLE_LABELS[value] : humanize(value))}
    </Badge>
  );
}

const PRIORITY_BARS: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

// Priority as a compact signal-strength glyph plus label.
export function PriorityBadge({ value }: { value: string }) {
  const level = PRIORITY_BARS[value] ?? 0;
  return (
    <Badge tone={toneFor("priority", value)}>
      <span aria-hidden="true" className="flex items-end gap-[2px]">
        {[1, 2, 3, 4].map((bar) => (
          <span
            key={bar}
            className={bar <= level ? "w-[3px] rounded-[1px] bg-current" : "w-[3px] rounded-[1px] bg-current opacity-25"}
            style={{ height: 3 + bar * 2 }}
          />
        ))}
      </span>
      {humanize(value)}
    </Badge>
  );
}
