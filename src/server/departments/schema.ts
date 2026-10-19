import { z } from "zod";

export const idSchema = z.uuid("Invalid id.");

export const departmentFieldsSchema = z.object({
  name: z.string().trim().min(1, "Enter a department name.").max(100, "Use at most 100 characters."),
  description: z
    .string()
    .trim()
    .max(500, "Use at most 500 characters.")
    .transform((value) => (value === "" ? null : value)),
});

export type DepartmentFormState = {
  error?: string;
  // Page to open after success (server-built from verified ids); see src/components/ui/reload.ts.
  redirectTo?: string;
  fieldErrors?: { name?: string[]; description?: string[] };
};

export type DepartmentActionResult = { error?: string };
