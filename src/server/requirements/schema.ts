import { z } from "zod";

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const REQUIREMENT_STATUSES = ["DRAFT", "READY", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;

export type Priority = (typeof PRIORITIES)[number];
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const prioritySchema = z.enum(PRIORITIES, { error: "Choose a priority." });
export const requirementStatusSchema = z.enum(REQUIREMENT_STATUSES, { error: "Invalid status." });

// Requirements and tasks share the same editable fields (title, description, priority).
export const workItemFieldsSchema = z.object({
  title: z.string().trim().min(1, "Enter a title.").max(200, "Use at most 200 characters."),
  description: z
    .string()
    .trim()
    .max(2000, "Use at most 2000 characters.")
    .transform((value) => (value === "" ? null : value)),
  priority: prioritySchema,
});

// Mirrors the database trigger (the database is the authority; this gives clean errors early):
// DRAFT -> READY | CANCELLED, READY -> IN_PROGRESS | CANCELLED, IN_PROGRESS -> COMPLETED | CANCELLED,
// COMPLETED -> IN_PROGRESS, CANCELLED -> DRAFT.
const ALLOWED_TRANSITIONS: Record<RequirementStatus, readonly RequirementStatus[]> = {
  DRAFT: ["READY", "CANCELLED"],
  READY: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: ["IN_PROGRESS"],
  CANCELLED: ["DRAFT"],
};

export function isAllowedRequirementTransition(from: RequirementStatus, to: RequirementStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export type WorkItemFormState = {
  error?: string;
  // Page to open after success (server-built from verified ids); see src/components/ui/reload.ts.
  redirectTo?: string;
  fieldErrors?: { title?: string[]; description?: string[]; priority?: string[] };
};

export type WorkItemActionResult = { error?: string };
