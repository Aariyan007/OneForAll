// Unit tests for the workforce CSV parser/validator (pure). The database re-validates every row; see
// supabase/tests/workforce_directory_rls.sql.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CSV_LIMITS, CsvError, EMPLOYEES_TEMPLATE, csvCell, parseCsv, parseDirectoryCsv } from "./csv";

describe("parseCsv (RFC 4180)", () => {
  it("handles quotes, escaped quotes, commas and newlines inside quoted values, BOM and CRLF", () => {
    const text = '﻿name,notes\r\n"Doe, Jane","She said ""hi""\nsecond line"\r\nplain,x\r\n';
    const { headers, records } = parseCsv(text);
    assert.deepEqual(headers, ["name", "notes"]);
    assert.deepEqual(records[0].cells, ["Doe, Jane", 'She said "hi"\nsecond line']);
    assert.equal(records[0].line, 2);
    assert.deepEqual(records[1].cells, ["plain", "x"]);
    assert.equal(records[1].line, 4, "line numbers count the embedded newline");
  });

  it("skips blank lines and keeps empty cells", () => {
    const { records } = parseCsv("a,b,c\n\n1,,3\n\n");
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].cells, ["1", "", "3"]);
  });

  it("rejects malformed input", () => {
    assert.throws(() => parseCsv(""), CsvError);
    assert.throws(() => parseCsv('a,b\n"unterminated,1'), /not closed/);
    assert.throws(() => parseCsv('a,b\nab"c,1'), /quote inside an unquoted value/);
    assert.throws(() => parseCsv('a,b\n"x"y,1'), /after a closing quote/);
    assert.throws(() => parseCsv("a\u0000b"), /not a text CSV/);
    assert.throws(() => parseCsv(`a\n${"x".repeat(CSV_LIMITS.maxCellChars + 1)}`), /longer than/);
  });
});

describe("parseDirectoryCsv", () => {
  it("accepts the downloadable template", () => {
    const result = parseDirectoryCsv(EMPLOYEES_TEMPLATE);
    assert.ok(result.ok);
    assert.equal(result.rows.length, 3);
    assert.deepEqual(result.rows[1].skills, ["Python", "FastAPI", "PostgreSQL"]);
    assert.equal(result.rows[2].availability, "BUSY");
    assert.deepEqual(result.issues, []);
  });

  it("normalizes email, availability and skills; reports row-level problems with line numbers", () => {
    const csv = [
      "Email,Full_Name,Skills,Availability",
      " Alex@Example.COM ,Alex,React; React ;  Type  Script,available",
      "not-an-email,Bad,,",
      "alex@example.com,Dup,,",
      "sam@example.com,Sam,=SUM(A1),",
      "max@example.com,Max,,ON_LEAVE",
      "kim@example.com,Kim,,,extra",
    ].join("\n");
    const result = parseDirectoryCsv(csv);
    assert.ok(result.ok);
    assert.deepEqual(result.rows.map((r) => r.email), ["alex@example.com"]);
    assert.deepEqual(result.rows[0].skills, ["React", "Type Script"]);
    assert.equal(result.rows[0].availability, "AVAILABLE");
    const byRow = new Map(result.issues.map((i) => [i.row, i.message]));
    assert.match(byRow.get(3)!, /invalid email/);
    assert.match(byRow.get(4)!, /duplicate email/);
    assert.match(byRow.get(5)!, /invalid skills/);
    assert.match(byRow.get(6)!, /availability/);
    assert.match(byRow.get(7)!, /more values than columns/);
  });

  it("refuses role, password and other forbidden columns instead of ignoring them", () => {
    for (const column of ["role", "password", "token", "user_id", "organization_id"]) {
      const result = parseDirectoryCsv(`email,${column}\na@example.com,OWNER\n`);
      assert.ok(!result.ok, column);
      assert.match(result.error, new RegExp(`Column "${column}"`));
    }
    const role = parseDirectoryCsv("email,role\na@example.com,OWNER\n");
    assert.ok(!role.ok && /Roles cannot be set from a CSV/.test(role.error));
  });

  it("refuses unknown, duplicate or missing columns, empty files and oversized files", () => {
    assert.ok(!parseDirectoryCsv("email,salary\na@example.com,1\n").ok);
    assert.ok(!parseDirectoryCsv("email,email\na@example.com,b@example.com\n").ok);
    assert.ok(!parseDirectoryCsv("full_name\nAlex\n").ok);
    assert.ok(!parseDirectoryCsv("email\n").ok);
    assert.ok(!parseDirectoryCsv("").ok);
    const big = "email\n" + "a@example.com\n".repeat(80_000);
    const result = parseDirectoryCsv(big);
    assert.ok(!result.ok && /512 KiB/.test(result.error));
    const many = "email\n" + Array.from({ length: CSV_LIMITS.maxRows + 1 }, (_, i) => `p${i}@example.com`).join("\n");
    const tooMany = parseDirectoryCsv(many);
    assert.ok(!tooMany.ok && /more than 2000 rows/.test(tooMany.error));
  });
});

describe("csvCell (export)", () => {
  it("neutralizes spreadsheet formulas and quotes special characters", () => {
    assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
    assert.equal(csvCell("+1"), "'+1");
    assert.equal(csvCell("@cmd"), "'@cmd");
    assert.equal(csvCell("a,b"), '"a,b"');
    assert.equal(csvCell('say "x"'), '"say ""x"""');
    assert.equal(csvCell(null), "");
    assert.equal(csvCell("plain"), "plain");
  });
});
