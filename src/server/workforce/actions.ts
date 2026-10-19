"use server";

import { createHash } from "node:crypto";
import { z } from "zod";
import { parseDirectoryCsv } from "@/lib/workforce/csv";
import { type StructureKind, isStructureKind, parseStructureCsv } from "@/lib/workforce/structure-csv";
import { createClient } from "@/lib/supabase/server";
import { getOrgAccess } from "@/server/authz/access";
import { idSchema } from "@/server/departments/schema";
import { rpcErrorMessage } from "@/server/errors";

// Workforce Server Actions. Each re-verifies the caller's membership (getOrgAccess) and calls a SECURITY DEFINER
// function that checks the caller's role again (import and edits: OWNER/ADMIN; availability/skills: the person
// themselves or OWNER/ADMIN). Nothing here trusts a role, user id or organization from the browser.
// No revalidatePath here: on this Next.js version (16.2.9) applying the re-rendered page that a revalidating Server
// Action returns was observed to leave the client transition pending on complex pages (the action ran, the UI stayed
// "pending"). Client components reload the page after a successful change instead (see docs/rbac-workforce.md).

export type ActionResult = { error?: string; success?: string };


export type ImportRowResult = { row: number | null; email: string | null; outcome: "CREATE" | "UPDATE" | "UNCHANGED" | "ERROR"; message: string };
export type ImportState = {
  error?: string;
  // Present after a preview: the exact text that was previewed and its hash, re-sent on confirmation.
  csv?: string;
  hash?: string;
  fileName?: string;
  results?: ImportRowResult[];
  applied?: boolean;
  kind?: StructureKind; // structure imports only
};

const MAX_UPLOAD_BYTES = 512 * 1024;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
// Browsers normalize line breaks to CRLF when a form is submitted, so the text is compared with LF line ends.
const normalize = (text: string) => text.replace(/\r\n?/g, "\n");

async function runImport(organizationId: string, csv: string, apply: boolean): Promise<{ error: string } | { results: ImportRowResult[] }> {
  const parsed = parseDirectoryCsv(csv);
  if (!parsed.ok) return { error: parsed.error };
  const supabase = await createClient();
  const rows = parsed.rows;
  let dbResults: ImportRowResult[] = [];
  if (rows.length > 0) {
    const { data, error } = await supabase.rpc("import_workforce_directory", {
      p_organization_id: organizationId,
      p_rows: rows,
      p_apply: apply,
    });
    if (error || !data) return { error: rpcErrorMessage(error, "The import could not be checked.") };
    dbResults = data.map((r) => ({ row: r.row_number, email: r.email, outcome: r.outcome as ImportRowResult["outcome"], message: r.message }));
  }
  const fileIssues: ImportRowResult[] = parsed.issues.map((i) => ({ row: i.row, email: i.email, outcome: "ERROR", message: i.message }));
  return { results: [...fileIssues, ...dbResults].sort((a, b) => (a.row ?? 0) - (b.row ?? 0)) };
}

// Step 1: parse and dry-run (nothing is written).
export async function previewImport(organizationId: string, _prev: ImportState, formData: FormData): Promise<ImportState> {
  const access = await getOrgAccess(organizationId);
  if (!access) return { error: "Organization not found." };
  if (!access.can("workforce.import")) return { error: "Only owners and admins can import the directory." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "The file is larger than 512 KiB." };
  if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") return { error: "Upload a .csv file." };
  let csv: string;
  try {
    csv = normalize(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()));
  } catch {
    return { error: "The file is not valid UTF-8 text. Save it as CSV UTF-8." };
  }
  const outcome = await runImport(access.organization.id, csv, false);
  if ("error" in outcome) return { error: outcome.error };
  return { csv, hash: sha256(csv), fileName: file.name.slice(0, 200), results: outcome.results };
}

