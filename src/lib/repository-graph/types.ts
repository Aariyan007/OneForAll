// Client-facing repository graph contract. Deliberately separate from the database row types: the browser receives
// only these fields, never run tokens, signatures or other internal columns. Pure module (no I/O).

export type GraphNode = {
  id: string; // repository_symbols.id: stable within an analysis
  label: string; // symbol name
  qualifiedName: string | null;
  kind: string; // a SymbolKind stored by Phase 2H
  fileId: string;
  filePath: string;
  // 1-based for display (the database stores 0-based rows).
  startLine: number;
  endLine: number;
  visibility: string | null;
  signature: string | null;
};

export type GraphEdge = {
  id: string; // repository_symbol_relationships.id: stable within an analysis
  source: string; // node id
  target: string; // node id
  relationshipType: string; // a RelationshipType stored by Phase 2H
};

export type GraphSummary = {
  totalNodes: number;
  totalEdges: number;
  nodesByKind: Record<string, number>;
  edgesByType: Record<string, number>;
  filesRepresented: number;
};

// Rows that could not become graph elements. Counts only: the reasons are deterministic and safe to show.
export type GraphDiagnostics = {
  rejectedNodes: number;
  rejectedEdges: number;
};

export type RepositoryGraph = {
  analysisId: string;
  snapshotId: string;
  commitSha: string;
  branch: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: GraphSummary;
  diagnostics: GraphDiagnostics;
};
