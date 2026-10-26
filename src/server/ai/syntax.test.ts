// Generated code is checked with the same tree-sitter grammars as structure analysis before it is shown as valid.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkSyntax } from "./syntax";

describe("checkSyntax", () => {
  it("accepts valid TypeScript, JavaScript and Python", async () => {
    assert.equal(await checkSyntax("TypeScript", "import { x } from './a';\ntest('x', () => { const n: number = 1; });\n"), true);
    assert.equal(await checkSyntax("javascript", "describe('a', () => { it('b', () => {}); });\n"), true);
    assert.equal(await checkSyntax("Python", "def test_x():\n    assert 1 == 1\n"), true);
  });

  it("rejects code with syntax errors", async () => {
    assert.equal(await checkSyntax("TypeScript", "test('x', () => {\n"), false);
    assert.equal(await checkSyntax("Python", "def broken(:\n    pass\n"), false);
  });

  it("returns null for languages it cannot check", async () => {
    assert.equal(await checkSyntax("Rust", "fn main() {}"), null);
    assert.equal(await checkSyntax("Markdown", "# Title"), null);
  });
});
