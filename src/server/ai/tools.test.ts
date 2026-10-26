// Tool registry: argument validation (model output is untrusted), path confinement, output caps and redaction.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "./test-support";
import { TOOLS, isSafeRepoPath, runTool, toolDeclarations } from "./tools";

const files = {
  "src/tasks/store.ts": Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n"),
  "src/config.ts": `export const TOKEN = "ghp_${"A".repeat(36)}";\nexport const PORT = 3000;\n`,
};

describe("isSafeRepoPath", () => {
  it("accepts normal relative paths", () => {
    assert.equal(isSafeRepoPath("src/tasks/store.ts"), true);
    assert.equal(isSafeRepoPath("README.md"), true);
  });

  it("refuses traversal, absolute paths and odd characters", () => {
    for (const path of ["../secret", "src/../../x", "/etc/passwd", "C:/x", "src\\a.ts", "src//a.ts", "./a.ts", "a\u0000b", "", "x".repeat(1025)]) {
      assert.equal(isSafeRepoPath(path), false, JSON.stringify(path));
    }
  });
});

describe("runTool", () => {
  const ctx = () => ({ reader: memoryReader(files), lineCounts: new Map<string, number>() });

  it("reads a file range with line numbers and records the file's length", async () => {
    const c = ctx();
    const result = await runTool("read_file", { path: "src/tasks/store.ts", startLine: 10, endLine: 12 }, c);
    assert.equal(result.ok, true);
    assert.equal(result.output.text, "10| line 10\n11| line 11\n12| line 12");
    assert.equal(result.output.totalLines, 600);
    assert.equal(c.lineCounts.get("src/tasks/store.ts"), 600);
  });

  it("caps a read at 400 lines and says so", async () => {
    const result = await runTool("read_file", { path: "src/tasks/store.ts" }, ctx());
    assert.equal(result.output.endLine, 400);
    assert.equal(result.output.truncated, true);
  });

  it("refuses paths outside the snapshot without touching the reader", async () => {
    const c = ctx();
    const result = await runTool("read_file", { path: "../../etc/passwd" }, c);
    assert.equal(result.ok, false);
    assert.equal(c.reader.reads.length, 0);
  });

  it("reports a missing file instead of inventing content", async () => {
    const result = await runTool("read_file", { path: "src/nope.ts" }, ctx());
    assert.equal(result.ok, false);
    assert.match(String(result.output.error), /not in this snapshot/);
  });

  it("redacts secrets in tool output", async () => {
    const result = await runTool("read_file", { path: "src/config.ts" }, ctx());
    assert.ok(!String(result.output.text).includes("ghp_AAAA"));
    assert.equal(result.output.redactions, 1);
  });

  it("rejects invalid arguments and unknown tools", async () => {
    assert.equal((await runTool("search_code", { query: "x" }, ctx())).ok, false, "query too short");
    assert.equal((await runTool("search_code", { query: "line", limit: 999 }, ctx())).ok, false, "limit too high");
    assert.equal((await runTool("read_file", { path: 42 }, ctx())).ok, false, "wrong type");
    assert.equal((await runTool("delete_repo", {}, ctx())).ok, false, "unknown tool");
  });

  it("searches code and lists files with caps", async () => {
    const search = await runTool("search_code", { query: "3000", limit: 5 }, ctx());
    assert.deepEqual(search.output.matches, [{ path: "src/config.ts", line: 2, text: "export const PORT = 3000;" }]);
    const list = await runTool("list_files", { prefix: "src/tasks/" }, ctx());
    assert.deepEqual(
      (list.output.files as { path: string }[]).map((f) => f.path),
      ["src/tasks/store.ts"],
    );
  });
});

describe("toolDeclarations", () => {
  it("exposes only the requested read-only tools with JSON schemas", () => {
    const declarations = toolDeclarations(["read_file", "search_code"]);
    assert.deepEqual(declarations.map((d) => d.name), ["read_file", "search_code"]);
    for (const declaration of declarations) assert.equal(declaration.parameters.type, "object");
    assert.ok(Object.values(TOOLS).every((tool) => tool.sideEffects === "none"), "every tool is read-only");
  });
});
