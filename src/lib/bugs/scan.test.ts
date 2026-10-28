import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SCAN_OPTIONS, bugFingerprint, planScan, unitRange, verifyEvidence, type ScanFile } from "./scan";

const file = (path: string, over: Partial<ScanFile> = {}): ScanFile => ({ path, language: "TypeScript", sizeBytes: 2000, hasText: true, symbols: 5, inDegree: 0, ...over });

test("planScan skips what is not worth scanning and says why", () => {
  const plan = planScan([
    file("src/a.ts"),
    file("package-lock.json", { language: "JSON" }),
    file("dist/bundle.js"),
    file("README.md"),
    file("logo.png", { hasText: false }),
    file("src/huge.ts", { sizeBytes: 500_000 }),
  ]);
  assert.deepEqual(plan.batches, [{ units: [{ path: "src/a.ts" }] }]);
  const reasons = Object.fromEntries(plan.skipped.map((s) => [s.path, s.reason]));
  assert.deepEqual(reasons, { "package-lock.json": "generated", "dist/bundle.js": "generated", "README.md": "not_source", "logo.png": "no_text", "src/huge.ts": "too_large" });
  assert.equal(plan.filesTotal, 6);
});

test("planScan puts hub files first, tests last, and respects the file cap and batch limits", () => {
  const files = [file("src/leaf.ts"), file("test/leaf.test.ts"), file("src/hub.ts", { inDegree: 9 })];
  for (let i = 0; i < 10; i++) files.push(file(`src/f${i}.ts`, { sizeBytes: 15_000 }));
  const plan = planScan(files, { ...DEFAULT_SCAN_OPTIONS, maxFiles: 6 });
  assert.equal(plan.batches[0].units[0].path, "src/hub.ts");
  assert.equal(plan.filesPlanned, 6);
  assert.ok(plan.batches.every((b) => b.units.length <= DEFAULT_SCAN_OPTIONS.maxFilesPerBatch));
  assert.ok(plan.skipped.some((s) => s.reason === "over_file_cap"));
  assert.ok(!plan.batches.flatMap((b) => b.units.map((u) => u.path)).includes("test/leaf.test.ts"));
});

test("planScan keeps each batch within the byte budget", () => {
  const files = Array.from({ length: 8 }, (_, i) => file(`src/m${i}.ts`, { sizeBytes: 20_000 }));
  const plan = planScan(files);
  for (const batch of plan.batches) {
    const bytes = batch.units.length * 20_000;
    assert.ok(bytes <= DEFAULT_SCAN_OPTIONS.batchBytes || batch.units.length === 1);
  }
});

const SOURCE = ["function load(id) {", "  const row = db.get(id);", "  return row.name.toUpperCase();", "}", "", "export default load;"].join("\n");

test("verifyEvidence accepts a quote at the cited lines, ignoring whitespace and line numbers", () => {
  assert.equal(verifyEvidence("3|   return   row.name.toUpperCase();", SOURCE, 3, 3), true);
  assert.equal(verifyEvidence("const row = db.get(id);\nreturn row.name.toUpperCase();", SOURCE, 2, 3), true);
});

test("verifyEvidence rejects invented or misplaced quotes", () => {
  assert.equal(verifyEvidence("row.name?.trim()", SOURCE, 3, 3), false);
  assert.equal(verifyEvidence("export default load;", SOURCE, 1, 1), false); // real code, but not near the cited lines
  assert.equal(verifyEvidence("x", SOURCE, 1, 1), false);
});

test("bugFingerprint is stable under whitespace and line numbers, and differs across files and code", () => {
  const a = bugFingerprint("src/a.ts", "3| return row.name.toUpperCase();");
  assert.equal(a, bugFingerprint("src/a.ts", "return   row.name.toUpperCase();"));
  assert.notEqual(a, bugFingerprint("src/b.ts", "return row.name.toUpperCase();"));
  assert.notEqual(a, bugFingerprint("src/a.ts", "return row.title.toUpperCase();"));
  assert.equal(a.length, 40);
});

test("a large file is split into line-range parts instead of being skipped", () => {
  const plan = planScan([file("src/big.ts", { sizeBytes: 100_000 }), file("src/small.ts")]);
  const bigUnits = plan.batches.flatMap((b) => b.units).filter((u) => u.path === "src/big.ts");
  assert.equal(bigUnits.length, 4);
  assert.deepEqual(bigUnits.map((u) => [u.part, u.parts]), [[1, 4], [2, 4], [3, 4], [4, 4]]);
  assert.equal(plan.filesPlanned, 2);
  assert.ok(!plan.skipped.some((s) => s.path === "src/big.ts"));
  assert.equal(planScan([file("src/vast.ts", { sizeBytes: 900_000 })]).skipped[0].reason, "too_large");
});

test("the unit cap skips whole files rather than half a file", () => {
  const plan = planScan([file("src/a.ts", { sizeBytes: 100_000 }), file("src/b.ts", { sizeBytes: 100_000 })], { ...DEFAULT_SCAN_OPTIONS, maxUnits: 5 });
  assert.equal(plan.filesPlanned, 1);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["over_file_cap"]);
});

test("unitRange covers the whole file once, with a small overlap between parts", () => {
  assert.deepEqual(unitRange({ path: "a" }, 100), { start: 1, end: 100 });
  const ranges = [1, 2, 3].map((part) => unitRange({ path: "a", part, parts: 3 }, 300));
  assert.deepEqual(ranges, [{ start: 1, end: 100 }, { start: 86, end: 200 }, { start: 186, end: 300 }]);
  assert.equal(unitRange({ path: "a", part: 3, parts: 3 }, 299).end, 299);
});

test("files already scanned with the same content are skipped on a rescan, and counted as saved", () => {
  const plan = planScan([file("src/a.ts", { unchanged: true }), file("src/b.ts"), file("src/c.ts", { unchanged: true, sizeBytes: 9000 })]);
  assert.deepEqual(plan.batches, [{ units: [{ path: "src/b.ts" }] }]);
  assert.deepEqual(plan.skipped.map((s) => s.reason).sort(), ["unchanged", "unchanged"]);
  assert.equal(plan.filesPlanned, 1);
});
