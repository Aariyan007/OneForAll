// Departments and teams CSV (organization structure). Pure and unit-tested; reuses the directory CSV parser. The rows
// are validated again by import_organization_structure() in the database, which also resolves names inside the
// organization. A structure file never carries people, roles or tokens.
import { CSV_LIMITS, CsvError, type ParsedCsv, parseCsv, toCsv } from "./csv";

export const STRUCTURE_KINDS = ["DEPARTMENTS", "TEAMS"] as const;
export type StructureKind = (typeof STRUCTURE_KINDS)[number];

export const STRUCTURE_COLUMNS: Record<StructureKind, readonly string[]> = {
  DEPARTMENTS: ["name", "description"],
  TEAMS: ["department", "name", "description"],
};

export type StructureRow = { row: number; name: string; description: string; department?: string };
export type StructureIssue = { row: number; name: string | null; message: string };
export type StructureParseResult = { ok: true; rows: StructureRow[]; issues: StructureIssue[] } | { ok: false; error: string };

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const PEOPLE_COLUMNS = ["email", "role", "roles", "password", "token", "user_id", "full_name"];

export function isStructureKind(value: unknown): value is StructureKind {
  return typeof value === "string" && (STRUCTURE_KINDS as readonly string[]).includes(value);
}

export function parseStructureCsv(kind: StructureKind, text: string): StructureParseResult {
  if (new TextEncoder().encode(text).length > CSV_LIMITS.maxBytes) return { ok: false, error: "The file is larger than 512 KiB." };
  let parsed: ParsedCsv;
  try {
    parsed = parseCsv(text);
  } catch (error) {
    return { ok: false, error: error instanceof CsvError ? error.message : "The file could not be read as CSV." };
  }
  const { headers, records } = parsed;
  const allowed = STRUCTURE_COLUMNS[kind];
  const people = headers.find((h) => PEOPLE_COLUMNS.includes(h));
  if (people) return { ok: false, error: `Column "${people}": a ${kind === "TEAMS" ? "teams" : "departments"} file describes the structure only. Import people with the employee directory template.` };
  const unknown = headers.filter((h) => !allowed.includes(h));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.map((h) => `"${h || "(empty)"}"`).join(", ")}. Allowed: ${allowed.join(", ")}.` };
  }
  const duplicate = headers.find((h, i) => headers.indexOf(h) !== i);
  if (duplicate) return { ok: false, error: `Column "${duplicate}" appears twice.` };
  for (const required of kind === "TEAMS" ? ["department", "name"] : ["name"]) {
    if (!headers.includes(required)) return { ok: false, error: `The "${required}" column is required.` };
  }
  if (records.length === 0) return { ok: false, error: "The file has a header but no rows." };
  if (records.length > CSV_LIMITS.maxRows) return { ok: false, error: `The file has more than ${CSV_LIMITS.maxRows} rows.` };

  const rows: StructureRow[] = [];
  const issues: StructureIssue[] = [];
  for (const { line, cells } of records) {
    const get = (name: string) => (headers.indexOf(name) >= 0 ? (cells[headers.indexOf(name)] ?? "").trim() : "");
    const name = get("name");
    const description = get("description");
    const department = get("department");
    const problems: string[] = [];
    if (cells.length > headers.length && cells.slice(headers.length).some((c) => c.trim() !== "")) problems.push("more values than columns");
    if (name.length === 0 || name.length > 100 || CONTROL.test(name)) problems.push("name must be 1-100 characters");
    if (description.length > 500 || CONTROL.test(description)) problems.push("description must be at most 500 characters");
    if (kind === "TEAMS" && (department.length === 0 || department.length > 100 || CONTROL.test(department))) problems.push("department is required");
    if (problems.length > 0) {
      issues.push({ row: line, name: name || null, message: problems.join("; ") });
      continue;
    }
    rows.push(kind === "TEAMS" ? { row: line, name, description, department } : { row: line, name, description });
  }
  return { ok: true, rows, issues };
}

// Fictional example rows only (never written to a database).
export const DEPARTMENTS_TEMPLATE = toCsv(STRUCTURE_COLUMNS.DEPARTMENTS, [
  ["Engineering", "Product development"],
  ["Quality", "Testing and release quality"],
]);

export const TEAMS_TEMPLATE = toCsv(STRUCTURE_COLUMNS.TEAMS, [
  ["Engineering", "Frontend", "Web and mobile user interfaces"],
  ["Engineering", "Backend", "APIs and services"],
  ["Quality", "QA", "Manual and automated testing"],
]);
