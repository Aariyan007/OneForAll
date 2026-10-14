// Unit tests for the pure repository-graph modules (transform, filters, search, neighbourhood, layout).
// FIXTURE DATA ONLY: the rows below are hand-written test inputs, never shown as analysed repository data.
// Run: see docs/repository-graph.md ("Tests").
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRepositoryGraph, type RelationshipRow, type SymbolRow } from "./transform";
import { NODE_HEIGHT, filterGraph, layoutGraph, neighbourhood, searchNodes } from "./view";

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // analysis under test
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002"; // another analysis
const F1 = "f1f1f1f1-0000-4000-8000-000000000001";
const F2 = "f2f2f2f2-0000-4000-8000-000000000002";

function sym(id: string, name: string, kind: string, extra: Partial<SymbolRow> = {}): SymbolRow {
  return {
    id,
    analysis_id: A,
    file_id: F1,
    file_path: "src/service.ts",
    name,
    kind,
    qualified_name: null,
    signature: null,
    start_line: 0,
    start_column: 0,
    end_line: 0,
    visibility: null,
    ...extra,
  };
}

function rel(id: string, source: string, target: string, type: string, extra: Partial<RelationshipRow> = {}): RelationshipRow {
  return { id, analysis_id: A, source_symbol_id: source, target_symbol_id: target, relationship_type: type, ...extra };
}

const SYMBOLS: SymbolRow[] = [
  sym("s-mod", "service", "MODULE", { end_line: 30 }),
  sym("s-base", "Base", "CLASS", { start_line: 2, end_line: 5, qualified_name: "Base", visibility: "PUBLIC" }),
  sym("s-svc", "Service", "CLASS", { start_line: 7, end_line: 20, qualified_name: "Service", signature: "class Service extends Base" }),
  sym("s-run", "run", "METHOD", { start_line: 9, end_line: 12, qualified_name: "Service.run" }),
  sym("s-iface", "Runner", "INTERFACE", { start_line: 22, end_line: 24 }),
  sym("s-imp", "fs", "MODULE", { start_line: 0, start_column: 20 }),
  sym("s-py", "models", "MODULE", { file_id: F2, file_path: "app/models.py", end_line: 10 }),
  sym("s-dog", "Dog", "CLASS", { file_id: F2, file_path: "app/models.py", start_line: 3, end_line: 8, qualified_name: "Dog" }),
];

const RELATIONSHIPS: RelationshipRow[] = [
  rel("r1", "s-mod", "s-base", "CONTAINS"),
  rel("r2", "s-mod", "s-svc", "CONTAINS"),
  rel("r3", "s-svc", "s-run", "CONTAINS"),
  rel("r4", "s-mod", "s-iface", "CONTAINS"),
  rel("r5", "s-mod", "s-imp", "IMPORTS"),
  rel("r6", "s-svc", "s-base", "EXTENDS"),
  rel("r7", "s-svc", "s-iface", "IMPLEMENTS"),
  rel("r8", "s-py", "s-dog", "CONTAINS"),
];

function build(symbols = SYMBOLS, relationships = RELATIONSHIPS) {
  return buildRepositoryGraph({ analysisId: A, snapshotId: "snap", commitSha: "c".repeat(40), branch: "main", symbols, relationships });
}

const ALL_KINDS = new Set(["MODULE", "CLASS", "METHOD", "INTERFACE"]);
const ALL_TYPES = new Set(["CONTAINS", "IMPORTS", "EXTENDS", "IMPLEMENTS"]);

