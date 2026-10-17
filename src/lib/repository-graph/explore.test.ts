// Unit tests for explored views of large analyses (explore.ts) and the iterative layout (view.ts).
// FIXTURE DATA ONLY: generated rows, never shown as analysed repository data.
// Run: see docs/repository-graph.md ("Tests").
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPLETE_GRAPH_MAX_RELATIONSHIPS,
  COMPLETE_GRAPH_MAX_SYMBOLS,
  EMPTY_SUBGRAPH,
  EXPLORE_NODE_CAP,
  ancestorsOf,
  buildOverviewTree,
  decideGraphMode,
  loadedDegrees,
  mergePiece,
  subgraphAsGraph,
  subgraphStatus,
  visibleTreeRows,
} from "./explore";
import type { GraphEdge, GraphNode, GraphOverviewFile, GraphPiece } from "./types";
import { filterGraph, layoutGraph } from "./view";

const META = { analysisId: "a", snapshotId: "s", commitSha: "c".repeat(40), branch: "main" };

function node(id: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    label: id,
    qualifiedName: null,
    kind: "FUNCTION",
    fileId: "f1",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 1,
    visibility: null,
    signature: null,
    ...extra,
  };
}
function edge(id: string, source: string, target: string, relationshipType = "CONTAINS"): GraphEdge {
  return { id, source, target, relationshipType };
}
function neighbours(symbolId: string, nodes: GraphNode[], edges: GraphEdge[], edgesTotal = edges.length): GraphPiece {
  return { scope: { type: "neighbours", symbolId }, nodes, edges, symbolsTotal: 1, symbolsReturned: 1, edgesTotal, edgesReturned: edges.length, rejected: { nodes: 0, edges: 0 } };
}

describe("decideGraphMode", () => {
  it("small analyses are shown as the complete graph", () => {
    assert.equal(decideGraphMode(0, 0), "complete");
    assert.equal(decideGraphMode(COMPLETE_GRAPH_MAX_SYMBOLS, COMPLETE_GRAPH_MAX_RELATIONSHIPS), "complete");
  });
  it("analyses over the old 5,000-symbol limit (e.g. 13,506 / 11,227) are explored, not refused", () => {
    assert.equal(decideGraphMode(COMPLETE_GRAPH_MAX_SYMBOLS + 1, 0), "explore");
    assert.equal(decideGraphMode(13506, 11227), "explore");
    assert.equal(decideGraphMode(10, COMPLETE_GRAPH_MAX_RELATIONSHIPS + 1), "explore");
  });
});

describe("mergePiece: focused exploration and expansion", () => {
  const root = node("root", { degree: 2 });
  const a = node("a", { degree: 3 });
  const b = node("b", { degree: 1 });
  const first = neighbours("root", [root, a, b], [edge("e1", "root", "a"), edge("e2", "root", "b")]);

  it("a first piece gives the symbol and its immediate neighbours, with the root marked as expanded", () => {
    const r = mergePiece(EMPTY_SUBGRAPH, first);
    assert.ok(r.ok);
    assert.deepEqual(r.subgraph.nodes.map((n) => n.id).sort(), ["a", "b", "root"]);
    assert.deepEqual(r.subgraph.expanded, ["root"]);
    const status = subgraphStatus(r.subgraph);
    // root: complete (2/2); b: complete (1/1); a: 1 of 3 loaded -> 2 missing
    assert.equal(status.incompleteSymbols, 1);
    assert.equal(status.missingRelationships, 2);
    assert.equal(status.truncated, false);
  });

  it("expanding a neighbour adds its neighbours, de-duplicating nodes and edges", () => {
    const one = mergePiece(EMPTY_SUBGRAPH, first);
    assert.ok(one.ok);
    const c = node("c", { degree: 1 });
    const second = neighbours("a", [a, root, c], [edge("e1", "root", "a"), edge("e3", "a", "c"), edge("e4", "a", "b")]);
    const two = mergePiece(one.subgraph, second);
    assert.ok(two.ok);
    assert.equal(two.subgraph.nodes.length, 4, "b was not re-added; c was added");
    assert.deepEqual(two.subgraph.edges.map((e) => e.id).sort(), ["e1", "e2", "e3", "e4"]);
    assert.deepEqual([...two.subgraph.expanded].sort(), ["a", "root"]);
    assert.equal(subgraphStatus(two.subgraph).incompleteSymbols, 0, "every stored relationship of the shown symbols is now loaded");
  });

  it("never keeps an edge whose endpoint is missing", () => {
    const piece = neighbours("root", [root], [edge("dangling", "root", "ghost")]);
    const r = mergePiece(EMPTY_SUBGRAPH, piece);
    assert.ok(r.ok);
    assert.equal(r.subgraph.edges.length, 0);
  });

  it("refuses (instead of silently dropping) an expansion past the node cap", () => {
    const many = Array.from({ length: EXPLORE_NODE_CAP + 5 }, (_, i) => node(`n${i}`, { degree: 1 }));
    const hub = node("hub", { degree: many.length });
    const piece = neighbours("hub", [hub, ...many], many.map((n, i) => edge(`h${i}`, "hub", n.id)));
    const r = mergePiece(EMPTY_SUBGRAPH, piece);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.wouldHave, EXPLORE_NODE_CAP + 6);
  });

  it("a symbol with many neighbours past the request limit is reported as truncated and incomplete", () => {
    const hub = node("hub", { degree: 300 });
    const shown = Array.from({ length: 200 }, (_, i) => node(`m${i}`, { degree: 1 }));
    const piece = neighbours("hub", [hub, ...shown], shown.map((n, i) => edge(`x${i}`, "hub", n.id)), 300);
    const r = mergePiece(EMPTY_SUBGRAPH, piece, Number.POSITIVE_INFINITY);
    assert.ok(r.ok);
    const status = subgraphStatus(r.subgraph);
    assert.equal(status.truncated, true);
    assert.equal(loadedDegrees(r.subgraph).get("hub")!.missing, 100);
  });

  it("an isolated symbol is a complete one-node view", () => {
    const lonely = node("lonely", { degree: 0 });
    const r = mergePiece(EMPTY_SUBGRAPH, neighbours("lonely", [lonely], []));
    assert.ok(r.ok);
    const status = subgraphStatus(r.subgraph);
    assert.deepEqual([status.symbols, status.relationships, status.incompleteSymbols, status.truncated], [1, 0, 0, false]);
  });

  it("a file piece marks the file's own symbols as expanded, not the external ends", () => {
    const own = node("own", { fileId: "f1", degree: 1 });
    const ext = node("ext", { fileId: "f2", filePath: "src/b.ts", degree: 4 });
    const piece: GraphPiece = {
      scope: { type: "file", fileId: "f1", filePath: "src/a.ts" },
      nodes: [own, ext],
      edges: [edge("e", "own", "ext", "IMPORTS")],
      symbolsTotal: 1,
      symbolsReturned: 1,
      edgesTotal: 1,
      edgesReturned: 1,
      rejected: { nodes: 0, edges: 0 },
    };
    const r = mergePiece(EMPTY_SUBGRAPH, piece);
    assert.ok(r.ok);
    assert.deepEqual(r.subgraph.expanded, ["own"]);
    assert.equal(loadedDegrees(r.subgraph).get("ext")!.missing, 3);
  });

  it("the merged view renders as a graph that filters by relationship type", () => {
    const r = mergePiece(EMPTY_SUBGRAPH, neighbours("root", [root, a, b], [edge("e1", "root", "a", "CONTAINS"), edge("e2", "root", "b", "IMPORTS")]));
    assert.ok(r.ok);
    const graph = subgraphAsGraph(r.subgraph, META);
    assert.equal(graph.summary.totalNodes, 3);
    const visible = filterGraph(graph, { kinds: new Set(["FUNCTION"]), types: new Set(["IMPORTS"]), fileId: null, focusId: null });
    assert.deepEqual(visible.edges.map((e) => e.id), ["e2"]);
  });

  it("an empty piece gives an empty, complete view", () => {
    const r = mergePiece(EMPTY_SUBGRAPH, neighbours("x", [], []));
    assert.ok(r.ok);
    assert.deepEqual(subgraphStatus(r.subgraph), { symbols: 0, relationships: 0, expanded: 1, incompleteSymbols: 0, missingRelationships: 0, truncated: false });
  });
});

