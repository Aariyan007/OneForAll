import { summarize } from "./transform";
import type { GraphEdge, GraphNode, GraphOverviewFile, GraphPiece, RepositoryGraph } from "./types";

// Explored views of large analyses: pure functions (no I/O). The browser holds only what bounded requests returned
// (one file, the neighbours of a symbol). Nothing here invents nodes or edges, and every function reports what it has
// NOT loaded, so a partial view is never presented as complete. All loops are iterative: no recursion over data.

// ---------------------------------------------------------------------------------------------------------------
// Limits (shared by the server queries and the UI, so both state the same numbers)

// An analysis up to these sizes is sent whole and shown as the complete graph (unchanged behaviour). Larger analyses
// are explored: overview + bounded pieces.
export const COMPLETE_GRAPH_MAX_SYMBOLS = 5000;
export const COMPLETE_GRAPH_MAX_RELATIONSHIPS = 15000;
// One file view returns at most this many of the file's symbols (the largest file in practice has a few dozen).
export const FILE_SYMBOL_LIMIT = 999;
// Relationships returned for one file view / one neighbourhood.
export const FILE_EDGE_LIMIT = 1999;
export const NEIGHBOUR_EDGE_LIMIT = 200;
// An explored view never holds more symbols than the canvas can draw; expansion stops here and says so.
export const EXPLORE_NODE_CAP = 400;
export const SEARCH_LIMIT = 20;
export const SEARCH_MAX_QUERY = 200;

export type GraphMode = "complete" | "explore";

export function decideGraphMode(symbolsCount: number, relationshipsCount: number): GraphMode {
  return symbolsCount <= COMPLETE_GRAPH_MAX_SYMBOLS && relationshipsCount <= COMPLETE_GRAPH_MAX_RELATIONSHIPS ? "complete" : "explore";
}

// ---------------------------------------------------------------------------------------------------------------
// Subgraph: the union of loaded pieces

export type Subgraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  // Symbols whose relationships were requested (a file view's symbols, or an expanded symbol).
  expanded: string[];
  // True when some request of this view returned fewer rows than stored (limits hit). Never silently dropped.
  truncated: boolean;
};

export const EMPTY_SUBGRAPH: Subgraph = { nodes: [], edges: [], expanded: [], truncated: false };

function scopeExpandedIds(piece: GraphPiece): string[] {
  if (piece.scope.type === "neighbours") return [piece.scope.symbolId];
  const fileId = piece.scope.fileId;
  return piece.nodes.filter((node) => node.fileId === fileId).map((node) => node.id);
}

function pieceTruncated(piece: GraphPiece): boolean {
  return piece.symbolsReturned < piece.symbolsTotal || piece.edgesReturned < piece.edgesTotal;
}

export type MergeResult = { ok: true; subgraph: Subgraph } | { ok: false; reason: "cap"; wouldHave: number };

// Adds a piece to a subgraph. Nodes and edges are de-duplicated by id; an edge is kept only when both endpoints are
// present (the server always returns both). Refuses (instead of dropping) when the result would exceed `cap` symbols.
export function mergePiece(current: Subgraph, piece: GraphPiece, cap = EXPLORE_NODE_CAP): MergeResult {
  const nodes = new Map<string, GraphNode>();
  for (const node of current.nodes) nodes.set(node.id, node);
  for (const node of piece.nodes) {
    const existing = nodes.get(node.id);
    nodes.set(node.id, existing ? { ...existing, degree: node.degree ?? existing.degree } : node);
  }
  if (nodes.size > cap) return { ok: false, reason: "cap", wouldHave: nodes.size };

  const edges = new Map<string, GraphEdge>();
  for (const edge of current.edges) edges.set(edge.id, edge);
  for (const edge of piece.edges) if (nodes.has(edge.source) && nodes.has(edge.target)) edges.set(edge.id, edge);

  const expanded = new Set(current.expanded);
  for (const id of scopeExpandedIds(piece)) expanded.add(id);

  return {
    ok: true,
    subgraph: {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      expanded: [...expanded],
      truncated: current.truncated || pieceTruncated(piece),
    },
  };
}

// Loaded vs stored relationships per symbol. `missing` > 0 means the symbol has stored relationships that this view
// does not contain (it was never expanded, or a limit was hit).
export function loadedDegrees(subgraph: Subgraph): Map<string, { loaded: number; stored: number | null; missing: number }> {
  const loaded = new Map<string, number>();
  for (const edge of subgraph.edges) {
    loaded.set(edge.source, (loaded.get(edge.source) ?? 0) + 1);
    loaded.set(edge.target, (loaded.get(edge.target) ?? 0) + 1);
  }
  const out = new Map<string, { loaded: number; stored: number | null; missing: number }>();
  for (const node of subgraph.nodes) {
    const l = loaded.get(node.id) ?? 0;
    const stored = typeof node.degree === "number" ? node.degree : null;
    out.set(node.id, { loaded: l, stored, missing: stored === null ? 0 : Math.max(0, stored - l) });
  }
  return out;
}