// Step 2: apply exactly the previewed text. Valid rows are written in one transaction; invalid rows are skipped and
// reported again.
export async function applyImport(organizationId: string, _prev: ImportState, formData: FormData): Promise<ImportState> {
  const access = await getOrgAccess(organizationId);
  if (!access) return { error: "Organization not found." };
  if (!access.can("workforce.import")) return { error: "Only owners and admins can import the directory." };
  const raw = formData.get("csv");
  const hash = formData.get("hash");
  if (typeof raw !== "string" || typeof hash !== "string" || raw.length === 0) return { error: "Preview the file first." };
  const csv = normalize(raw);
  if (new TextEncoder().encode(csv).length > MAX_UPLOAD_BYTES) return { error: "The file is larger than 512 KiB." };
  if (sha256(csv) !== hash) return { error: "The data changed after the preview. Preview the file again." };
  const outcome = await runImport(access.organization.id, csv, true);
  if ("error" in outcome) return { error: outcome.error };
  return { results: outcome.results, applied: true, hash };
}

// Departments and teams from CSV: the same preview -> confirm (exact text, hash) flow as the directory import.
const structureHash = (kind: StructureKind, csv: string) => sha256(`${kind}\n${csv}`);
async function runStructureImport(organizationId: string, kind: StructureKind, csv: string, apply: boolean): Promise<{ error: string } | { results: ImportRowResult[] }> {
  const parsed = parseStructureCsv(kind, csv);
  if (!parsed.ok) return { error: parsed.error };
  let dbResults: ImportRowResult[] = [];
  if (parsed.rows.length > 0) {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("import_organization_structure", {
      p_organization_id: organizationId,
      p_kind: kind,
      p_rows: parsed.rows,
      p_apply: apply,
    });
    if (error || !data) return { error: rpcErrorMessage(error, "The import could not be checked.") };
    dbResults = data.map((r) => ({ row: r.row_number, email: r.name, outcome: r.outcome as ImportRowResult["outcome"], message: r.message }));
  }
  const fileIssues: ImportRowResult[] = parsed.issues.map((i) => ({ row: i.row, email: i.name, outcome: "ERROR", message: i.message }));
  return { results: [...fileIssues, ...dbResults].sort((a, b) => (a.row ?? 0) - (b.row ?? 0)) };
}

export async function previewStructureImport(organizationId: string, _prev: ImportState, formData: FormData): Promise<ImportState> {
  const access = await getOrgAccess(organizationId);
  if (!access) return { error: "Organization not found." };
  if (!access.can("structure.import")) return { error: "Only owners and admins can import departments and teams." };
  const kind = formData.get("kind");
  if (!isStructureKind(kind)) return { error: "Choose departments or teams." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "The file is larger than 512 KiB." };
  if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") return { error: "Upload a .csv file." };
  let csv: string;
  try {
    csv = normalize(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()));
  } catch {
    return { error: "The file is not valid UTF-8 text. Save it as CSV UTF-8." };
  }
  const outcome = await runStructureImport(access.organization.id, kind, csv, false);
  if ("error" in outcome) return { error: outcome.error };
  return { csv, hash: structureHash(kind, csv), fileName: file.name.slice(0, 200), results: outcome.results, kind };
}

export async function applyStructureImport(organizationId: string, _prev: ImportState, formData: FormData): Promise<ImportState> {
  const access = await getOrgAccess(organizationId);
  if (!access) return { error: "Organization not found." };
  if (!access.can("structure.import")) return { error: "Only owners and admins can import departments and teams." };
  const kind = formData.get("kind");
  const raw = formData.get("csv");
  const hash = formData.get("hash");
  if (!isStructureKind(kind) || typeof raw !== "string" || typeof hash !== "string" || raw.length === 0) return { error: "Preview the file first." };
  const csv = normalize(raw);
  if (new TextEncoder().encode(csv).length > MAX_UPLOAD_BYTES) return { error: "The file is larger than 512 KiB." };
  // The kind is part of the hash: a previewed departments file cannot be applied as teams.
  if (structureHash(kind, csv) !== hash) return { error: "The data changed after the preview. Preview the file again." };
  const outcome = await runStructureImport(access.organization.id, kind, csv, true);
  if ("error" in outcome) return { error: outcome.error };
  return { results: outcome.results, applied: true, hash, kind };
}

