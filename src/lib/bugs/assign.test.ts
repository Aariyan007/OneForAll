import assert from "node:assert/strict";
import { test } from "node:test";
import { type Candidate, planAutoAssignment, rankCandidates } from "./assign";

const person = (userId: string, over: Partial<Candidate> = {}): Candidate => ({
  userId, name: userId, role: "MEMBER", jobTitle: null, availability: "AVAILABLE", onProjectTeam: false, skills: [], openBugs: 0, openTasks: 0, ...over,
});
const bug = { category: "frontend", severity: "HIGH", filePath: "src/ui/CartView.tsx" };

test("skills for the bug's category and language beat an unrelated colleague", () => {
  const ranked = rankCandidates([person("backend", { skills: ["Node", "SQL"] }), person("ui", { skills: ["React", "CSS"] })], bug);
  assert.equal(ranked[0].candidate.userId, "ui");
  assert.match(ranked[0].reasons.join(" "), /skills for frontend: React, CSS/);
});

test("the project's team and a light workload matter, and every point has a stated reason", () => {
  const ranked = rankCandidates([person("a", { onProjectTeam: true, openBugs: 3 }), person("b", { onProjectTeam: true, openBugs: 0 }), person("c", {})], bug);
  assert.deepEqual(ranked.map((r) => r.candidate.userId), ["b", "c", "a"]);
  assert.equal(ranked[0].candidate.userId, "b");
  assert.ok(ranked[0].reasons.includes("on this project's team"));
  assert.ok(ranked.find((r) => r.candidate.userId === "a")!.reasons.some((r) => r.includes("3 open bugs")));
});

test("unavailable people are never ranked and busy people are penalised", () => {
  const ranked = rankCandidates([person("gone", { availability: "UNAVAILABLE", skills: ["React"] }), person("busy", { availability: "BUSY", skills: ["React"] }), person("free", { skills: ["React"] })], bug);
  assert.ok(!ranked.some((r) => r.candidate.userId === "gone"));
  assert.equal(ranked[0].candidate.userId, "free");
});

test("owners and admins are chosen only when no employee is eligible", () => {
  assert.equal(rankCandidates([person("boss", { role: "OWNER", skills: ["React"] }), person("emp", {})], bug)[0].candidate.userId, "emp");
  assert.equal(rankCandidates([person("boss", { role: "OWNER" })], bug)[0].candidate.userId, "boss");
});

test("ties break deterministically", () => {
  const a = rankCandidates([person("b"), person("a")], bug).map((r) => r.candidate.userId);
  const b = rankCandidates([person("a"), person("b")], bug).map((r) => r.candidate.userId);
  assert.deepEqual(a, b);
});

test("a batch spreads over the team: each assignment counts against that person's workload", () => {
  const bugs = ["1", "2", "3", "4"].map((id) => ({ id, ...bug, severity: "MEDIUM" }));
  const plan = planAutoAssignment(bugs, [person("x", { skills: ["React"] }), person("y", { skills: ["React"] })]);
  const counts = plan.reduce<Record<string, number>>((acc, p) => ((acc[p.userId ?? "none"] = (acc[p.userId ?? "none"] ?? 0) + 1), acc), {});
  assert.deepEqual(counts, { x: 2, y: 2 });
});

test("with nobody eligible a bug stays unassigned and says why", () => {
  const plan = planAutoAssignment([{ id: "1", ...bug }], [person("gone", { availability: "UNAVAILABLE" })]);
  assert.equal(plan[0].userId, null);
  assert.match(plan[0].reason, /No eligible person/);
});
