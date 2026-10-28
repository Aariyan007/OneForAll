import assert from "node:assert/strict";
import { test } from "node:test";
import { buildValidation, syntaxAliasFor, type FileValidationInput } from "./validate";

const ok: FileValidationInput = {
  path: "a.ts", storedHash: "h", baseHash: "h", reapplied: { ok: true, patched: "P", changedLines: 3 }, proposedPatched: "P", syntaxBefore: true, syntaxAfter: true,
};

test("a clean fix passes, and the tests check is honestly skipped", () => {
  const v = buildValidation([ok], ["npm test"]);
  assert.equal(v.passed, true);
  const tests = v.checks.find((c) => c.name === "Tests")!;
  assert.equal(tests.status, "SKIPPED");
  assert.match(tests.detail, /does not run tests.*npm test/);
});

test("a file that changed since the proposal fails the patch check", () => {
  const v = buildValidation([{ ...ok, storedHash: "other" }], []);
  assert.equal(v.passed, false);
  assert.equal(v.checks[0].status, "FAIL");
});

test("edits that no longer reproduce the proposed content fail", () => {
  assert.equal(buildValidation([{ ...ok, reapplied: { ok: false, error: "x" } }], []).passed, false);
  assert.equal(buildValidation([{ ...ok, reapplied: { ok: true, patched: "DIFFERENT", changedLines: 1 } }], []).passed, false);
});

test("a patch that breaks the syntax fails; an already-broken file or a file type without a parser is skipped", () => {
  assert.equal(buildValidation([{ ...ok, syntaxAfter: false }], []).passed, false);
  const already = buildValidation([{ ...ok, syntaxBefore: false, syntaxAfter: false }], []);
  assert.equal(already.passed, true);
  assert.equal(already.checks.find((c) => c.name.startsWith("Syntax"))!.status, "SKIPPED");
  const none = buildValidation([{ ...ok, syntaxBefore: null, syntaxAfter: null }], []);
  assert.equal(none.checks.find((c) => c.name.startsWith("Syntax"))!.status, "SKIPPED");
});

test("too large a change fails the scope check", () => {
  const v = buildValidation([{ ...ok, reapplied: { ok: true, patched: "P", changedLines: 500 } }], []);
  assert.equal(v.passed, false);
  assert.equal(v.checks.find((c) => c.name === "Scope")!.status, "FAIL");
});

test("syntaxAliasFor maps extensions to the parser aliases", () => {
  assert.equal(syntaxAliasFor("src/a.tsx"), "tsx");
  assert.equal(syntaxAliasFor("x.mjs"), "js");
  assert.equal(syntaxAliasFor("x.py"), "py");
  assert.equal(syntaxAliasFor("README.md"), null);
});
