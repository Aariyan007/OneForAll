import { resolveImports } from "./imports";

// All import edges of a snapshot. `files` are the stored text files; an edge is only reported between two of them.
export type FileEdge = { source: string; target: string; specifier: string };

export function buildFileEdges(files: readonly { path: string; content: string }[]): {
  edges: FileEdge[];
  unresolvedLocal: number;
  filesScanned: number;
} {
  const all = new Set(files.map((f) => f.path));
  const edges: FileEdge[] = [];
  let unresolvedLocal = 0;
  let filesScanned = 0;
  for (const file of files) {
    if (!/\.(?:[cm]?[jt]sx?|py|java)$/.test(file.path)) continue;
    filesScanned++;
    const resolution = resolveImports(file.path, file.content, all);
    unresolvedLocal += resolution.unresolvedLocal;
    for (const edge of resolution.edges) edges.push({ source: file.path, target: edge.target, specifier: edge.specifier });
  }
  return { edges, unresolvedLocal, filesScanned };
}
