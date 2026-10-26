import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInvitationEmail, invitationLink, resolveAppUrl } from "./invitation-email";

describe("resolveAppUrl", () => {
  it("prefers APP_URL, then the request origin, then the build-time site URL", () => {
    const site = "http://localhost:3000";
    assert.equal(resolveAppUrl({ appUrl: "https://app.example.com/", origin: "https://other.example", siteUrl: site }), "https://app.example.com");
    assert.equal(resolveAppUrl({ appUrl: undefined, origin: "https://tunnel.example", siteUrl: site }), "https://tunnel.example");
    assert.equal(resolveAppUrl({ appUrl: "", origin: null, siteUrl: site }), "http://localhost:3000");
  });

  it("skips values that are not http(s) origins", () => {
    const site = "http://localhost:3000";
    assert.equal(resolveAppUrl({ appUrl: "javascript:alert(1)", origin: "null", siteUrl: site }), site);
    assert.equal(resolveAppUrl({ appUrl: "not a url", origin: "ftp://files.example", siteUrl: site }), site);
  });

  it("keeps only the origin of a configured URL", () => {
    assert.equal(resolveAppUrl({ appUrl: "https://app.example.com/some/path?x=1", origin: null, siteUrl: "http://localhost:3000" }), "https://app.example.com");
  });
});

describe("invitationLink", () => {
  it("puts the token in the URL fragment of the invitations page", () => {
    assert.equal(invitationLink("https://app.example.com", "abc_DEF-123"), "https://app.example.com/invitations#abc_DEF-123");
  });
});

describe("buildInvitationEmail", () => {
  const base = {
    organizationName: "TCS",
    inviterName: "Jithin",
    roleLabel: "Admin",
    link: "https://app.example.com/invitations#tok",
    expiresAt: "2026-11-02T10:00:00.000Z",
  };

  it("names the organization, inviter and role, and carries the link in text and HTML", () => {
    const mail = buildInvitationEmail(base);
    assert.equal(mail.subject, "Jithin invited you to TCS on OneForAll");
    assert.match(mail.text, /TCS/);
    assert.match(mail.text, /Admin/);
    assert.ok(mail.text.includes(base.link));
    assert.ok(mail.html.includes(`href="${base.link}"`));
    assert.match(mail.text, /2 Nov 2026/);
  });

  it("escapes names in the HTML body", () => {
    const mail = buildInvitationEmail({ ...base, organizationName: `<script>"x"&`, inviterName: "<b>Eve</b>" });
    assert.ok(!mail.html.includes("<script>"));
    assert.ok(mail.html.includes("&lt;script&gt;&quot;x&quot;&amp;"));
    assert.ok(mail.html.includes("&lt;b&gt;Eve&lt;/b&gt;"));
  });

  it("keeps the subject on one line", () => {
    const mail = buildInvitationEmail({ ...base, organizationName: "Evil\r\nBcc: x@example.com" });
    assert.ok(!/[\r\n]/.test(mail.subject));
  });
});
