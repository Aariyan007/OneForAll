// Unit tests for the task workflow mirror. The same matrix is enforced by the database trigger
// (supabase/tests/requirements_tasks_rls.sql checks every pair) and transition_task() (task_workflow_rls.sql).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TASK_STATUSES, availableActions, isAllowedTaskTransition, reasonRequired } from "./workflow";

// Copied from the database trigger in migration 20261027000001 (allowed non-identity pairs).
const DB_ALLOWED = new Set([
  "TODO>IN_PROGRESS", "TODO>CANCELLED",
  "IN_PROGRESS>BLOCKED", "IN_PROGRESS>IN_REVIEW", "IN_PROGRESS>COMPLETED", "IN_PROGRESS>TODO", "IN_PROGRESS>CANCELLED",
  "BLOCKED>IN_PROGRESS", "BLOCKED>CANCELLED",
  "IN_REVIEW>IN_QA", "IN_REVIEW>COMPLETED", "IN_REVIEW>IN_PROGRESS", "IN_REVIEW>CANCELLED",
  "IN_QA>COMPLETED", "IN_QA>IN_PROGRESS", "IN_QA>CANCELLED",
  "COMPLETED>IN_PROGRESS",
  "CANCELLED>TODO",
]);

describe("task lifecycle", () => {
  it("matches the database trigger for every pair", () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        if (from === to) continue;
        assert.equal(isAllowedTaskTransition(from, to), DB_ALLOWED.has(`${from}>${to}`), `${from} -> ${to}`);
      }
    }
  });

  it("requires a reason to block, cancel or request changes", () => {
    assert.ok(reasonRequired("IN_PROGRESS", "BLOCKED"));
    assert.ok(reasonRequired("TODO", "CANCELLED"));
    assert.ok(reasonRequired("IN_REVIEW", "IN_PROGRESS"));
    assert.ok(reasonRequired("IN_QA", "IN_PROGRESS"), "failing QA needs a reason");
    assert.ok(!reasonRequired("IN_QA", "COMPLETED"));
    assert.ok(!reasonRequired("BLOCKED", "IN_PROGRESS"));
    assert.ok(!reasonRequired("IN_PROGRESS", "IN_REVIEW"));
  });
});

describe("availableActions", () => {
  const ctx = { assigned: true, openDependencies: 0 };

  it("an assignee works the task but cannot approve, cancel or reopen", () => {
    const steps = (s: (typeof TASK_STATUSES)[number]) => availableActions(s, { manager: false, assignee: true }, ctx).map((a) => a.to);
    assert.deepEqual(steps("TODO"), ["IN_PROGRESS"]);
    assert.deepEqual(steps("IN_PROGRESS"), ["BLOCKED", "IN_REVIEW", "TODO"]);
    assert.deepEqual(steps("BLOCKED"), ["IN_PROGRESS"]);
    assert.deepEqual(steps("IN_REVIEW"), []);
    assert.deepEqual(steps("IN_QA"), [], "the assignee never passes their own QA");
    assert.deepEqual(steps("COMPLETED"), []);
    assert.deepEqual(steps("CANCELLED"), []);
  });

  it("someone who is neither manager nor assignee gets nothing", () => {
    for (const s of TASK_STATUSES) assert.deepEqual(availableActions(s, { manager: false, assignee: false }, ctx), []);
  });

  it("managers get every lifecycle step, labelled", () => {
    const review = availableActions("IN_REVIEW", { manager: true, assignee: false }, ctx);
    assert.deepEqual(review.map((a) => [a.to, a.label, a.needsReason]), [
      ["IN_QA", "Send to QA", false],
      ["COMPLETED", "Approve", false],
      ["IN_PROGRESS", "Request changes", true],
      ["CANCELLED", "Cancel task", true],
    ]);
  });

  it("explains steps the database would refuse right now", () => {
    const unassigned = availableActions("TODO", { manager: true, assignee: false }, { assigned: false, openDependencies: 0 });
    assert.equal(unassigned.find((a) => a.to === "IN_PROGRESS")!.blockedBy, "Assign the task first.");
    const waiting = availableActions("TODO", { manager: false, assignee: true }, { assigned: true, openDependencies: 2 });
    assert.equal(waiting[0].blockedBy, "Waiting for 2 unfinished dependencies.");
    const cancel = availableActions("TODO", { manager: true, assignee: false }, { assigned: true, openDependencies: 2 }).find((a) => a.to === "CANCELLED")!;
    assert.equal(cancel.blockedBy, null, "dependencies never block cancelling");
  });
});

describe("QA", () => {
  const ctx = { assigned: true, openDependencies: 0 };

  it("a tester passes or fails QA and nothing else", () => {
    const tester = { manager: false, assignee: false, tester: true };
    assert.deepEqual(availableActions("IN_QA", tester, ctx).map((a) => [a.to, a.label, a.needsReason]), [
      ["COMPLETED", "Pass QA", false],
      ["IN_PROGRESS", "Fail QA", true],
    ]);
    for (const s of TASK_STATUSES.filter((s) => s !== "IN_QA")) assert.deepEqual(availableActions(s, tester, ctx), [], s);
  });

  it("when QA is required, review and work never complete directly", () => {
    const manager = { manager: true, assignee: false };
    const q = { ...ctx, qaRequired: true };
    assert.deepEqual(availableActions("IN_REVIEW", manager, q).map((a) => a.to), ["IN_QA", "IN_PROGRESS", "CANCELLED"]);
    assert.ok(!availableActions("IN_PROGRESS", manager, q).some((a) => a.to === "COMPLETED"));
    assert.ok(availableActions("IN_QA", manager, q).some((a) => a.to === "COMPLETED"));
  });

  it("open defects block QA and completion, not rework", () => {
    const manager = { manager: true, assignee: false };
    const d = { ...ctx, openDefects: 1 };
    const review = availableActions("IN_REVIEW", manager, d);
    assert.equal(review.find((a) => a.to === "IN_QA")!.blockedBy, "Resolve 1 open defect first.");
    assert.equal(review.find((a) => a.to === "IN_PROGRESS")!.blockedBy, null);
    assert.equal(availableActions("IN_QA", manager, { ...ctx, openDefects: 2 }).find((a) => a.to === "COMPLETED")!.blockedBy, "Resolve 2 open defects first.");
  });

  it("dependencies do not block failing QA or reopening", () => {
    const manager = { manager: true, assignee: false };
    const waiting = { ...ctx, openDependencies: 1 };
    assert.equal(availableActions("IN_QA", manager, waiting).find((a) => a.to === "IN_PROGRESS")!.blockedBy, null);
    assert.equal(availableActions("COMPLETED", manager, waiting).find((a) => a.to === "IN_PROGRESS")!.blockedBy, null);
  });
});