describe("buildRepositoryGraph", () => {
  it("turns valid symbols into nodes and valid relationships into edges, keeping database ids", () => {
    const graph = build();
    assert.equal(graph.nodes.length, SYMBOLS.length);
    assert.equal(graph.edges.length, RELATIONSHIPS.length);
    assert.deepEqual(new Set(graph.nodes.map((n) => n.id)), new Set(SYMBOLS.map((s) => s.id)));
    assert.deepEqual(new Set(graph.edges.map((e) => e.id)), new Set(RELATIONSHIPS.map((r) => r.id)));
    const r6 = graph.edges.find((e) => e.id === "r6")!;
    assert.deepEqual([r6.source, r6.target, r6.relationshipType], ["s-svc", "s-base", "EXTENDS"]); // direction preserved
    assert.deepEqual(graph.diagnostics, { rejectedNodes: 0, rejectedEdges: 0 });
  });

  it("is deterministic regardless of input order", () => {
    const a = build();
    const b = build([...SYMBOLS].reverse(), [...RELATIONSHIPS].reverse());
    assert.deepEqual(a.nodes, b.nodes);
    assert.deepEqual(a.edges, b.edges);
    assert.deepEqual(a.summary, b.summary);
  });

  it("maps fields and converts 0-based rows to 1-based lines; missing optionals stay null", () => {
    const node = build().nodes.find((n) => n.id === "s-svc")!;
    assert.equal(node.startLine, 8);
    assert.equal(node.endLine, 21);
    assert.equal(node.signature, "class Service extends Base");
    assert.equal(node.filePath, "src/service.ts");
    const iface = build().nodes.find((n) => n.id === "s-iface")!;
    assert.equal(iface.qualifiedName, null);
    assert.equal(iface.visibility, null);
    assert.equal(iface.signature, null);
  });

  it("keeps only one analysis: rows of another analysis are rejected, and edges into them are dropped", () => {
    const graph = build(
      [...SYMBOLS, sym("x-foreign", "Foreign", "CLASS", { analysis_id: OTHER })],
      [...RELATIONSHIPS, rel("r-foreign", "s-mod", "x-foreign", "CONTAINS"), rel("r-other", "s-mod", "s-run", "CONTAINS", { analysis_id: OTHER })],
    );
    assert.ok(!graph.nodes.some((n) => n.id === "x-foreign"));
    assert.ok(!graph.edges.some((e) => e.id === "r-foreign" || e.id === "r-other"));
    assert.deepEqual(graph.diagnostics, { rejectedNodes: 1, rejectedEdges: 2 });
  });

  it("never creates dangling, self, duplicate or unknown-type edges", () => {
    const graph = build(SYMBOLS, [
      ...RELATIONSHIPS,
      rel("r-dangling", "s-mod", "missing-symbol", "CONTAINS"),
      rel("r-self", "s-svc", "s-svc", "REFERENCES"),
      rel("r1", "s-mod", "s-run", "CONTAINS"), // duplicate id
      rel("r-unknown", "s-mod", "s-run", "INVENTED"),
    ]);
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) assert.ok(ids.has(edge.source) && ids.has(edge.target));
    assert.equal(graph.edges.length, RELATIONSHIPS.length);
    assert.equal(graph.diagnostics.rejectedEdges, 4);
  });

  it("rejects symbols with unknown kinds, empty names, bad lines or duplicate ids", () => {
    const graph = build([
      ...SYMBOLS,
      sym("bad-kind", "X", "WIDGET"),
      sym("bad-name", "  ", "CLASS"),
      sym("bad-line", "Y", "CLASS", { start_line: -1 }),
      sym("s-mod", "dup", "MODULE"),
    ]);
    assert.equal(graph.nodes.length, SYMBOLS.length);
    assert.equal(graph.diagnostics.rejectedNodes, 4);
  });

  it("gives an empty graph for an empty analysis", () => {
    const graph = build([], []);
    assert.deepEqual(graph.nodes, []);
    assert.deepEqual(graph.edges, []);
    assert.deepEqual(graph.summary, { totalNodes: 0, totalEdges: 0, nodesByKind: {}, edgesByType: {}, filesRepresented: 0 });
  });

  it("summary counts match the transformed data", () => {
    const { summary } = build();
    assert.equal(summary.totalNodes, 8);
    assert.equal(summary.totalEdges, 8);
    assert.deepEqual(summary.nodesByKind, { MODULE: 3, CLASS: 3, METHOD: 1, INTERFACE: 1 });
    assert.deepEqual(summary.edgesByType, { CONTAINS: 5, IMPORTS: 1, EXTENDS: 1, IMPLEMENTS: 1 });
    assert.equal(summary.filesRepresented, 2);
  });
});

