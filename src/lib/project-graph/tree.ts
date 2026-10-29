// Directory tree, visibility and layout of the project graph. Pure: the viewer collapses directories to stay readable
// on large repositories, and file-to-file edges are rolled up to whatever is currently visible, so nothing is dropped
// from the underlying graph, only from the picture.

export type TreeNode = {
  id: string; // repository-relative path; "" for the repository root
  kind: "repository" | "directory" | "file";
  name: string;
  depth: number;
  parent: string | null;
  children: TreeNode[];
  fileCount: number; // files below (1 for a file)
};

export type Tree = { root: TreeNode; byPath: Map<string, TreeNode> };

export function buildTree(paths: readonly string[], rootName = "repository"): Tree {
  const root: TreeNode = { id: "", kind: "repository", name: rootName, depth: 0, parent: null, children: [], fileCount: 0 };
  const byPath = new Map<string, TreeNode>([["", root]]);
  for (const path of paths) {
    const parts = path.split("/");
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const id = parts.slice(0, i + 1).join("/");
      let node = byPath.get(id);
      if (!node) {
        node = { id, kind: i === parts.length - 1 ? "file" : "directory", name: parts[i], depth: i + 1, parent: parent.id, children: [], fileCount: 0 };
        byPath.set(id, node);
        parent.children.push(node);
      }
      node.fileCount += i === parts.length - 1 ? 1 : 0;
      parent = node;
    }
  }
  const count = (node: TreeNode): number => {
    if (node.kind === "file") return 1;
    node.fileCount = node.children.reduce((sum, child) => sum + count(child), 0);
    node.children.sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind === "directory" ? -1 : 1));
    return node.fileCount;
  };
  count(root);
  return { root, byPath };
}

// The repository root is always visible with its children; a directory shows its children only when expanded.
export function visibleNodeIds(tree: Tree, expanded: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>([""]);
  const walk = (node: TreeNode) => {
    for (const child of node.children) {
      ids.add(child.id);
      if (child.kind === "directory" && expanded.has(child.id)) walk(child);
    }
  };
  walk(tree.root);
  return ids;
}

// The node currently standing for `id`: itself when visible, else its nearest visible ancestor.
export function representative(tree: Tree, id: string, visible: ReadonlySet<string>): string | null {
  let current: string | null = id;
  while (current !== null) {
    if (visible.has(current)) return current;
    current = tree.byPath.get(current)?.parent ?? null;
  }
  return null;
}

export type AggregatedEdge = { from: string; to: string; count: number };

export function aggregateEdges(tree: Tree, edges: readonly (readonly [string, string])[], visible: ReadonlySet<string>): AggregatedEdge[] {
  const map = new Map<string, AggregatedEdge>();
  for (const [source, target] of edges) {
    const from = representative(tree, source, visible);
    const to = representative(tree, target, visible);
    if (from === null || to === null || from === to) continue;
    const key = `${from}\u0000${to}`;
    const existing = map.get(key);
    if (existing) existing.count++;
    else map.set(key, { from, to, count: 1 });
  }
  return [...map.values()];
}

// One row per visible node in tree order (depth-first), one column per depth.
export function layout(tree: Tree, visible: ReadonlySet<string>): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  let row = 0;
  const walk = (node: TreeNode) => {
    if (!visible.has(node.id)) return;
    positions.set(node.id, { x: node.depth, y: row++ });
    for (const child of node.children) walk(child);
  };
  walk(tree.root);
  return positions;
}
