import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFileEdges } from "./build";
import { aggregateEdges, buildTree, layout, visibleNodeIds } from "./tree";

const files = [
  { path: "src/app.ts", content: `import { add } from "./util/math";\nimport "./util/missing";` },
  { path: "src/util/math.ts", content: "export const add = 1;" },
  { path: "src/util/strings.ts", content: `import { add } from "./math";` },
  { path: "README.md", content: "# hi" },
  { path: "pkg/a.py", content: "import os\nfrom . import b" },
  { path: "pkg/b.py", content: "x = 1" },
];

describe("buildFileEdges", () => {
  it("resolves edges across all files and counts unresolved local imports", () => {
    const r = buildFileEdges(files);
    assert.deepEqual(
      r.edges.map((e) => `${e.source}>${e.target}`).sort(),
      ["pkg/a.py>pkg/b.py", "src/app.ts>src/util/math.ts", "src/util/strings.ts>src/util/math.ts"],
    );
    assert.equal(r.unresolvedLocal, 1);
    assert.equal(r.filesScanned, 5, "markdown is not scanned");
  });
});

describe("buildTree", () => {
  const tree = buildTree(files.map((f) => f.path));
  it("creates directory nodes with a repository root and counts files per directory", () => {
    assert.equal(tree.root.kind, "repository");
    const src = tree.byPath.get("src")!;
    assert.equal(src.kind, "directory");
    assert.equal(src.fileCount, 3);
    assert.equal(tree.byPath.get("src/util")!.fileCount, 2);
    assert.equal(tree.byPath.get("README.md")!.kind, "file");
  });
  it("lists children directories first, then files, alphabetically", () => {
    assert.deepEqual(tree.root.children.map((c) => c.name), ["pkg", "src", "README.md"]);
  });
});

describe("visible nodes, layout and aggregated edges", () => {
  const tree = buildTree(files.map((f) => f.path));
  const edges = buildFileEdges(files).edges.map((e) => [e.source, e.target] as const);

  it("shows only the repository and its direct children when nothing is expanded", () => {
    const ids = visibleNodeIds(tree, new Set());
    assert.deepEqual([...ids].sort(), ["", "README.md", "pkg", "src"].sort());
  });
  it("expanding a directory reveals its children", () => {
    const ids = visibleNodeIds(tree, new Set(["src"]));
    assert.ok(ids.has("src/app.ts") && ids.has("src/util") && !ids.has("src/util/math.ts"));
  });
  it("rolls file edges up to the nearest visible ancestor and drops internal ones", () => {
    const collapsed = aggregateEdges(tree, edges, visibleNodeIds(tree, new Set()));
    assert.deepEqual(collapsed, []); // every import stays inside pkg or inside src
    const half = aggregateEdges(tree, edges, visibleNodeIds(tree, new Set(["src"])));
    assert.deepEqual(half.map((e) => `${e.from}>${e.to}:${e.count}`), ["src/app.ts>src/util:1"]);
  });
  it("places nodes in depth columns, one row per node, in tree order", () => {
    const ids = visibleNodeIds(tree, new Set(["src"]));
    const l = layout(tree, ids);
    assert.equal(l.get("")!.x, 0);
    assert.equal(l.get("src")!.x, l.get("src/app.ts")!.x - 1);
    const ys = [...l.values()].map((p) => p.y);
    assert.equal(new Set(ys).size, ys.length, "no two nodes share a row");
  });
});
