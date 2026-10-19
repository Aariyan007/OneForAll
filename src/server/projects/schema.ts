import { z } from "zod";

export const PROJECT_TYPES = ["GREENFIELD", "BROWNFIELD"] as const;
export const PROJECT_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;

export type ProjectType = (typeof PROJECT_TYPES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const projectTypeSchema = z.enum(PROJECT_TYPES, { error: "Choose Greenfield or Brownfield." });
export const projectStatusSchema = z.enum(PROJECT_STATUSES, { error: "Invalid status." });

const projectFields = {
  name: z.string().trim().min(1, "Enter a project name.").max(150, "Use at most 150 characters."),
  description: z
    .string()
    .trim()
    .max(1000, "Use at most 1000 characters.")
    .transform((value) => (value === "" ? null : value)),
};

export const createProjectSchema = z.object({ ...projectFields, projectType: projectTypeSchema });
// project_type is immutable after creation, so it is deliberately not editable here.
export const updateProjectSchema = z.object(projectFields);

// Mirrors the database trigger (the database is the authority; this gives clean errors early):
// DRAFT -> ACTIVE, DRAFT -> ARCHIVED, ACTIVE -> ARCHIVED, ARCHIVED -> ACTIVE.
const ALLOWED_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["ARCHIVED"],
  ARCHIVED: ["ACTIVE"],
};

export function isAllowedTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export type ProjectFormState = {
  error?: string;
  // Page to open after success (server-built from verified ids); see src/components/ui/reload.ts.
  redirectTo?: string;
  fieldErrors?: { name?: string[]; description?: string[]; projectType?: string[] };
};

export type ProjectActionResult = { error?: string };