const profileSchema = z.object({
  fullName: z.string().trim().max(100),
  employeeCode: z.string().trim().max(40),
  jobTitle: z.string().trim().max(100),
  team: z.string(),
});

export async function updateDirectoryEntry(organizationId: string, profileId: string, _prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const access = await getOrgAccess(organizationId);
  if (!access || !idSchema.safeParse(profileId).success) return { error: "Entry not found." };
  const parsed = profileSchema.safeParse({
    fullName: formData.get("fullName") ?? "",
    employeeCode: formData.get("employeeCode") ?? "",
    jobTitle: formData.get("jobTitle") ?? "",
    team: formData.get("team") ?? "",
  });
  if (!parsed.success) return { error: "Some values are too long." };
  // team field: "" = keep, "none" = clear, "dept:<id>" = department only, "<teamId>" = team (its department follows).
  const team = parsed.data.team;
  const deptOnly = team.startsWith("dept:") ? team.slice(5) : null;
  const teamId = !deptOnly && team !== "" && team !== "none" ? team : null;
  if ((deptOnly && !idSchema.safeParse(deptOnly).success) || (teamId && !idSchema.safeParse(teamId).success)) return { error: "Invalid team." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_workforce_profile", {
    p_profile_id: profileId,
    p_full_name: parsed.data.fullName,
    p_employee_code: parsed.data.employeeCode,
    p_job_title: parsed.data.jobTitle,
    // SQL NULL = keep the current value; the generated type does not express SQL NULL for these parameters.
    p_department_id: deptOnly as string,
    p_team_id: teamId as string,
    p_clear_team: team === "none",
  });
  if (error) return { error: rpcErrorMessage(error, "The entry could not be saved.") };
  return { success: "Saved." };
}

export async function setAvailability(organizationId: string, profileId: string, availability: string): Promise<ActionResult> {
  const access = await getOrgAccess(organizationId);
  const value = z.enum(["AVAILABLE", "BUSY", "UNAVAILABLE"]).safeParse(availability);
  if (!access || !idSchema.safeParse(profileId).success || !value.success) return { error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_workforce_availability", { p_profile_id: profileId, p_availability: value.data });
  if (error) return { error: rpcErrorMessage(error, "Availability could not be saved.") };
  return { success: "Availability saved." };
}

export async function setSkills(organizationId: string, profileId: string, skillIds: string[]): Promise<ActionResult> {
  const access = await getOrgAccess(organizationId);
  const ids = z.array(idSchema).max(50).safeParse(skillIds);
  if (!access || !idSchema.safeParse(profileId).success || !ids.success) return { error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_workforce_skills", { p_profile_id: profileId, p_skill_ids: ids.data });
  if (error) return { error: rpcErrorMessage(error, "Skills could not be saved.") };
  return { success: "Skills saved." };
}

export async function createSkill(organizationId: string, _prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const access = await getOrgAccess(organizationId);
  if (!access) return { error: "Organization not found." };
  const name = z
    .string()
    .trim()
    .min(1, "Enter a skill name.")
    .max(60, "Use at most 60 characters.")
    .regex(/^[\p{L}\p{N}][\p{L}\p{N} +#./&()_-]*$/u, "Use letters, digits, spaces and + # . / & ( ) _ - only.")
    .safeParse(formData.get("name"));
  if (!name.success) return { error: name.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_skill", { p_organization_id: access.organization.id, p_name: name.data });
  if (error) return { error: rpcErrorMessage(error, "The skill could not be added.") };
  return { success: `Added ${name.data}.` };
}

export async function setAssignmentMode(organizationId: string, mode: string): Promise<ActionResult> {
  const access = await getOrgAccess(organizationId);
  const value = z.enum(["MANUAL", "RECOMMEND", "AUTO"]).safeParse(mode);
  if (!access || !value.success) return { error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_assignment_mode", { p_organization_id: access.organization.id, p_mode: value.data });
  if (error) return { error: rpcErrorMessage(error, "The policy could not be saved.") };
  return { success: "Assignment policy saved." };
}
