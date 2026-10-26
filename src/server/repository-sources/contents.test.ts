import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTENT_LIMITS, contentBatches, decodeStorableText } from "./contents";

const utf8 = (text: string) => Buffer.from(text, "utf8");

describe("decodeStorableText", () => {
  it("returns UTF-8 text unchanged, including CRLF, BOM and non-ASCII", () => {
    for (const text of ["export const a = 1;\n", "line\r\nnext", "﻿with bom", "ünïcödé ✓"]) {
      assert.equal(decodeStorableText(utf8(text)), text);
    }
  });

  it("refuses bytes that are not valid UTF-8", () => {
    assert.equal(decodeStorableText(Buffer.from([0xff, 0xfe, 0x41])), null);
  });

  it("refuses binary content with NUL bytes", () => {
    assert.equal(decodeStorableText(Buffer.from([0x41, 0x00, 0x42])), null);
  });

  it("refuses files over the stored-size limit", () => {
    assert.equal(decodeStorableText(Buffer.alloc(CONTENT_LIMITS.maxFileBytes + 1, 0x61)), null);
    assert.equal(decodeStorableText(Buffer.alloc(CONTENT_LIMITS.maxFileBytes, 0x61))?.length, CONTENT_LIMITS.maxFileBytes);
  });
});

describe("contentBatches", () => {
  it("keeps only storable files, in manifest order, and counts the rest", () => {
    const contents = new Map<string, Buffer>([
      ["a.ts", utf8("a")],
      ["logo.png", Buffer.from([0x89, 0x50, 0x00, 0x47])],
      ["b.ts", utf8("b")],
    ]);
    const result = contentBatches(["a.ts", "logo.png", "b.ts", "missing.ts"], contents);
    assert.deepEqual(result.batches, [[{ path: "a.ts", content: "a" }, { path: "b.ts", content: "b" }]]);
    assert.equal(result.skipped, 2);
  });

  it("splits batches by total bytes and by file count", () => {
    const big = "x".repeat(Math.floor(CONTENT_LIMITS.maxBatchBytes / 2) + 1);
    const contents = new Map<string, Buffer>([
      ["1", utf8(big)],
      ["2", utf8(big)],
      ["3", utf8("small")],
    ]);
    const bySize = contentBatches(["1", "2", "3"], contents);
    assert.deepEqual(bySize.batches.map((batch) => batch.map((file) => file.path)), [["1"], ["2", "3"]]);

    const many = new Map<string, Buffer>();
    const paths: string[] = [];
    for (let i = 0; i < CONTENT_LIMITS.maxBatchFiles + 1; i++) {
      paths.push(`f${i}`);
      many.set(`f${i}`, utf8("x"));
    }
    const byCount = contentBatches(paths, many);
    assert.deepEqual(byCount.batches.map((batch) => batch.length), [CONTENT_LIMITS.maxBatchFiles, 1]);
  });

  it("returns no batches when nothing is storable", () => {
    assert.deepEqual(contentBatches([], new Map()), { batches: [], skipped: 0 });
  });
});