describe("filterGraph", () => {
  const graph = build();

  it("returns everything with all filters on", () => {
    const v = filterGraph(graph, { kinds: ALL_KINDS, types: ALL_TYPES, fileId: null, focusId: null });
    assert.equal(v.nodes.length, 8);
    assert.equal(v.edges.length, 8);
  });

  it("kind filter removes nodes and every edge touching them", () => {
    const v = filterGraph(graph, { kinds: new Set(["MODULE", "CLASS"]), types: ALL_TYPES, fileId: null, focusId: null });
    const ids = new Set(v.nodes.map((n) => n.id));
    assert.ok(!ids.has("s-run") && !ids.has("s-iface"));
    for (const edge of v.edges) assert.ok(ids.has(edge.source) && ids.has(edge.target));
    assert.ok(!v.edges.some((e) => e.id === "r3" || e.id === "r7"));
  });

  it("relationship filter removes only those edges", () => {
    const v = filterGraph(graph, { kinds: ALL_KINDS, types: new Set(["CONTAINS"]), fileId: null, focusId: null });
    assert.equal(v.nodes.length, 8);
    assert.ok(v.edges.every((e) => e.relationshipType === "CONTAINS"));
    assert.equal(v.edges.length, 5);
  });

  it("file filter keeps one file", () => {
    const v = filterGraph(graph, { kinds: ALL_KINDS, types: ALL_TYPES, fileId: F2, focusId: null });
    assert.deepEqual(v.nodes.map((n) => n.id).sort(), ["s-dog", "s-py"]);
    assert.deepEqual(v.edges.map((e) => e.id), ["r8"]);
  });

  it("neighbourhood keeps the focus node and its direct neighbours with valid edges only", () => {
    const v = filterGraph(graph, { kinds: ALL_KINDS, types: ALL_TYPES, fileId: null, focusId: "s-svc" });
    assert.deepEqual(v.nodes.map((n) => n.id).sort(), ["s-base", "s-iface", "s-mod", "s-run", "s-svc"]);
    const ids = new Set(v.nodes.map((n) => n.id));
    for (const edge of v.edges) {
      assert.ok(edge.source === "s-svc" || edge.target === "s-svc");
      assert.ok(ids.has(edge.source) && ids.has(edge.target));
    }
    assert.deepEqual(v.edges.map((e) => e.id).sort(), ["r2", "r3", "r6", "r7"]);
  });

  it("neighbourhood respects relationship filters", () => {
    const v = filterGraph(graph, { kinds: ALL_KINDS, types: new Set(["EXTENDS"]), fileId: null, focusId: "s-svc" });
    assert.deepEqual(v.nodes.map((n) => n.id).sort(), ["s-base", "s-svc"]);
  });
});

describe("searchNodes and neighbourhood", () => {
  const graph = build();

  it("matches name and qualified name case-insensitively, exact matches first", () => {
    assert.deepEqual(searchNodes(graph, "service.RUN").map((n) => n.id), ["s-run"]);
    const results = searchNodes(graph, "service").map((n) => n.id);
    assert.ok(results.includes("s-mod") && results.includes("s-svc") && results.includes("s-run"));
    assert.equal(results.length, 3);
  });

  it("treats the query as plain text, never as a pattern", () => {
    assert.deepEqual(searchNodes(graph, ".*"), []);
    assert.deepEqual(searchNodes(graph, "   "), []);
  });

  it("lists direct incoming and outgoing relationships", () => {
    const { incoming, outgoing } = neighbourhood(graph, "s-base");
    assert.deepEqual(incoming.map((e) => e.id).sort(), ["r1", "r6"]);
    assert.deepEqual(outgoing, []);
  });
});

describe("layoutGraph", () => {
  const graph = build();
  const visible = filterGraph(graph, { kinds: ALL_KINDS, types: ALL_TYPES, fileId: null, focusId: null });

  it("places every visible node once, deterministically", () => {
    const a = layoutGraph(visible);
    const b = layoutGraph(visible);
    assert.deepEqual(a, b);
    assert.equal(a.nodes.length, visible.nodes.length);
    assert.equal(new Set(a.nodes.map((n) => n.id)).size, visible.nodes.length);
    assert.equal(a.files.length, 2);
  });

  it("puts contained symbols below their container and keeps files apart", () => {
    const { nodes, files } = layoutGraph(visible);
    const at = (id: string) => nodes.find((n) => n.id === id)!;
    assert.ok(at("s-run").y > at("s-svc").y && at("s-svc").y > at("s-mod").y);
    assert.equal(at("s-run").y - at("s-svc").y, at("s-svc").y - at("s-mod").y);
    assert.ok(at("s-run").y - at("s-svc").y >= NODE_HEIGHT);
    const [first, second] = files;
    const apart = first.x + first.width < second.x || second.x + second.width < first.x || first.y + first.height < second.y || second.y + second.height < first.y;
    assert.ok(apart, "file groups must not overlap");
    for (const node of nodes) {
      const group = files.find((f) => f.fileId === node.fileId)!;
      assert.ok(node.x >= group.x && node.x + 1 <= group.x + group.width && node.y >= group.y && node.y <= group.y + group.height);
    }
    const xy = new Set(nodes.map((n) => `${n.x},${n.y}`));
    assert.equal(xy.size, nodes.length, "no two symbols share a position");
  });

  it("handles an empty visible graph", () => {
    assert.deepEqual(layoutGraph({ nodes: [], edges: [] }), { nodes: [], files: [], width: 0, height: 0 });
  });
});
