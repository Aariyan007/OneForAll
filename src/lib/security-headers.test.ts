import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTENT_SECURITY_POLICY, securityHeaders } from "./security-headers";

const byKey = (enforceCsp: boolean) => new Map(securityHeaders({ enforceCsp }).map((h) => [h.key, h.value]));

describe("securityHeaders", () => {
  it("sets the baseline browser protections", () => {
    const headers = byKey(false);
    assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(headers.get("X-Frame-Options"), "DENY");
    assert.equal(headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
    assert.match(headers.get("Strict-Transport-Security") ?? "", /^max-age=\d+; includeSubDomains$/);
    assert.match(headers.get("Permissions-Policy") ?? "", /camera=\(\)/);
  });

  it("sends the CSP as report-only until enforcement is switched on", () => {
    assert.equal(byKey(false).get("Content-Security-Policy-Report-Only"), CONTENT_SECURITY_POLICY);
    assert.equal(byKey(false).has("Content-Security-Policy"), false);
    assert.equal(byKey(true).get("Content-Security-Policy"), CONTENT_SECURITY_POLICY);
    assert.equal(byKey(true).has("Content-Security-Policy-Report-Only"), false);
  });

  it("forbids framing, plugins and foreign form targets in the CSP", () => {
    assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
    assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
    assert.match(CONTENT_SECURITY_POLICY, /form-action 'self'/);
    assert.match(CONTENT_SECURITY_POLICY, /default-src 'self'/);
  });
});