describe("overview tree", () => {
  const file = (path: string, symbols: number, relationships = 0, external = 0): GraphOverviewFile => ({
    fileId: path,
    path,
    symbols,
    relationships,
    externalRelationships: external,
  });

  it("aggregates counts per folder and shows only opened folders", () => {
    const tree = buildOverviewTree([file("src/a.ts", 3, 2), file("src/lib/b.ts", 5, 1, 1), file("README.md", 1)]);
    assert.deepEqual(tree.totals, { files: 3, symbols: 9, relationships: 3, externalRelationships: 1 });
    const closed = visibleTreeRows(tree, new Set());
    assert.deepEqual(closed.map((r) => `${r.type}:${r.path}`), ["dir:src", "file:README.md"]);
    const open = visibleTreeRows(tree, new Set(["src", "src/lib"]));
    assert.deepEqual(open.map((r) => `${r.type}:${r.path}:${r.depth}`), ["dir:src:0", "dir:src/lib:1", "file:src/lib/b.ts:2", "file:src/a.ts:1", "file:README.md:0"]);
    const src = open[0];
    assert.ok(src.type === "dir" && src.files === 2 && src.symbols === 8);
  });

  it("handles thousands of files and very deep paths without recursion", () => {
    const files: GraphOverviewFile[] = [];
    for (let i = 0; i < 6000; i++) files.push(file(`pkg${i % 50}/f${i}.ts`, 1));
    const deep = Array.from({ length: 3000 }, (_, i) => `d${i}`).join("/") + "/leaf.ts";
    files.push(file(deep, 2));
    const tree = buildOverviewTree(files);
    assert.equal(tree.totals.files, 6001);
    const all = visibleTreeRows(tree, new Set(ancestorsOf(deep)));
    assert.ok(all.some((r) => r.type === "file" && r.path === deep));
  });

  it("ancestorsOf lists the folders above a file", () => {
    assert.deepEqual(ancestorsOf("a/b/c.ts"), ["a", "a/b"]);
    assert.deepEqual(ancestorsOf("c.ts"), []);
  });
});

describe("layoutGraph is iterative (no recursion over containment depth)", () => {
  it("lays out a 50,000-deep containment chain without a stack overflow", () => {
    const depth = 50000;
    const nodes = Array.from({ length: depth }, (_, i) => node(`c${i}`, { startLine: i + 1 }));
    const edges = nodes.slice(1).map((n, i) => edge(`k${i}`, nodes[i].id, n.id));
    const layout = layoutGraph({ nodes, edges });
    assert.equal(layout.nodes.length, depth);
    const ys = new Map(layout.nodes.map((n) => [n.id, n.y]));
    assert.ok(ys.get("c1")! > ys.get("c0")!, "a contained symbol sits below its container");
  });

  it("lays out thousands of files (row width computed without argument spread)", () => {
    const nodes = Array.from({ length: 150000 }, (_, i) => node(`f${i}`, { fileId: `file${i}`, filePath: `src/${i}.ts` }));
    const layout = layoutGraph({ nodes, edges: [] });
    assert.equal(layout.files.length, 150000);
  });
});
