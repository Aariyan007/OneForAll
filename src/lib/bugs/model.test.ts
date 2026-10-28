import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUG_STATUSES, BUG_TRANSITIONS, canMoveBug } from "./model";

test("every status has a transition entry and only known targets", () => {
  for (const status of BUG_STATUSES) {
    assert.ok(BUG_TRANSITIONS[status], status);
    for (const target of BUG_TRANSITIONS[status]) assert.ok(BUG_STATUSES.includes(target), `${status} -> ${target}`);
  }
});

test("a bug cannot skip the review stages or be resolved straight from a fix", () => {
  assert.equal(canMoveBug("FIX_APPLIED", "RESOLVED"), false);
  assert.equal(canMoveBug("CODE_REVIEW", "RESOLVED"), false);
  assert.equal(canMoveBug("QA_VERIFICATION", "RESOLVED"), true);
  assert.equal(canMoveBug("DETECTED", "FIX_APPLIED"), false);
  assert.equal(canMoveBug("RESOLVED", "REOPENED"), true);
});

test("the SQL transition table matches the TypeScript one exactly", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20261029000002_bugs.sql", import.meta.url), "utf8");
  const block = sql.slice(sql.indexOf("-- BEGIN bug transitions"), sql.indexOf("-- END bug transitions"));
  const pairs = [...block.matchAll(/\('([A-Z_]+)',\s*'([A-Z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
  const expected = Object.entries(BUG_TRANSITIONS)
    .flatMap(([from, targets]) => targets.map((to) => `${from}>${to}`))
    .sort();
  assert.deepEqual(pairs, expected);
});
