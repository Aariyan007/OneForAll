import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterMembers, isFiltered, parseMemberFilter } from "./filter";

const people = [
  { id: "1", role: "OWNER", name: "Olivia Owner", email: "olivia@example.com", jobTitle: null, department: null, team: null },
  { id: "2", role: "ADMIN", name: "Adam Admin", email: "adam@example.com", jobTitle: "Engineering Manager", department: "Engineering", team: null },
  { id: "3", role: "MEMBER", name: "Fran Frontend", email: "fran@example.com", jobTitle: "Frontend Engineer", department: "Engineering", team: "Web" },
  { id: "4", role: "MEMBER", status: "SUSPENDED", name: "Quinn QA", email: "quinn@example.com", jobTitle: "QA Engineer", department: "Quality", team: "QA Squad" },
];
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("parseMemberFilter", () => {
  it("reads a search term and a known role", () => {
    assert.deepEqual(parseMemberFilter({ q: "  fran  ", role: "MEMBER", status: "SUSPENDED" }), { q: "fran", role: "MEMBER", status: "SUSPENDED" });
  });

  it("ignores unknown roles, arrays and missing values", () => {
    assert.deepEqual(parseMemberFilter({ role: "SUPERUSER", status: "BANNED" }), { q: "", role: null, status: null });
    assert.deepEqual(parseMemberFilter({ role: "member" }), { q: "", role: null, status: null });
    assert.deepEqual(parseMemberFilter({ q: ["a", "b"], role: ["OWNER", "ADMIN"] }), { q: "", role: null, status: null });
    assert.deepEqual(parseMemberFilter({}), { q: "", role: null, status: null });
  });

  it("caps the search term length", () => {
    assert.equal(parseMemberFilter({ q: "x".repeat(500) }).q.length, 100);
  });
});

describe("filterMembers", () => {
  it("returns everyone without a filter", () => {
    assert.deepEqual(ids(filterMembers(people, { q: "", role: null })), ["1", "2", "3", "4"]);
  });

  it("filters by role", () => {
    assert.deepEqual(ids(filterMembers(people, { q: "", role: "MEMBER" })), ["3", "4"]);
    assert.deepEqual(ids(filterMembers(people, { q: "", role: "OWNER" })), ["1"]);
  });

  it("searches name, email, job title, department and team, case-insensitively", () => {
    assert.deepEqual(ids(filterMembers(people, { q: "OLIVIA", role: null })), ["1"]);
    assert.deepEqual(ids(filterMembers(people, { q: "quinn@", role: null })), ["4"]);
    assert.deepEqual(ids(filterMembers(people, { q: "qa engineer", role: null })), ["4"]);
    assert.deepEqual(ids(filterMembers(people, { q: "engineer", role: null })), ["2", "3", "4"]);
    assert.deepEqual(ids(filterMembers(people, { q: "engineering", role: null })), ["2", "3"]);
    assert.deepEqual(ids(filterMembers(people, { q: "squad", role: null })), ["4"]);
  });

  it("requires every term to match", () => {
    assert.deepEqual(ids(filterMembers(people, { q: "engineering web", role: null })), ["3"]);
    assert.deepEqual(ids(filterMembers(people, { q: "engineering quality", role: null })), []);
  });

  it("combines search and role", () => {
    assert.deepEqual(ids(filterMembers(people, { q: "engineering", role: "ADMIN" })), ["2"]);
    assert.deepEqual(ids(filterMembers(people, { q: "olivia", role: "MEMBER" })), []);
  });
});

describe("status filter", () => {
  it("separates suspended from active members (rows without a status are active)", () => {
    assert.deepEqual(ids(filterMembers(people, { q: "", role: null, status: "SUSPENDED" })), ["4"]);
    assert.deepEqual(ids(filterMembers(people, { q: "", role: null, status: "ACTIVE" })), ["1", "2", "3"]);
    assert.equal(isFiltered({ q: "", role: null, status: "SUSPENDED" }), true);
  });
});

describe("isFiltered", () => {
  it("is true only when a term or role is set", () => {
    assert.equal(isFiltered({ q: "", role: null }), false);
    assert.equal(isFiltered({ q: "a", role: null }), true);
    assert.equal(isFiltered({ q: "", role: "ADMIN" }), true);
  });
});
