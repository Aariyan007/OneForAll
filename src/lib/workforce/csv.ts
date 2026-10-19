// Workforce directory CSV: parsing (RFC 4180), validation and the templates. Pure (no I/O) and unit-tested.
// The parsed rows are validated AGAIN by the database (import_workforce_directory); this layer gives row-level
// feedback and refuses files that are not a directory at all. A CSV never carries roles, passwords or tokens: such
// columns make the whole file invalid instead of being ignored silently.

// 512 KiB keeps the confirm step (which re-sends the previewed text) under the 1 MB Server Action body limit.
export const CSV_LIMITS = { maxBytes: 512 * 1024, maxRows: 2000, maxCellChars: 1000 } as const;

export const DIRECTORY_COLUMNS = ["full_name", "email", "employee_code", "department", "team", "job_title", "skills", "availability"] as const;
export type DirectoryColumn = (typeof DIRECTORY_COLUMNS)[number];

export const AVAILABILITY = ["AVAILABLE", "BUSY", "UNAVAILABLE"] as const;
export type Availability = (typeof AVAILABILITY)[number];

// Columns that must never be accepted from a file, with the reason shown to the user.
const FORBIDDEN_COLUMNS: Record<string, string> = {
  role: "Roles cannot be set from a CSV. Invite the person with the role, or change it on the Members page.",
  roles: "Roles cannot be set from a CSV. Invite the person with the role, or change it on the Members page.",
  password: "Passwords are never imported. People sign up themselves through their invitation.",
  token: "Tokens are never imported.",
  user_id: "Account ids are not imported; people are matched by email.",
  organization_id: "The organization is the one you are importing into.",
};

export type ParsedCsv = { headers: string[]; records: { line: number; cells: string[] }[] };

export class CsvError extends Error {}

// RFC 4180 with the usual relaxations: optional UTF-8 BOM, LF or CRLF line ends, quoted fields with "" escapes and
// embedded commas/newlines. A quote inside an unquoted field, or an unterminated quoted field, is an error.
export function parseCsv(text: string): ParsedCsv {
  if (text.length === 0) throw new CsvError("The file is empty.");
  if (text.includes("\u0000")) throw new CsvError("The file is not a text CSV file.");
  let input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  input = input.replace(/\r\n?/g, "\n");

  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let fieldStarted = false;
  let line = 1;
  let rowLine = 1;

  const endCell = () => {
    if (cell.length > CSV_LIMITS.maxCellChars) throw new CsvError(`Line ${rowLine}: a value is longer than ${CSV_LIMITS.maxCellChars} characters.`);
    cells.push(cell);
    cell = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endCell();
    if (!(cells.length === 1 && cells[0].trim() === "")) rows.push({ line: rowLine, cells });
    if (rows.length > CSV_LIMITS.maxRows + 1) throw new CsvError(`The file has more than ${CSV_LIMITS.maxRows} rows.`);
    cells = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
          const next = input[i + 1];
          if (next !== undefined && next !== "," && next !== "\n") throw new CsvError(`Line ${line}: unexpected text after a closing quote.`);
        }
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (fieldStarted) throw new CsvError(`Line ${line}: a quote inside an unquoted value (wrap the value in quotes and double the quote).`);
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ",") {
      endCell();
    } else if (ch === "\n") {
      endRow();
      line++;
      rowLine = line;
    } else {
      cell += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new CsvError(`Line ${rowLine}: a quoted value is not closed.`);
  endRow();

  if (rows.length === 0) throw new CsvError("The file is empty.");
  const [header, ...records] = rows;
  return { headers: header.cells.map((h) => h.trim().toLowerCase()), records };
}

export type DirectoryRow = {
  row: number; // line number in the file, for messages
  email: string;
  full_name: string;
  employee_code: string;
  department: string;
  team: string;
  job_title: string;
  skills: string[];
  availability: string;
};

export type RowIssue = { row: number; email: string | null; message: string };

