import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPublicPath } from "./public-paths";

describe("isPublicPath", () => {
  it("keeps the existing public pages public", () => {
    for (const path of ["/", "/login", "/signup", "/auth/callback", "/invitations"]) assert.equal(isPublicPath(path), true, path);
  });

  it("makes the health check public without opening the rest of /api", () => {
    assert.equal(isPublicPath("/api/health"), true);
    assert.equal(isPublicPath("/api/healthz"), false);
    assert.equal(isPublicPath("/api/health/extra"), false);
    assert.equal(isPublicPath("/api"), false);
  });

  it("keeps app pages protected", () => {
    for (const path of ["/dashboard", "/organizations/new", "/loginx", "/signup-admin"]) assert.equal(isPublicPath(path), false, path);
  });
});
