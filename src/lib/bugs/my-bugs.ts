import { type BugSeverity, SEVERITY_RANK } from "./model";

// The signed-in person's bug queue. Pure (no I/O): the server fills it from the database, the pages render it and the tests
// pin the rules. The one rule that matters: "nothing assigned" is shown ONLY after a query that succeeded and matched nothing.
// A failed query is its own state, never an empty list.

export type MyBugItem = {
  id: string;
  ref: string;
  title: string;
  severity: BugSeverity;
  status: string;
  category: string;
  filePath: string;
  projectName: string;
  organizationName: string;
  href: string;
  mine: boolean;
  assignedAt: string | null;
  explanation: string | null;
  fixPlan: string | null;
};

export type MyBugsResult = { ok: true; assigned: MyBugItem[]; toReview: MyBugItem[] } | { ok: false; error: string };

export type MyBugsView = { kind: "error"; message: string } | { kind: "empty" } | { kind: "list"; assigned: MyBugItem[]; toReview: MyBugItem[]; waiting: MyBugItem[] };

export const MY_BUGS_LOAD_ERROR = "Your bugs could not be loaded. Reload the page; if it keeps failing, ask an admin to check the database.";

// Short, stable reference people can quote ("BUG-3F9A2C1B").
export function bugRef(id: string): string {
  return `BUG-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export function describeMyBugs(result: MyBugsResult): MyBugsView {
  if (!result.ok) return { kind: "error", message: result.error };
  if (result.assigned.length === 0 && result.toReview.length === 0) return { kind: "empty" };
  return { kind: "list", assigned: result.assigned, toReview: result.toReview, waiting: result.assigned.filter((b) => b.status === "AWAITING_APPROVAL") };
}

const bySeverity = (a: { severity: BugSeverity }, b: { severity: BugSeverity }) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];

// Splits the rows the database returned: mine (assigned to me, open) and the ones other people fixed that wait for me.
export function splitMyBugs(items: readonly MyBugItem[]): { assigned: MyBugItem[]; toReview: MyBugItem[] } {
  return {
    assigned: items.filter((b) => b.mine).sort(bySeverity),
    toReview: items.filter((b) => !b.mine).sort(bySeverity),
  };
}