export type SubgraphStatus = {
  symbols: number;
  relationships: number;
  expanded: number;
  // Symbols with stored relationships that are not in the view, and how many relationships that is in total.
  incompleteSymbols: number;
  missingRelationships: number;
  truncated: boolean;
};

export function subgraphStatus(subgraph: Subgraph): SubgraphStatus {
  let incompleteSymbols = 0;
  let missingRelationships = 0;
  for (const { missing } of loadedDegrees(subgraph).values()) {
    if (missing > 0) {
      incompleteSymbols++;
      missingRelationships += missing;
    }
  }
  return {
    symbols: subgraph.nodes.length,
    relationships: subgraph.edges.length,
    expanded: subgraph.expanded.length,
    incompleteSymbols,
    missingRelationships,
    truncated: subgraph.truncated,
  };
}

// The loaded subgraph in the shape the explorer renders (nodes sorted like the complete graph).
export function subgraphAsGraph(subgraph: Subgraph, meta: Pick<RepositoryGraph, "analysisId" | "snapshotId" | "commitSha" | "branch">): RepositoryGraph {
  const nodes = [...subgraph.nodes].sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine || a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const edges = [...subgraph.edges].sort(
    (a, b) =>
      order.get(a.source)! - order.get(b.source)! ||
      order.get(a.target)! - order.get(b.target)! ||
      a.relationshipType.localeCompare(b.relationshipType) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { ...meta, nodes, edges, summary: summarize(nodes, edges), diagnostics: { rejectedNodes: 0, rejectedEdges: 0 } };
}

// ---------------------------------------------------------------------------------------------------------------
// Overview: folders and files of the analysis, with counts. Built iteratively; rendered as a flat list (no deep
// component nesting), with folders collapsed until opened.

export type TreeRow =
  | { type: "dir"; path: string; name: string; depth: number; files: number; symbols: number; relationships: number; externalRelationships: number }
  | { type: "file"; path: string; name: string; depth: number; file: GraphOverviewFile };

type DirNode = {
  path: string;
  name: string;
  dirs: Map<string, DirNode>;
  files: GraphOverviewFile[];
  totals: { files: number; symbols: number; relationships: number; externalRelationships: number };
};

function newDir(path: string, name: string): DirNode {
  return { path, name, dirs: new Map(), files: [], totals: { files: 0, symbols: 0, relationships: 0, externalRelationships: 0 } };
}

export type OverviewTree = { root: DirNode; totals: DirNode["totals"] };

export function buildOverviewTree(files: readonly GraphOverviewFile[]): OverviewTree {
  const root = newDir("", "");
  for (const file of files) {
    const parts = file.path.split("/");
    const chain: DirNode[] = [root];
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = dir.dirs.get(parts[i]);
      if (!next) {
        next = newDir(path, parts[i]);
        dir.dirs.set(parts[i], next);
      }
      dir = next;
      chain.push(dir);
    }
    dir.files.push(file);
    for (const d of chain) {
      d.totals.files++;
      d.totals.symbols += file.symbols;
      d.totals.relationships += file.relationships;
      d.totals.externalRelationships += file.externalRelationships;
    }
  }
  return { root, totals: root.totals };
}

// Rows to show: the children of every expanded folder, folders first, by name. Iterative depth-first walk.
export function visibleTreeRows(tree: OverviewTree, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  // Children are pushed in reverse so they pop in order; a folder's own row is emitted when it is popped.
  const pending: ({ kind: "dir"; dir: DirNode; depth: number } | { kind: "file"; file: GraphOverviewFile; depth: number })[] = [];
  const pushChildren = (dir: DirNode, depth: number) => {
    const dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...dir.files].sort((a, b) => a.path.localeCompare(b.path));
    const children: typeof pending = [
      ...dirs.map((d) => ({ kind: "dir" as const, dir: d, depth })),
      ...files.map((f) => ({ kind: "file" as const, file: f, depth })),
    ];
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  };
  pushChildren(tree.root, 0);
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (item.kind === "file") {
      rows.push({ type: "file", path: item.file.path, name: item.file.path.split("/").pop() ?? item.file.path, depth: item.depth, file: item.file });
      continue;
    }
    const d = item.dir;
    rows.push({ type: "dir", path: d.path, name: d.name, depth: item.depth, ...d.totals });
    if (expanded.has(d.path)) pushChildren(d, item.depth + 1);
  }
  return rows;
}

// Folders to open so that a file's row becomes visible.
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}
