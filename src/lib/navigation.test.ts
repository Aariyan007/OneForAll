import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStoredNotice, sameOriginPath } from "./navigation";

const ORIGIN = "http://localhost:3000";

describe("sameOriginPath", () => {
  it("accepts app paths, keeping query and hash", () => {
    assert.equal(sameOriginPath("/organizations/abc/departments", ORIGIN), "/organizations/abc/departments");
    assert.equal(sameOriginPath("/a/b?imported=1#intelligence", ORIGIN), "/a/b?imported=1#intelligence");
  });

  it("normalizes dot segments without leaving the origin", () => {
    assert.equal(sameOriginPath("/a/../b", ORIGIN), "/b");
  });

  it("refuses other origins and scheme tricks", () => {
    for (const href of [
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example/x",
      "/\\/evil.example",
      "javascript:alert(1)",
      "data:text/html,x",
      "relative/path",
      " /leading-space",
      "",
    ]) {
      assert.equal(sameOriginPath(href, ORIGIN), null, href);
    }
  });

  it("refuses missing values", () => {
    assert.equal(sameOriginPath(undefined, ORIGIN), null);
    assert.equal(sameOriginPath(null, ORIGIN), null);
  });
});

describe("parseStoredNotice", () => {
  const stored = (value: unknown) => JSON.stringify(value);

  it("returns the notice for the path it was saved for", () => {
    assert.deepEqual(parseStoredNotice(stored({ path: "/p", tone: "success", message: "Saved." }), "/p"), {
      tone: "success",
      message: "Saved.",
    });
    assert.deepEqual(parseStoredNotice(stored({ path: "/p", tone: "warning", title: "Sync incomplete", message: "2 of 3" }), "/p"), {
      tone: "warning",
      title: "Sync incomplete",
      message: "2 of 3",
    });
  });

  it("ignores a notice saved for another page", () => {
    assert.equal(parseStoredNotice(stored({ path: "/other", tone: "success", message: "Saved." }), "/p"), null);
  });

  it("ignores malformed or unexpected values", () => {
    for (const raw of [
      null,
      "",
      "not json",
      "null",
      "42",
      stored({ path: "/p", tone: "info", message: "x" }),
      stored({ path: "/p", tone: "success" }),
      stored({ path: "/p", tone: "success", message: "" }),
      stored({ path: "/p", tone: "success", message: 7 }),
      stored({ path: "/p", tone: "success", message: "x", title: 1 }),
      stored({ path: "/p", tone: "success", message: "x".repeat(501) }),
    ]) {
      assert.equal(parseStoredNotice(raw, "/p"), null, String(raw));
    }
  });

  it("drops unknown fields", () => {
    assert.deepEqual(parseStoredNotice(stored({ path: "/p", tone: "danger", message: "Failed.", html: "<b>x</b>" }), "/p"), {
      tone: "danger",
      message: "Failed.",
    });
  });
});
