import { z } from "zod";

export const ANALYSIS_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "FAILED"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const ANALYSIS_STATUS_LABELS: Record<AnalysisStatus, string> = {
  PENDING: "Pending",
  PROCESSING: "Processing",
  COMPLETED: "Completed",
  FAILED: "Failed",
};

export const analysisStatusSchema = z.enum(ANALYSIS_STATUSES, { error: "Invalid status." });

// Mirrors the database trigger (the database is the authority; this gives clean errors early):
// PENDING -> PROCESSING | FAILED, PROCESSING -> COMPLETED | FAILED, FAILED -> PENDING (retry).
// COMPLETED is terminal: an analysis of a snapshot is rerun by deleting it and analysing again.
const ALLOWED_TRANSITIONS: Record<AnalysisStatus, readonly AnalysisStatus[]> = {
  PENDING: ["PROCESSING", "FAILED"],
  PROCESSING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: ["PENDING"],
};

export function isAllowedAnalysisTransition(from: AnalysisStatus, to: AnalysisStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// The payload sent to persist_structure_analysis(). Shape-checked before it leaves the server; the database
// then re-checks every value (CHECK constraints, snapshot isolation, relationship isolation).
export const persistedSymbolSchema = z.object({
  file_id: z.uuid(),
  name: z.string().min(1).max(500),
  kind: z.enum(["CLASS", "INTERFACE", "FUNCTION", "METHOD", "CONSTRUCTOR", "VARIABLE", "CONSTANT", "ENUM", "TYPE", "MODULE"]),
  qualified_name: z.string().min(1).max(1000).nullable(),
  signature: z.string().min(1).max(2000).nullable(),
  start_line: z.number().int().min(0),
  start_column: z.number().int().min(0),
  end_line: z.number().int().min(0),
  end_column: z.number().int().min(0),
  visibility: z.enum(["PUBLIC", "PRIVATE", "PROTECTED", "INTERNAL", "PACKAGE", "UNKNOWN"]),
});

export const persistedRelationshipSchema = z.object({
  source_index: z.number().int().min(0),
  target_index: z.number().int().min(0),
  relationship_type: z.enum(["CONTAINS", "IMPORTS", "CALLS", "EXTENDS", "IMPLEMENTS", "REFERENCES"]),
});

export type PersistedSymbol = z.infer<typeof persistedSymbolSchema>;
export type PersistedRelationship = z.infer<typeof persistedRelationshipSchema>;

export type AnalysisActionState = { error?: string; success?: string };
export type AnalysisActionResult = { error?: string };
