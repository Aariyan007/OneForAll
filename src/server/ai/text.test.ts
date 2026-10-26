// Unit tests for text handling before anything reaches a model: secret redaction, source excerpts, stack-trace and
// log compression, JSON extraction and citation checks.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateCitations } from "./citations";
import { collapseRepeatedLines, extractJson, numberedExcerpt, stackFrames } from "./context";
import { redactSecrets } from "./redact";

describe("redactSecrets", () => {
  it("removes common credentials and reports how many", () => {
    const text = [
      `const token = "ghp_${"A".repeat(36)}";`,
      "aws = AKIA" + "B".repeat(16),
      'password: "hunter22"',
      "API_KEY=sk-live-" + "c".repeat(24),
      "url = postgres://admin:s3cret@db.internal:5432/app",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const result = redactSecrets(text);
    assert.ok(result.count >= 6, `redacted ${result.count}`);
    assert.ok(!result.text.includes("ghp_AAAA"));
    assert.ok(!result.text.includes("AKIABBBB"));
    assert.ok(!result.text.includes("hunter22"));
    assert.ok(!result.text.includes("sk-live-ccc"));
    assert.ok(!result.text.includes("s3cret"));
    assert.ok(!result.text.includes("MIIEow"));
    assert.match(result.text, /\[REDACTED\]/);
  });

  it("leaves ordinary code alone", () => {
    const code = "export function add(a: number, b: number) {\n  const passwordLength = 12;\n  return a + b;\n}";
    assert.deepEqual(redactSecrets(code), { text: code, count: 0 });
  });
});

describe("numberedExcerpt", () => {
  const content = ["a", "b", "c", "d", "e"].join("\n");
  it("numbers lines from 1 and clamps the range", () => {
    assert.deepEqual(numberedExcerpt(content, 2, 3), { text: "2| b\n3| c", startLine: 2, endLine: 3, totalLines: 5 });
    assert.deepEqual(numberedExcerpt(content, 4, 99), { text: "4| d\n5| e", startLine: 4, endLine: 5, totalLines: 5 });
  });

  it("caps very long excerpts", () => {
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n");
    const excerpt = numberedExcerpt(long, 1, 1000, 400);
    assert.equal(excerpt.endLine, 400);
  });

  it("treats a trailing newline as the end of the last line", () => {
    assert.equal(numberedExcerpt("x\ny\n", 1, 10).totalLines, 2);
  });
});

describe("log and stack-trace compression", () => {
  it("collapses runs of identical lines", () => {
    assert.equal(collapseRepeatedLines("a\nb\nb\nb\nb\nc"), "a\nb\n[... previous line repeated 3 more times]\nc");
  });

  it("extracts JS and Python frames as path and line", () => {
    const js = "Error: boom\n    at TaskStore.complete (src/tasks/store.ts:24:10)\n    at main (/app/node_modules/x/index.js:1:1)";
    assert.deepEqual(stackFrames(js), [{ path: "src/tasks/store.ts", line: 24 }]);
    const py = 'Traceback (most recent call last):\n  File "scripts/report.py", line 9, in summarize\n  File "/usr/lib/python3.12/x.py", line 3';
    assert.deepEqual(stackFrames(py), [{ path: "scripts/report.py", line: 9 }]);
  });
});

describe("extractJson", () => {
  it("accepts plain JSON and fenced JSON", () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('Here you go:\n```json\n{"a":2}\n```'), { a: 2 });
  });

  it("returns null for text without a JSON object", () => {
    assert.equal(extractJson("no json here"), null);
    assert.equal(extractJson("```json\n{broken\n```"), null);
  });
});

describe("validateCitations", () => {
  const lineCounts = new Map([["src/a.ts", 10], ["src/b.ts", 3]]);
  it("keeps citations inside known files and line ranges, drops the rest", () => {
    const result = validateCitations(
      [
        { path: "src/a.ts", startLine: 2, endLine: 4 },
        { path: "src/a.ts", startLine: 9, endLine: 12 },
        { path: "src/missing.ts", startLine: 1, endLine: 1 },
        { path: "src/b.ts", startLine: 3, endLine: 1 },
        { path: "../etc/passwd", startLine: 1, endLine: 1 },
      ],
      lineCounts,
    );
    assert.deepEqual(result.valid, [{ path: "src/a.ts", startLine: 2, endLine: 4 }]);
    assert.equal(result.dropped, 4);
  });

  it("removes duplicates", () => {
    const result = validateCitations([{ path: "src/b.ts", startLine: 1, endLine: 2 }, { path: "src/b.ts", startLine: 1, endLine: 2 }], lineCounts);
    assert.equal(result.valid.length, 1);
    assert.equal(result.dropped, 0);
  });
});
