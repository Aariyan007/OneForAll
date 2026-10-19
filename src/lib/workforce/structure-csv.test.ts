import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEPARTMENTS_TEMPLATE, TEAMS_TEMPLATE, isStructureKind, parseStructureCsv } from "./structure-csv";

describe("parseStructureCsv", () => {
  it("parses departments with quoted values", () => {
    const r = parseStructureCsv("DEPARTMENTS", 'name,description\nEngineering,"Build, ship"\nQuality,\n');
    assert.ok(r.ok);
    assert.deepEqual(r.rows, [
      { row: 2, name: "Engineering", description: "Build, ship" },
      { row: 3, name: "Quality", description: "" },
    ]);
    assert.deepEqual(r.issues, []);
  });

  it("parses teams and requires the department", () => {
    const r = parseStructureCsv("TEAMS", "department,name\nEngineering,Web\n,Orphan\n");
    assert.ok(r.ok);
    assert.deepEqual(r.rows, [{ row: 2, name: "Web", description: "", department: "Engineering" }]);
    assert.deepEqual(r.issues, [{ row: 3, name: "Orphan", message: "department is required" }]);
    const missing = parseStructureCsv("TEAMS", "name\nWeb\n");
    assert.deepEqual(missing, { ok: false, error: 'The "department" column is required.' });
  });

  it("reports row problems without rejecting the file", () => {
    const r = parseStructureCsv("DEPARTMENTS", `name,description\n,x\n${"n".repeat(101)},\nOk,${"d".repeat(501)}\n`);
    assert.ok(r.ok);
    assert.equal(r.rows.length, 0);
    assert.deepEqual(r.issues.map((i) => i.row), [2, 3, 4]);
  });

  it("refuses people, roles and unknown columns", () => {
    for (const header of ["email", "role", "password", "token", "user_id"]) {
      const r = parseStructureCsv("DEPARTMENTS", `name,${header}\nX,y\n`);
      assert.equal(r.ok, false, header);
    }
    assert.equal(parseStructureCsv("TEAMS", "department,name,budget\nA,B,1\n").ok, false);
    assert.equal(parseStructureCsv("DEPARTMENTS", "name,name\nA,B\n").ok, false);
  });

  it("refuses malformed and empty files", () => {
    assert.equal(parseStructureCsv("DEPARTMENTS", "").ok, false);
    assert.equal(parseStructureCsv("DEPARTMENTS", "name\n").ok, false);
    assert.equal(parseStructureCsv("DEPARTMENTS", 'name\n"unterminated\n').ok, false);
    assert.equal(parseStructureCsv("DEPARTMENTS", "name\n" + "x\n".repeat(2001)).ok, false);
  });

  it("templates parse cleanly", () => {
    const d = parseStructureCsv("DEPARTMENTS", DEPARTMENTS_TEMPLATE);
    const t = parseStructureCsv("TEAMS", TEAMS_TEMPLATE);
    assert.ok(d.ok && d.rows.length === 2 && d.issues.length === 0);
    assert.ok(t.ok && t.rows.length === 3 && t.issues.length === 0);
  });

  it("knows the kinds", () => {
    assert.ok(isStructureKind("TEAMS"));
    assert.ok(!isStructureKind("teams"));
    assert.ok(!isStructureKind("EMPLOYEES"));
  });
});
