import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyFindings, type RawFinding } from "./findings";

const TEXT = ["export function load(id) {", "  const row = db.get(id);", "  return row.name.toUpperCase();", "}"].join("\n");
const base: RawFinding = {
  title: "Null dereference",
  category: "backend",
  severity: "high",
  severityReason: "crashes when the row is missing",
  path: "a.ts",
  startLine: 3,
  endLine: 3,
  description: "row can be undefined",
  evidence: "3| return row.name.toUpperCase();",
  confidence: 0.84,
  suggestedFix: "guard row",
  validationSteps: "call load with an unknown id",
};
const read = async (p: string) => (p === "a.ts" ? TEXT : null);

test("a finding whose evidence is at the cited lines is kept, normalised and fingerprinted", async () => {
  const { stored, dropped } = await verifyFindings([base], new Set(["a.ts"]), read);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].severity, "HIGH");
  assert.equal(stored[0].evidence, "return row.name.toUpperCase();");
  assert.match(stored[0].fingerprint, /^[0-9a-f]{40}$/);
  assert.deepEqual(dropped, { notInBatch: 0, badLines: 0, evidenceNotFound: 0, duplicate: 0 });
});

test("invented evidence, files outside the batch and impossible lines are dropped and counted", async () => {
  const { stored, dropped } = await verifyFindings(
    [
      { ...base, evidence: "row.name?.trim()" },
      { ...base, path: "other.ts" },
      { ...base, startLine: 3, endLine: 99 },
      { ...base, startLine: 0 },
    ],
    new Set(["a.ts"]),
    read,
  );
  assert.equal(stored.length, 0);
  assert.deepEqual(dropped, { notInBatch: 1, badLines: 2, evidenceNotFound: 1, duplicate: 0 });
});

test("the same code reported twice in one batch is stored once", async () => {
  const { stored, dropped } = await verifyFindings([base, { ...base, title: "Possible crash", category: "api" }], new Set(["a.ts"]), read);
  assert.equal(stored.length, 1);
  assert.equal(dropped.duplicate, 1);
});

test("confidence is clamped and rounded", async () => {
  const { stored } = await verifyFindings([{ ...base, confidence: 0.8449 }], new Set(["a.ts"]), read);
  assert.equal(stored[0].confidence, 0.84);
});
