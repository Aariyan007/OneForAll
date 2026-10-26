import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { healthReport } from "./health";

describe("healthReport", () => {
  it("is ok with 200 when the database answers", () => {
    const report = healthReport({ database: true, checkedAt: "2026-10-26T00:00:00.000Z" });
    assert.equal(report.httpStatus, 200);
    assert.deepEqual(report.body, { status: "ok", checks: { app: "ok", database: "ok" }, checkedAt: "2026-10-26T00:00:00.000Z" });
  });

  it("is degraded with 503 when the database does not answer", () => {
    const report = healthReport({ database: false, checkedAt: "2026-10-26T00:00:00.000Z" });
    assert.equal(report.httpStatus, 503);
    assert.equal(report.body.status, "degraded");
    assert.equal(report.body.checks.database, "unreachable");
  });
});
