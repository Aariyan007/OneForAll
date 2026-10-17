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
  // Total number of stored relationships that touch this symbol, when known (explored views of large analyses).
  // Lets the UI say how many of them are not loaded instead of implying a partial neighbourhood is complete.
  degree?: number;
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

// ---------------------------------------------------------------------------------------------------------------
// Explored views of large analyses. The browser never receives the whole graph of such an analysis: it receives an
// overview (files with counts) and then bounded pieces (one file, the neighbours of one symbol, search results).

export type GraphOverviewFile = {
  fileId: string;
  path: string;
  symbols: number;
  relationships: number; // stored relationships whose source symbol is in this file
  externalRelationships: number; // ...of which the target symbol is in another file
};

export type GraphOverview = {
  files: GraphOverviewFile[];
  nodesByKind: Record<string, number>;
  edgesByType: Record<string, number>;
};

export type GraphSearchResult = {
  id: string;
  label: string;
  kind: string;
  qualifiedName: string | null;
  fileId: string;
  filePath: string;
  startLine: number; // 1-based
};

// What one bounded request returned, and whether it is complete for its scope.
export type GraphPiece = {
  scope: { type: "file"; fileId: string; filePath: string } | { type: "neighbours"; symbolId: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  // For a file: symbols of that file stored vs returned. For neighbours: always 1 / 1 (the symbol itself).
  symbolsTotal: number;
  symbolsReturned: number;
  // Relationships touching the scope's symbols: stored vs returned.
  edgesTotal: number;
  edgesReturned: number;
  rejected: { nodes: number; edges: number };
};
