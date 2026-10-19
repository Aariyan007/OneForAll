// Unit tests for the deterministic assignment ranking (pure).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Candidate, DEFAULT_UNESTIMATED_HOURS, MAX_LOAD_HOURS, automaticChoice, rankCandidates } from "./assignment";

const base: Omit<Candidate, "userId" | "name"> = {
  availability: "AVAILABLE",
  inTaskTeam: true,
  matchedSkills: 1,
  requiredSkills: 1,
  activeTasks: 0,
  activeHours: 0,
  unestimatedTasks: 0,
};
const c = (userId: string, patch: Partial<Candidate> = {}): Candidate => ({ ...base, userId, name: userId, ...patch });

describe("rankCandidates", () => {
  it("prefers better skill coverage over lighter workload", () => {
    const r = rankCandidates([c("b", { matchedSkills: 1, requiredSkills: 2, activeHours: 0 }), c("a", { matchedSkills: 2, requiredSkills: 2, activeHours: 20 })], { estimatedHours: 2, requiredSkills: 2 });
    assert.deepEqual(r.ranked.map((x) => x.userId), ["a", "b"]);
  });

  it("excludes unavailable people and people with none of the required skills", () => {
    const r = rankCandidates([c("u", { availability: "UNAVAILABLE" }), c("n", { matchedSkills: 0 }), c("ok")], { estimatedHours: 1, requiredSkills: 1 });
    assert.deepEqual(r.ranked.map((x) => x.userId), ["ok"]);
    assert.deepEqual(r.ineligible.map((x) => [x.candidate.userId, x.reason]), [["u", "Marked unavailable."], ["n", "Has none of the required skills."]]);
  });

  it("ranks AVAILABLE before BUSY, then by load (unestimated tasks count as the default), then task count, team, id", () => {
    const r = rankCandidates(
      [
        c("busy", { availability: "BUSY" }),
        c("heavy", { activeHours: 10 }),
        c("unestimated", { activeTasks: 2, unestimatedTasks: 2 }), // 8 h
        c("light-outsider", { activeHours: 2, activeTasks: 1, inTaskTeam: false }),
        c("light-team", { activeHours: 2, activeTasks: 1 }),
        c("light-team-b", { activeHours: 2, activeTasks: 1 }),
      ],
      { estimatedHours: 3, requiredSkills: 1 },
    );
    assert.deepEqual(r.ranked.map((x) => x.userId), ["light-team", "light-team-b", "light-outsider", "unestimated", "heavy", "busy"]);
    assert.equal(r.ranked.find((x) => x.userId === "unestimated")!.loadHours, 2 * DEFAULT_UNESTIMATED_HOURS);
  });

  it("is deterministic: input order does not matter", () => {
    const people = [c("z"), c("y"), c("x", { activeHours: 1 }), c("w", { availability: "BUSY" })];
    const a = rankCandidates(people, { estimatedHours: 1, requiredSkills: 1 }).ranked.map((x) => x.userId);
    const b = rankCandidates([...people].reverse(), { estimatedHours: 1, requiredSkills: 1 }).ranked.map((x) => x.userId);
    assert.deepEqual(a, b);
    assert.deepEqual(a, ["y", "z", "x", "w"]);
  });

  it("puts overloaded people last for recommendations and excludes them for automatic assignment", () => {
    const people = [c("over", { activeHours: MAX_LOAD_HOURS - 1 }), c("fine", { activeHours: 10, matchedSkills: 1 })];
    const rec = rankCandidates(people, { estimatedHours: 5, requiredSkills: 1 });
    assert.deepEqual(rec.ranked.map((x) => x.userId), ["fine", "over"]);
    assert.ok(rec.ranked[1].overloaded && rec.ranked[1].reasons.some((r) => /exceed/.test(r)));
    const auto = rankCandidates(people, { estimatedHours: 5, requiredSkills: 1 }, { automatic: true });
    assert.deepEqual(auto.ranked.map((x) => x.userId), ["fine"]);
    assert.match(auto.ineligible[0].reason, /exceed/);
  });

  it("without required skills: workload only, clearly noted, and automatic assignment refuses", () => {
    const r = rankCandidates([c("a", { matchedSkills: 0, requiredSkills: 0, activeHours: 5 }), c("b", { matchedSkills: 0, requiredSkills: 0 })], { estimatedHours: null, requiredSkills: 0 });
    assert.deepEqual(r.ranked.map((x) => x.userId), ["b", "a"]);
    assert.ok(!r.skillsKnown);
    assert.match(r.note!, /No required skills/);
    const choice = automaticChoice(r);
    assert.equal(choice.userId, null);
  });

  it("no eligible candidate: empty ranking, explanation, no automatic choice", () => {
    const r = rankCandidates([c("a", { matchedSkills: 0 })], { estimatedHours: 2, requiredSkills: 2 });
    assert.equal(r.ranked.length, 0);
    assert.match(r.note!, /Nobody eligible/);
    assert.equal(automaticChoice(r).userId, null);
    assert.equal(automaticChoice(rankCandidates([], { estimatedHours: 1, requiredSkills: 1 })).userId, null);
  });

  it("automatic choice is the top-ranked person, with the reasons", () => {
    const choice = automaticChoice(rankCandidates([c("b", { activeHours: 3 }), c("a")], { estimatedHours: 1, requiredSkills: 1 }, { automatic: true }));
    assert.equal(choice.userId, "a");
    assert.ok("reasons" in choice && choice.reasons.length > 0);
  });
});
