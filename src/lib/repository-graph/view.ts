import type { GraphEdge, GraphNode, RepositoryGraph } from "./types";

// What the browser shows of a graph: filtering, search, direct neighbourhood and a deterministic layout. Pure functions
// over the already-authorized graph; nothing here can add nodes or edges that the server did not return.

// Above this many visible nodes the canvas asks the user to narrow the view (file, kinds, neighbourhood) instead of
// drawing everything. Summaries and search always cover the whole graph.
export const RENDER_LIMIT = 400;

export type GraphFilters = {
  kinds: ReadonlySet<string>; // symbol kinds to show
  types: ReadonlySet<string>; // relationship types to show
  fileId: string | null; // one file, or null for all files
  focusId: string | null; // when set: only this node and its direct neighbours (through visible relationship types)
};

export type VisibleGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

export function filterGraph(graph: RepositoryGraph, filters: GraphFilters): VisibleGraph {
  let nodes = graph.nodes.filter((node) => filters.kinds.has(node.kind) && (filters.fileId === null || node.fileId === filters.fileId));
  let ids = new Set(nodes.map((node) => node.id));
  let edges = graph.edges.filter((edge) => filters.types.has(edge.relationshipType) && ids.has(edge.source) && ids.has(edge.target));

  if (filters.focusId !== null && ids.has(filters.focusId)) {
    const focus = filters.focusId;
    edges = edges.filter((edge) => edge.source === focus || edge.target === focus);
    const keep = new Set<string>([focus]);
    for (const edge of edges) {
      keep.add(edge.source);
      keep.add(edge.target);
    }
    nodes = nodes.filter((node) => keep.has(node.id));
    ids = keep;
  }
  return { nodes, edges };
}

// Case-insensitive substring match on the symbol name and qualified name. Plain string comparison: the query is never
// interpreted as a pattern.
export function searchNodes(graph: RepositoryGraph, query: string, limit = 20): GraphNode[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const exact: GraphNode[] = [];
  const partial: GraphNode[] = [];
  for (const node of graph.nodes) {
    const name = node.label.toLowerCase();
    const qualified = node.qualifiedName?.toLowerCase() ?? "";
    if (name === q || qualified === q) exact.push(node);
    else if (name.includes(q) || qualified.includes(q)) partial.push(node);
  }
  return [...exact, ...partial].slice(0, limit);
}

export type Neighbourhood = { incoming: GraphEdge[]; outgoing: GraphEdge[] };

