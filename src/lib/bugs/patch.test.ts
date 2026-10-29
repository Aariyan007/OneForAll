import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits, unifiedDiff, type Edit } from "./patch";

const SOURCE = Array.from({ length: 30 }, (_, i) => `line ${i + 1};`).join("\n") + "\n";
const edit = (startLine: number, endLine: number, originalQuote: string, replacement: string): Edit => ({ path: "f.ts", startLine, endLine, originalQuote, replacement });

test("an edit replaces exactly the quoted lines", () => {
  const result = applyEdits(SOURCE, [edit(5, 5, "5| line 5;", "line five;\nextra;")]);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.match(result.patched, /line 4;\nline five;\nextra;\nline 6;/);
  assert.ok(result.patched.endsWith("line 30;\n"));
});

test("an edit whose quote is not the code at those lines is refused", () => {
  assert.equal(applyEdits(SOURCE, [edit(5, 5, "line 6;", "x")]).ok, false);
  assert.equal(applyEdits(SOURCE, [edit(40, 41, "nothing", "x")]).ok, false);
  assert.equal(applyEdits(SOURCE, [edit(2, 3, "line 2;\nline 3;", "a"), edit(3, 4, "line 3;\nline 4;", "b")]).ok, false);
  assert.equal(applyEdits(SOURCE, []).ok, false);
});

test("oversized edits are refused", () => {
  const big = Array.from({ length: 81 }, (_, i) => `line ${i + 1};`).join("\n");
  const text = big + "\n";
  assert.equal(applyEdits(text, [edit(1, 81, big, "x")]).ok, false);
});

test("deleting lines and CRLF files work", () => {
  const crlf = "a\r\nb\r\nc\r\n";
  const result = applyEdits(crlf, [edit(2, 2, "b", "")]);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.patched, "a\r\nc\r\n");
});

function gitApplies(before: string, diff: string): string {
  const dir = mkdtempSync(join(tmpdir(), "patch-"));
  writeFileSync(join(dir, "f.ts"), before);
  writeFileSync(join(dir, "p.diff"), diff);
  execFileSync("git", ["apply", "--check", "p.diff"], { cwd: dir });
  execFileSync("git", ["apply", "p.diff"], { cwd: dir });
  return readFileSync(join(dir, "f.ts"), "utf8");
}

test("the unified diff is accepted by `git apply` and produces the same file (single, merged and separate hunks)", () => {
  const cases: Edit[][] = [
    [edit(5, 5, "line 5;", "five;\nfive b;")],
    [edit(5, 6, "line 5;\nline 6;", "x;"), edit(9, 9, "line 9;", "y;")], // contexts touch: one merged hunk
    [edit(2, 2, "line 2;", "A;"), edit(20, 21, "line 20;\nline 21;", ""), edit(30, 30, "line 30;", "Z;\nZ2;")], // separate hunks, a deletion, the last line
    [edit(1, 1, "line 1;", "first;")],
  ];
  for (const edits of cases) {
    const applied = applyEdits(SOURCE, edits);
    assert.ok(applied.ok);
    if (!applied.ok) return;
    const diff = unifiedDiff("f.ts", SOURCE, applied.edits);
    assert.equal(gitApplies(SOURCE, diff), applied.patched);
  }
});
