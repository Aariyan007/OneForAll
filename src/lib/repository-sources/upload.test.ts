// Unit tests for the upload-selection rules shared by the form and the server action, and for the invariant that
// keeps the size limits of every layer consistent. Run: see docs/repository-ingestion.md ("Tests").
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARCHIVE_LIMITS, BODY_LIMITS } from "../../server/repository-sources/limits";
import { SMALLER_ARCHIVE_TIPS, formatBytes, validateArchiveSelection } from "./upload";

const MAX = ARCHIVE_LIMITS.maxUploadBytes;

describe("validateArchiveSelection (form and server use the same rules)", () => {
  it("no file selected: not submittable", () => {
    const r = validateArchiveSelection(null, MAX);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "missing");
  });

  it("invalid extension: not submittable, with an actionable message", () => {
    for (const name of ["source.tar.gz", "source.7z", "source", "zip", "source.zip.exe"]) {
      const r = validateArchiveSelection({ name, size: 100 }, MAX);
      assert.equal(!r.ok && r.reason, "extension", name);
    }
    assert.equal(validateArchiveSelection({ name: "SOURCE.ZIP", size: 100 }, MAX).ok, true);
  });

  it("empty file: not submittable", () => {
    const r = validateArchiveSelection({ name: "a.zip", size: 0 }, MAX);
    assert.equal(!r.ok && r.reason, "empty");
  });

  it("below and exactly at the limit: submittable", () => {
    assert.equal(validateArchiveSelection({ name: "a.zip", size: MAX - 1 }, MAX).ok, true);
    assert.equal(validateArchiveSelection({ name: "a.zip", size: MAX }, MAX).ok, true);
  });

  it("above the limit: not submittable, message states actual size and limit in MiB", () => {
    const r = validateArchiveSelection({ name: "a.zip", size: MAX + 1 }, MAX);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "too-large");
    assert.match(!r.ok ? r.message : "", /8\.00 MiB, over the 8\.00 MiB limit/);
    const big = validateArchiveSelection({ name: "a.zip", size: 12.5 * 1024 * 1024 }, MAX);
    assert.match(!big.ok ? big.message : "", /12\.50 MiB, over the 8\.00 MiB limit/);
    assert.ok(SMALLER_ARCHIVE_TIPS.some((tip) => tip.includes("node_modules")));
  });
});

describe("formatBytes uses binary units consistently", () => {
  it("formats B, KiB and MiB", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1023), "1023 B");
    assert.equal(formatBytes(1024), "1.0 KiB");
    assert.equal(formatBytes(1536), "1.5 KiB");
    assert.equal(formatBytes(8 * 1024 * 1024), "8.00 MiB");
    assert.equal(formatBytes(2 * 1024 * 1024), "2.00 MiB");
    assert.equal(formatBytes(-1), "unknown size");
  });
});

describe("limits are consistent across layers", () => {
  it("upload < upload request limit < proxy body buffer", () => {
    assert.ok(ARCHIVE_LIMITS.maxUploadBytes < BODY_LIMITS.uploadRequestBodyBytes);
    assert.ok(BODY_LIMITS.uploadRequestBodyBytes < BODY_LIMITS.proxyBodyBufferBytes);
    assert.equal(BODY_LIMITS.uploadRequestBodyBytes - ARCHIVE_LIMITS.maxUploadBytes, 1024 * 1024, "1 MiB multipart headroom");
  });

  it("per-file and total limits are coherent", () => {
    assert.ok(ARCHIVE_LIMITS.maxFileBytes <= ARCHIVE_LIMITS.maxTotalBytes);
    assert.ok(ARCHIVE_LIMITS.maxFiles <= ARCHIVE_LIMITS.maxEntries);
  });
});
