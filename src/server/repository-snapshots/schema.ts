import { z } from "zod";
import { branchSchema } from "@/server/repositories/schema";

export const SNAPSHOT_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "FAILED"] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export const STATUS_LABELS: Record<SnapshotStatus, string> = {
  PENDING: "Pending",
  PROCESSING: "Processing",
  COMPLETED: "Completed",
  FAILED: "Failed",
};

export const snapshotStatusSchema = z.enum(SNAPSHOT_STATUSES, { error: "Invalid status." });

// Mirrors the database CHECKs (the database is the authority; this gives clean errors early).
// A full Git object id in hex (SHA-1: 40, SHA-256: 64). Abbreviated ids and ref names are not commits.
export const commitShaSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/, "Enter the full 40- or 64-character commit SHA.");

// Same rules as a repository's default branch, plus no control characters. Never assumes "main".
export const snapshotBranchSchema = branchSchema.refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
  message: "That is not a valid branch name.",
});

export const createSnapshotSchema = z.object({ commitSha: commitShaSchema, branch: snapshotBranchSchema });

export type SnapshotFormState = {
  error?: string;
  // Page to open after success (server-built from verified ids); see src/components/ui/reload.ts.
  redirectTo?: string;
  fieldErrors?: { commitSha?: string[]; branch?: string[] };
};

export type SnapshotActionResult = { error?: string };
