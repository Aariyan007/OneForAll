// Vocabulary and workflow of the bug intelligence feature. Pure (no I/O) so the UI, the server and the tests share it.
// The status machine here is mirrored by private.bug_transition_ok in supabase/migrations/20261029000002_bugs.sql;
// model.test.ts reads that migration and fails when the two disagree.

export const BUG_CATEGORIES = [
  "frontend",
  "backend",
  "api",
  "database",
  "auth_security",
  "repo_processing",
  "llm_orchestration",
  "token_usage",
  "testing",
  "configuration",
  "performance",
  "other",
] as const;
export type BugCategory = (typeof BUG_CATEGORIES)[number];

export const BUG_CATEGORY_LABELS: Record<BugCategory, string> = {
  frontend: "Frontend / UI",
  backend: "Backend",
  api: "API",
  database: "Database",
  auth_security: "Auth / security",
  repo_processing: "Repository processing",
  llm_orchestration: "LLM orchestration",
  token_usage: "Token usage",
  testing: "Testing",
  configuration: "Configuration",
  performance: "Performance",
  other: "Other",
};

export const BUG_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
export type BugSeverity = (typeof BUG_SEVERITIES)[number];

export const BUG_STATUSES = [
  "DETECTED",
  "TRIAGED",
  "ASSIGNED",
  "IN_PROGRESS",
  "FIX_PROPOSED",
  "AWAITING_APPROVAL",
  "FIX_APPLIED",
  "TESTING",
  "CODE_REVIEW",
  "QA_VERIFICATION",
  "RESOLVED",
  "REJECTED",
  "BLOCKED",
  "REOPENED",
  "CANCELLED",
] as const;
export type BugStatus = (typeof BUG_STATUSES)[number];

export const BUG_STATUS_LABELS: Record<BugStatus, string> = {
  DETECTED: "Detected",
  TRIAGED: "Triaged",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  FIX_PROPOSED: "Fix proposed",
  AWAITING_APPROVAL: "Awaiting approval",
  FIX_APPLIED: "Fix applied",
  TESTING: "Testing",
  CODE_REVIEW: "Code review",
  QA_VERIFICATION: "QA verification",
  RESOLVED: "Resolved",
  REJECTED: "Rejected",
  BLOCKED: "Blocked",
  REOPENED: "Reopened",
  CANCELLED: "Cancelled",
};

// Allowed moves. "Resolved" is reachable only from QA verification: a fix is never closed without passing every stage.
export const BUG_TRANSITIONS: Record<BugStatus, readonly BugStatus[]> = {
  DETECTED: ["TRIAGED", "ASSIGNED", "REJECTED", "CANCELLED"],
  TRIAGED: ["ASSIGNED", "REJECTED", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "TRIAGED", "BLOCKED", "REJECTED", "CANCELLED"],
  IN_PROGRESS: ["FIX_PROPOSED", "ASSIGNED", "BLOCKED"],
  FIX_PROPOSED: ["AWAITING_APPROVAL", "IN_PROGRESS"],
  AWAITING_APPROVAL: ["FIX_APPLIED", "IN_PROGRESS"],
  FIX_APPLIED: ["TESTING", "IN_PROGRESS"],
  TESTING: ["CODE_REVIEW", "IN_PROGRESS"],
  CODE_REVIEW: ["QA_VERIFICATION", "IN_PROGRESS"],
  QA_VERIFICATION: ["RESOLVED", "IN_PROGRESS"],
  RESOLVED: ["REOPENED"],
  REJECTED: ["REOPENED"],
  BLOCKED: ["ASSIGNED", "IN_PROGRESS", "CANCELLED"],
  REOPENED: ["TRIAGED", "ASSIGNED", "IN_PROGRESS"],
  CANCELLED: ["REOPENED"],
};

export function canMoveBug(from: BugStatus, to: BugStatus): boolean {
  return BUG_TRANSITIONS[from].includes(to);
}

export const OPEN_BUG_STATUSES: readonly BugStatus[] = BUG_STATUSES.filter((s) => s !== "RESOLVED" && s !== "REJECTED" && s !== "CANCELLED");

export const SEVERITY_RANK: Record<BugSeverity, number> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