export type DirectoryParseResult =
  | { ok: true; rows: DirectoryRow[]; issues: RowIssue[] }
  | { ok: false; error: string };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SKILL = /^[\p{L}\p{N}][\p{L}\p{N} +#./&()_-]*$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// File -> rows ready for the database, plus row-level problems found here. Structural problems (bad header, size)
// reject the whole file.
export function parseDirectoryCsv(text: string): DirectoryParseResult {
  if (new TextEncoder().encode(text).length > CSV_LIMITS.maxBytes) return { ok: false, error: "The file is larger than 512 KiB." };
  let parsed: ParsedCsv;
  try {
    parsed = parseCsv(text);
  } catch (error) {
    return { ok: false, error: error instanceof CsvError ? error.message : "The file could not be read as CSV." };
  }
  const { headers, records } = parsed;
  for (const header of headers) {
    if (FORBIDDEN_COLUMNS[header]) return { ok: false, error: `Column "${header}": ${FORBIDDEN_COLUMNS[header]}` };
  }
  const unknown = headers.filter((h) => !(DIRECTORY_COLUMNS as readonly string[]).includes(h));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.map((h) => `"${h || "(empty)"}"`).join(", ")}. Allowed: ${DIRECTORY_COLUMNS.join(", ")}.` };
  }
  const duplicate = headers.find((h, i) => headers.indexOf(h) !== i);
  if (duplicate) return { ok: false, error: `Column "${duplicate}" appears twice.` };
  if (!headers.includes("email")) return { ok: false, error: 'The "email" column is required.' };
  if (records.length === 0) return { ok: false, error: "The file has a header but no rows." };
  if (records.length > CSV_LIMITS.maxRows) return { ok: false, error: `The file has more than ${CSV_LIMITS.maxRows} rows.` };

  const index = (name: DirectoryColumn) => headers.indexOf(name);
  const rows: DirectoryRow[] = [];
  const issues: RowIssue[] = [];
  const seen = new Set<string>();
  for (const { line, cells } of records) {
    const get = (name: DirectoryColumn) => (index(name) >= 0 ? (cells[index(name)] ?? "").trim() : "");
    const email = get("email").toLowerCase();
    const problems: string[] = [];
    if (cells.length > headers.length && cells.slice(headers.length).some((c) => c.trim() !== "")) problems.push("more values than columns");
    if (!EMAIL.test(email) || email.length > 320) problems.push("invalid email");
    else if (seen.has(email)) problems.push("duplicate email in the file");
    const full_name = get("full_name");
    const employee_code = get("employee_code");
    const job_title = get("job_title");
    const department = get("department");
    const team = get("team");
    for (const [label, value, max] of [["full_name", full_name, 100], ["employee_code", employee_code, 40], ["job_title", job_title, 100], ["department", department, 100], ["team", team, 100]] as const) {
      if (value.length > max || CONTROL.test(value)) problems.push(`invalid ${label}`);
    }
    const skills = [...new Set(get("skills").split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean))];
    if (skills.length > 50 || skills.some((s) => s.length > 60 || !SKILL.test(s))) problems.push("invalid skills (separate skills with ';')");
    const availability = get("availability").toUpperCase();
    if (availability && !(AVAILABILITY as readonly string[]).includes(availability)) problems.push("availability must be AVAILABLE, BUSY or UNAVAILABLE");

    if (problems.length > 0) {
      issues.push({ row: line, email: email || null, message: problems.join("; ") });
      continue;
    }
    seen.add(email);
    rows.push({ row: line, email, full_name, employee_code, department, team, job_title, skills, availability });
  }
  return { ok: true, rows, issues };
}

// Values starting with = + - @ (or a tab/CR) are prefixed with ' so spreadsheet programs do not run them as formulas.
export function csvCell(value: string | null | undefined): string {
  let text = value ?? "";
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: (string | null | undefined)[][]): string {
  return [headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\r\n") + "\r\n";
}

// Fictional example rows only (never written to a database).
export const EMPLOYEES_TEMPLATE = toCsv(DIRECTORY_COLUMNS, [
  ["Alex Example", "alex@example.com", "EMP-001", "Engineering", "Frontend", "Frontend Engineer", "React;TypeScript", "AVAILABLE"],
  ["Sam Example", "sam@example.com", "EMP-002", "Engineering", "Backend", "Backend Engineer", "Python;FastAPI;PostgreSQL", "AVAILABLE"],
  ["Maya Example", "maya@example.com", "EMP-003", "Quality", "QA", "QA Engineer", "API Testing;Automation", "BUSY"],
]);
