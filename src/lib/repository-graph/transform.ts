// Relative import (not "@/"): keeps this pure module runnable by the plain-Node graph tests.
import { RELATIONSHIP_TYPES, SYMBOL_KINDS } from "../../server/repository-structure/types";
import type { GraphEdge, GraphNode, GraphSummary, RepositoryGraph } from "./types";

// Database rows -> graph DTO. Pure and deterministic: the same rows always give the same graph, in the same order.
// Every element must belong to `analysisId`; a relationship must point at two nodes of that same graph. Rows that do
// not qualify are left out and counted in `diagnostics`, never repaired or guessed.

export type SymbolRow = {
  id: string;
  analysis_id: string;
  file_id: string;
  file_path: string | null;
  name: string;
  kind: string;
  qualified_name: string | null;
  signature: string | null;
  start_line: number;
  start_column: number;
  end_line: number;
  visibility: string | null;
  // Total stored relationships touching the symbol (explored views only).
  degree?: number | null;
};

export type RelationshipRow = {
  id: string;
  analysis_id: string;
  source_symbol_id: string;
  target_symbol_id: string;
  relationship_type: string;
};

export type GraphInput = {
  analysisId: string;
  snapshotId: string;
  commitSha: string;
  branch: string;
  symbols: SymbolRow[];
  relationships: RelationshipRow[];
};

const KINDS: ReadonlySet<string> = new Set(SYMBOL_KINDS);
const TYPES: ReadonlySet<string> = new Set(RELATIONSHIP_TYPES);

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isLine(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function compareNodes(columns: ReadonlyMap<string, number>, a: GraphNode, b: GraphNode) {
  return (
    a.filePath.localeCompare(b.filePath) ||
    a.startLine - b.startLine ||
    (columns.get(a.id) ?? 0) - (columns.get(b.id) ?? 0) ||
    a.label.localeCompare(b.label) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function summarize(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphSummary {
  const nodesByKind: Record<string, number> = {};
  const edgesByType: Record<string, number> = {};
  const files = new Set<string>();
  for (const node of nodes) {
    nodesByKind[node.kind] = (nodesByKind[node.kind] ?? 0) + 1;
    files.add(node.fileId);
  }
  for (const edge of edges) edgesByType[edge.relationshipType] = (edgesByType[edge.relationshipType] ?? 0) + 1;
  return { totalNodes: nodes.length, totalEdges: edges.length, nodesByKind, edgesByType, filesRepresented: files.size };
}

export function buildRepositoryGraph(input: GraphInput): RepositoryGraph {
  let rejectedNodes = 0;
  let rejectedEdges = 0;

  const byId = new Map<string, GraphNode>();
  const columns = new Map<string, number>();
  for (const row of input.symbols) {
    const valid =
      row.analysis_id === input.analysisId &&
      isNonEmpty(row.id) &&
      isNonEmpty(row.file_id) &&
      isNonEmpty(row.name) &&
      KINDS.has(row.kind) &&
      isLine(row.start_line) &&
      isLine(row.end_line) &&
      !byId.has(row.id);
    if (!valid) {
      rejectedNodes++;
      continue;
    }
    byId.set(row.id, {
      id: row.id,
      label: row.name,
      qualifiedName: isNonEmpty(row.qualified_name) ? row.qualified_name : null,
      kind: row.kind,
      fileId: row.file_id,
      filePath: isNonEmpty(row.file_path) ? row.file_path : "(unknown file)",
      startLine: row.start_line + 1,
      endLine: row.end_line + 1,
      visibility: isNonEmpty(row.visibility) ? row.visibility : null,
      signature: isNonEmpty(row.signature) ? row.signature : null,
      ...(typeof row.degree === "number" && Number.isInteger(row.degree) && row.degree >= 0 ? { degree: row.degree } : {}),
    });
    columns.set(row.id, isLine(row.start_column) ? row.start_column : 0);
  }

  const nodes: GraphNode[] = [...byId.values()].sort((a, b) => compareNodes(columns, a, b));
  const order = new Map(nodes.map((node, index) => [node.id, index]));

  const seenEdges = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const row of input.relationships) {
    const valid =
      row.analysis_id === input.analysisId &&
      isNonEmpty(row.id) &&
      TYPES.has(row.relationship_type) &&
      byId.has(row.source_symbol_id) &&
      byId.has(row.target_symbol_id) &&
      row.source_symbol_id !== row.target_symbol_id &&
      !seenEdges.has(row.id);
    if (!valid) {
      rejectedEdges++;
      continue;
    }
    seenEdges.add(row.id);
    edges.push({ id: row.id, source: row.source_symbol_id, target: row.target_symbol_id, relationshipType: row.relationship_type });
  }
  edges.sort(
    (a, b) =>
      order.get(a.source)! - order.get(b.source)! ||
      order.get(a.target)! - order.get(b.target)! ||
      a.relationshipType.localeCompare(b.relationshipType) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return {
    analysisId: input.analysisId,
    snapshotId: input.snapshotId,
    commitSha: input.commitSha,
    branch: input.branch,
    nodes,
    edges,
    summary: summarize(nodes, edges),
    diagnostics: { rejectedNodes, rejectedEdges },
  };
}
