import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { BUG_STATUSES, OPEN_BUG_STATUSES, REASSIGNABLE_BUG_STATUSES, REVIEW_BUG_STATUSES } from "./model";
import { bugRef, describeMyBugs, type MyBugItem, MY_BUGS_LOAD_ERROR, splitMyBugs } from "./my-bugs";

const item = (over: Partial<MyBugItem> = {}): MyBugItem => ({
  id: "3f9a2c1b-0000-4000-8000-000000000001", ref: "BUG-3F9A2C1B", title: "Null dereference", severity: "HIGH", status: "ASSIGNED", category: "backend", filePath: "a.ts",
  projectName: "P", organizationName: "O", href: "/x", mine: true, assignedAt: "2026-10-29T10:00:00Z", explanation: null, fixPlan: null, ...over,
});

test("a failed query is an error state, never 'nothing assigned'", () => {
  const view = describeMyBugs({ ok: false, error: MY_BUGS_LOAD_ERROR });
  assert.equal(view.kind, "error");
  assert.equal(view.kind === "error" && view.message, MY_BUGS_LOAD_ERROR);
});

test("'nothing assigned' appears only after a successful query that matched nothing", () => {
  assert.equal(describeMyBugs({ ok: true, assigned: [], toReview: [] }).kind, "empty");
});

test("an assigned bug is listed, and bugs awaiting approval are called out", () => {
  const view = describeMyBugs({ ok: true, assigned: [item(), item({ id: "2", status: "AWAITING_APPROVAL" })], toReview: [] });
  assert.equal(view.kind, "list");
  if (view.kind !== "list") return;
  assert.equal(view.assigned.length, 2);
  assert.deepEqual(view.waiting.map((b) => b.id), ["2"]);
});

test("a person with only a review queue still gets a list, not the empty state", () => {
  assert.equal(describeMyBugs({ ok: true, assigned: [], toReview: [item({ mine: false, status: "CODE_REVIEW" })] }).kind, "list");
});

test("rows are split into mine and the review queue, most severe first", () => {
  const { assigned, toReview } = splitMyBugs([
    item({ id: "low", severity: "LOW" }),
    item({ id: "crit", severity: "CRITICAL" }),
    item({ id: "theirs", mine: false, status: "QA_VERIFICATION" }),
  ]);
  assert.deepEqual(assigned.map((b) => b.id), ["crit", "low"]);
  assert.deepEqual(toReview.map((b) => b.id), ["theirs"]);
});

test("every actionable workflow status counts as active work; closed ones do not", () => {
  for (const status of ["ASSIGNED", "IN_PROGRESS", "FIX_PROPOSED", "AWAITING_APPROVAL", "FIX_APPLIED", "TESTING", "CODE_REVIEW", "QA_VERIFICATION", "BLOCKED", "REOPENED"]) {
    assert.ok((OPEN_BUG_STATUSES as readonly string[]).includes(status), `${status} must be active`);
  }
  for (const status of ["RESOLVED", "REJECTED", "CANCELLED"]) assert.ok(!(OPEN_BUG_STATUSES as readonly string[]).includes(status), `${status} must not be active`);
  for (const status of [...REVIEW_BUG_STATUSES, ...REASSIGNABLE_BUG_STATUSES]) assert.ok(BUG_STATUSES.includes(status), `${status} is a known status`);
});

test("the statuses the UI treats as reassignable match the ones public.assign_bug accepts", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20261029000003_bug_assignment.sql", import.meta.url), "utf8");
  const match = sql.match(/create or replace function public\.assign_bug[\s\S]*?v_bug\.status not in \(([^)]*)\)/);
  assert.ok(match, "assign_bug status check not found");
  const inSql = [...match[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...REASSIGNABLE_BUG_STATUSES].sort(), inSql);
});

// Regression: an unnamed `teams!inner(...)` embed on `projects` fails since project_teams added a second projects<->teams
// relationship ("Could not embed because more than one relationship was found"). The bug queue swallowed that error, so
// assigned bugs showed with no project and a dead link. Embeds must name the owning-team relationship.
test("no query embeds teams from projects without naming projects_team_id_fkey", () => {
  const offenders: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) walk(next);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") && /\bteams!inner\(/.test(readFileSync(next, "utf8"))) offenders.push(entry.name);
    }
  };
  walk(new URL("../../server/", import.meta.url));
  assert.deepEqual(offenders, []);
});

test("a bug reference is short, stable and derived from the id", () => {
  assert.equal(bugRef("3f9a2c1b-1111-4222-8333-444455556666"), "BUG-3F9A2C1B");
});
