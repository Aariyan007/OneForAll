import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreResult } from "./eval-score";

const qa = { answer: "findOverdue uses > so it returns future tasks", citations: [{ path: "src/tasks/store.ts", startLine: 33, endLine: 36 }] };

describe("scoreResult", () => {
  it("passes when every pattern matches and every expected file is cited", () => {
    const score = scoreResult("code_qa", qa, { matches: ["findOverdue", "future"], cites: ["src/tasks/store.ts"] }, null);
    assert.deepEqual(score, { passed: 3, total: 3, failures: [] });
  });

  it("reports each failed check", () => {
    const score = scoreResult("code_qa", qa, { matches: ["millisecond"], cites: ["src/auth/session.ts"] }, null);
    assert.equal(score.passed, 0);
    assert.equal(score.total, 2);
    assert.deepEqual(score.failures, ["matches /millisecond/", "cites src/auth/session.ts"]);
  });

  it("reads locations from trace links and review findings", () => {
    const trace = { summary: "s", links: [{ path: "src/tasks/store.ts", startLine: 1, endLine: 2 }], gaps: [] };
    assert.equal(scoreResult("requirement_trace", trace, { cites: ["src/tasks/store.ts"] }, null).passed, 1);
    const review = { summary: "s", findings: [{ path: "src/auth/session.ts", startLine: 5, endLine: 6 }] };
    assert.equal(scoreResult("code_review", review, { cites: ["src/auth/session.ts"] }, null).passed, 1);
  });

  it("checks generated content and the syntax result", () => {
    const generated = { content: "test('x', () => { priorityScore({ done: false }) })" };
    const score = scoreResult("generate", generated, { syntaxValid: true, contentMatches: ["done"], contentNotMatches: ["completed:"] }, true);
    assert.deepEqual(score, { passed: 3, total: 3, failures: [] });
    assert.equal(scoreResult("generate", generated, { syntaxValid: true }, false).passed, 0);
  });

  it("counts a run without a result as failing every check", () => {
    const score = scoreResult("code_qa", null, { matches: ["a", "b"], cites: ["x"] }, null);
    assert.deepEqual(score, { passed: 0, total: 3, failures: ["no result"] });
  });
});