// Direct relationships of one node in the full graph (independent of filters, so details never hide stored facts).
export function neighbourhood(graph: RepositoryGraph, nodeId: string): Neighbourhood {
  return {
    incoming: graph.edges.filter((edge) => edge.target === nodeId),
    outgoing: graph.edges.filter((edge) => edge.source === nodeId),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Layout: one group per file, each a top-down tree. A node's tree parent is the node that CONTAINS it, else the module
// that IMPORTS it (both point from parent to child in Phase 2H). Childless children sit in a compact grid under their
// parent; children with their own children sit side by side. File groups wrap into rows so the whole graph keeps a
// screen-like shape. EXTENDS / IMPLEMENTS / CALLS / REFERENCES are drawn between tree positions.
// Deterministic: the same visible graph always gets the same coordinates.
// ---------------------------------------------------------------------------------------------------------------

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 44;
const COLUMN_GAP = 20;
const ROW_GAP = 46;
const FILE_GAP = 64;
const LEAF_COLUMNS = 3;
const TARGET_ASPECT = 1.8; // width / height the file groups are packed towards
export const FILE_HEADER = 34;

export type PositionedNode = GraphNode & { x: number; y: number };
export type FileGroup = { fileId: string; filePath: string; x: number; y: number; width: number; height: number };
export type GraphLayout = { nodes: PositionedNode[]; files: FileGroup[]; width: number; height: number };

const TREE_TYPES = ["CONTAINS", "IMPORTS"] as const;
const SLOT_X = NODE_WIDTH + COLUMN_GAP;
const SLOT_Y = NODE_HEIGHT + ROW_GAP;

type Box = { w: number; h: number }; // in slots / rows

export function layoutGraph(visible: VisibleGraph): GraphLayout {
  const index = new Map(visible.nodes.map((node, i) => [node.id, i]));
  const parent = new Map<string, string>();
  for (const type of TREE_TYPES) {
    for (const edge of visible.edges) {
      if (edge.relationshipType !== type || parent.has(edge.target)) continue;
      const a = visible.nodes[index.get(edge.source)!];
      const b = visible.nodes[index.get(edge.target)!];
      if (a.fileId !== b.fileId) continue; // trees never span files
      // Refuse an edge that would close a cycle (cannot happen with Phase 2H data; guarded anyway).
      let cursor: string | undefined = edge.source;
      let cycle = false;
      while (cursor !== undefined) {
        if (cursor === edge.target) {
          cycle = true;
          break;
        }
        cursor = parent.get(cursor);
      }
      if (!cycle) parent.set(edge.target, edge.source);
    }
  }

  const children = new Map<string, GraphNode[]>();
  const byFile = new Map<string, GraphNode[]>();
  for (const node of visible.nodes) {
    const p = parent.get(node.id);
    if (p !== undefined) {
      const list = children.get(p);
      if (list) list.push(node);
      else children.set(p, [node]);
    }
    const group = byFile.get(node.fileId);
    if (group) group.push(node);
    else byFile.set(node.fileId, [node]);
  }
  const kidsOf = (id: string) => children.get(id) ?? [];
  const isLeaf = (node: GraphNode) => kidsOf(node.id).length === 0;

  // Subtree size in slots (columns) and rows.
  const sizes = new Map<string, Box>();
  const remember = (node: GraphNode, box: Box) => {
    sizes.set(node.id, box);
    return box;
  };
  const measure = (node: GraphNode): Box => {
    const kids = kidsOf(node.id);
    if (kids.length === 0) return remember(node, { w: 1, h: 1 });
    const leaves = kids.filter(isLeaf);
    const branches = kids.filter((kid) => !isLeaf(kid));
    const cols = Math.min(LEAF_COLUMNS, leaves.length);
    let w = cols;
    let h = cols > 0 ? Math.ceil(leaves.length / cols) : 0;
    for (const branch of branches) {
      const box = measure(branch);
      w += box.w;
      h = Math.max(h, box.h);
    }
    return remember(node, { w: Math.max(1, w), h: 1 + h });
  };

  const local: PositionedNode[] = [];
  const place = (node: GraphNode, col: number, row: number) => {
    const box = sizes.get(node.id) ?? { w: 1, h: 1 }; // leaves are never measured: one slot
    local.push({ ...node, x: (col + (box.w - 1) / 2) * SLOT_X, y: row * SLOT_Y });
    const kids = kidsOf(node.id);
    const leaves = kids.filter(isLeaf);
    const cols = Math.min(LEAF_COLUMNS, leaves.length);
    leaves.forEach((leaf, i) => place(leaf, col + (i % cols), row + 1 + Math.floor(i / cols)));
    let next = col + cols;
    for (const branch of kids.filter((kid) => !isLeaf(kid))) {
      place(branch, next, row + 1);
      next += sizes.get(branch.id)!.w;
    }
  };

  // Lay out every file on its own, then pack the file groups into rows.
  const groups: { fileId: string; filePath: string; nodes: PositionedNode[]; width: number; height: number }[] = [];
  const fileIds = [...byFile.keys()].sort((a, b) => byFile.get(a)![0].filePath.localeCompare(byFile.get(b)![0].filePath) || a.localeCompare(b));
  for (const fileId of fileIds) {
    const fileNodes = byFile.get(fileId)!;
    const roots = fileNodes.filter((node) => !parent.has(node.id));
    roots.sort((a, b) => (a.kind === "MODULE" ? 0 : 1) - (b.kind === "MODULE" ? 0 : 1) || a.startLine - b.startLine);
    local.length = 0;
    let col = 0;
    let rows = 0;
    for (const root of roots) {
      const box = measure(root);
      place(root, col, 0);
      col += box.w;
      rows = Math.max(rows, box.h);
    }
    groups.push({
      fileId,
      filePath: fileNodes[0].filePath,
      nodes: [...local],
      width: Math.max(1, col) * SLOT_X - COLUMN_GAP,
      height: FILE_HEADER + rows * SLOT_Y - ROW_GAP,
    });
  }

  const area = groups.reduce((sum, g) => sum + (g.width + FILE_GAP) * (g.height + FILE_GAP), 0);
  const rowLimit = Math.max(...groups.map((g) => g.width), Math.sqrt(area * TARGET_ASPECT));
  const positioned: PositionedNode[] = [];
  const files: FileGroup[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const group of groups) {
    if (x > 0 && x + group.width > rowLimit) {
      x = 0;
      y += rowHeight + FILE_GAP;
      rowHeight = 0;
    }
    for (const node of group.nodes) positioned.push({ ...node, x: node.x + x, y: node.y + y + FILE_HEADER });
    files.push({ fileId: group.fileId, filePath: group.filePath, x, y, width: group.width, height: group.height });
    width = Math.max(width, x + group.width);
    rowHeight = Math.max(rowHeight, group.height);
    x += group.width + FILE_GAP;
  }

  return { nodes: positioned, files, width, height: groups.length > 0 ? y + rowHeight : 0 };
}
