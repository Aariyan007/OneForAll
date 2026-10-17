// Unit tests for the integration modules with FAKE fetch/DNS implementations (no network, no credentials).
// These are mocked tests of OneForAll's own logic; they are NOT tests against real GitHub or Jira.
// Run: see docs/integrations.md ("Tests").
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CredentialError, credentialAad, decryptCredential, encryptCredential } from "./crypto";
import { GitHubClient, gitHubRepoFromUrl, parseGitHubRepo } from "./github";
import { JiraClient, type JiraIssue, mapJiraIssue, normalizeJiraSite } from "./jira";
import { runJiraSync } from "./jira-sync";
import { type FetchLike, ProviderError, isPrivateAddress, providerRequest } from "./provider-http";

const KEY = "unit-test-integration-key-0123456789abcdef";
const OTHER_KEY = "another-unit-test-integration-key-987654321";
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
// Same pattern as the CHECK on private.integration_credentials (migration 20261021000001).
const STORED_FORMAT = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{4,}$/;

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as FetchLike & { calls: Call[] };
  fn.calls = calls;
  return fn;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const publicDns = async () => [{ address: "104.192.141.1", family: 4 }];
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe("credential encryption", () => {
  it("round-trips and produces the stored format", () => {
    const aad = credentialAad(P1, "JIRA");
    const sealed = encryptCredential(KEY, "atlassian-api-token-value", aad);
    assert.match(sealed, STORED_FORMAT);
    assert.ok(!sealed.includes("atlassian-api-token-value"));
    assert.equal(decryptCredential(KEY, sealed, aad), "atlassian-api-token-value");
  });
  it("uses a fresh IV every time", () => {
    const aad = credentialAad(P1, "GITHUB");
    assert.notEqual(encryptCredential(KEY, "same-token", aad), encryptCredential(KEY, "same-token", aad));
  });
  it("is bound to the project and kind, the key, and its own bytes", () => {
    const sealed = encryptCredential(KEY, "github_pat_example_token", credentialAad(P1, "GITHUB"));
    assert.throws(() => decryptCredential(KEY, sealed, credentialAad(P2, "GITHUB")), CredentialError, "another project");
    assert.throws(() => decryptCredential(KEY, sealed, credentialAad(P1, "JIRA")), CredentialError, "another kind");
    assert.throws(() => decryptCredential(OTHER_KEY, sealed, credentialAad(P1, "GITHUB")), CredentialError, "rotated key");
    const parts = sealed.split(".");
    const flipped = [parts[0], parts[1], parts[2], (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1)].join(".");
    assert.throws(() => decryptCredential(KEY, flipped, credentialAad(P1, "GITHUB")), CredentialError, "tampered");
    assert.throws(() => decryptCredential(KEY, "plaintext", credentialAad(P1, "GITHUB")), CredentialError, "not a ciphertext");
  });
  it("error messages never contain the secret", () => {
    try {
      decryptCredential(OTHER_KEY, encryptCredential(KEY, "super-secret-value", credentialAad(P1, "JIRA")), credentialAad(P1, "JIRA"));
      assert.fail("should throw");
    } catch (error) {
      assert.ok(error instanceof Error && !error.message.includes("super-secret-value"));
    }
  });
});

describe("provider HTTP guards (SSRF, redirects, limits)", () => {
  const allowApi = (host: string) => host === "api.example.com";

  it("refuses non-https, credentials, other ports and other hosts before any request", async () => {
    const f = fakeFetch(() => json({}));
    for (const url of ["http://api.example.com/x", "https://user:pw@api.example.com/x", "https://api.example.com:8443/x", "https://evil.example.com/x", "https://127.0.0.1/x"]) {
      await assert.rejects(providerRequest({ url, allowHost: allowApi, maxBytes: 1000, timeoutMs: 1000, fetchImpl: f }), ProviderError, url);
    }
    assert.equal(f.calls.length, 0);
  });

  it("refuses hosts that resolve to private addresses", async () => {
    const f = fakeFetch(() => json({}));
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      await assert.rejects(
        providerRequest({ url: "https://api.example.com/x", allowHost: allowApi, maxBytes: 1000, timeoutMs: 1000, checkDns: true, fetchImpl: f, lookupImpl: async () => [{ address, family: address.includes(":") ? 6 : 4 }] }),
        (e: unknown) => e instanceof ProviderError && e.code === "invalid_request",
        address,
      );
    }
    assert.equal(f.calls.length, 0);
    assert.equal(isPrivateAddress("140.82.112.5"), false);
    assert.equal(isPrivateAddress("not-an-ip"), true);
  });

  it("follows a redirect only to an allowed host, and drops Authorization on a host change", async () => {
    const f = fakeFetch((url) =>
      url.startsWith("https://api.example.com/") ? new Response(null, { status: 302, headers: { location: "https://cdn.example.com/file" } }) : new Response("payload"),
    );
    const r = await providerRequest({
      url: "https://api.example.com/x",
      headers: { Authorization: "Bearer secret" },
      allowHost: allowApi,
      allowRedirectHost: (h) => h === "cdn.example.com",
      maxRedirects: 1,
      maxBytes: 1000,
      timeoutMs: 1000,
      fetchImpl: f,
    });
    assert.equal(r.body.toString(), "payload");
    assert.equal(headerOf(f.calls[0].init, "authorization"), "Bearer secret");
    assert.equal(headerOf(f.calls[1].init, "authorization"), null, "no token to the redirect target");
    assert.equal(f.calls[0].init.redirect, "manual");
  });

  it("refuses a redirect to a host that is not allowed, and redirects when none are allowed", async () => {
    const f = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } }));
    await assert.rejects(
      providerRequest({ url: "https://api.example.com/x", allowHost: allowApi, allowRedirectHost: (h) => h === "cdn.example.com", maxRedirects: 2, maxBytes: 1000, timeoutMs: 1000, fetchImpl: f }),
      ProviderError,
    );
    await assert.rejects(providerRequest({ url: "https://api.example.com/x", allowHost: allowApi, maxBytes: 1000, timeoutMs: 1000, fetchImpl: f }), (e: unknown) => e instanceof ProviderError && e.code === "bad_response");
  });

  it("aborts bodies over the byte cap (declared or streamed)", async () => {
    const declared = fakeFetch(() => new Response("x".repeat(10), { headers: { "content-length": "5000" } }));
    await assert.rejects(providerRequest({ url: "https://api.example.com/x", allowHost: allowApi, maxBytes: 100, timeoutMs: 1000, fetchImpl: declared }), (e: unknown) => e instanceof ProviderError && e.code === "too_large");
    const streamed = fakeFetch(() => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(50)); c.close(); } })));
    await assert.rejects(providerRequest({ url: "https://api.example.com/x", allowHost: allowApi, maxBytes: 100, timeoutMs: 1000, fetchImpl: streamed }), (e: unknown) => e instanceof ProviderError && e.code === "too_large");
  });

  it("maps timeouts and network failures to safe errors", async () => {
    const slow: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))));
    // AbortSignal.timeout uses an unref'd timer; keep the test process alive while waiting for it (a server always is).
    const keepAlive = setTimeout(() => undefined, 2000);
    try {
      await assert.rejects(providerRequest({ url: "https://api.example.com/x", allowHost: allowApi, maxBytes: 100, timeoutMs: 50, fetchImpl: slow }), (e: unknown) => e instanceof ProviderError && e.code === "timeout");
    } finally {
      clearTimeout(keepAlive);
    }
    const down: FetchLike = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(providerRequest({ url: "https://api.example.com/x", allowHost: allowApi, maxBytes: 100, timeoutMs: 1000, fetchImpl: down }), (e: unknown) => e instanceof ProviderError && e.code === "network");
  });
});

describe("GitHub client", () => {
  const repo = parseGitHubRepo("octo-org", "app.repo")!;

  it("validates repository identities and URLs", () => {
    assert.ok(parseGitHubRepo("octocat", "Hello-World"));
    assert.equal(parseGitHubRepo("-bad", "x"), null);
    assert.equal(parseGitHubRepo("ok", ".."), null);
    assert.equal(parseGitHubRepo("ok", "a/b"), null);
    assert.deepEqual(gitHubRepoFromUrl("https://github.com/octocat/Hello-World"), { owner: "octocat", name: "Hello-World" });
    assert.equal(gitHubRepoFromUrl("https://gitlab.com/octocat/Hello-World"), null);
    assert.equal(gitHubRepoFromUrl("https://github.com.evil.com/octocat/x"), null);
    assert.equal(gitHubRepoFromUrl("https://github.com/a/b/c"), null);
  });

  it("talks only to api.github.com, with the token only when one is set", async () => {
    const f = fakeFetch(() => json({ sha: "a".repeat(40), html_url: "https://github.com/x", commit: { message: "Fix\n\nbody", author: { date: "2026-10-01T00:00:00Z" } } }));
    const commit = await new GitHubClient("ghp_unit_test_token_value", f).resolveCommit(repo, "main");
    assert.equal(commit.sha, "a".repeat(40));
    assert.equal(commit.message, "Fix");
    assert.equal(new URL(f.calls[0].url).host, "api.github.com");
    assert.equal(headerOf(f.calls[0].init, "authorization"), "Bearer ghp_unit_test_token_value");
    const anon = fakeFetch(() => json({ sha: "b".repeat(40), html_url: "", commit: { message: "", author: null } }));
    await new GitHubClient(null, anon).resolveCommit(repo, "main");
    assert.equal(headerOf(anon.calls[0].init, "authorization"), null);
  });

  it("maps rate limits, revoked tokens, missing access and bad refs to clear errors", async () => {
    const cases: [Response, string][] = [
      [json({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120) }), "rate_limited"],
      [json({}, 429, { "retry-after": "30" }), "rate_limited"],
      [json({}, 401), "unauthorized"],
      [json({}, 403), "forbidden"],
      [json({}, 404), "not_found"],
      [json({}, 422), "invalid_request"],
      [json({}, 409), "conflict"],
      [json({}, 502), "bad_response"],
    ];
    for (const [response, code] of cases) {
      const f = fakeFetch(() => response.clone());
      await assert.rejects(new GitHubClient("t".repeat(40), f).resolveCommit(repo, "main"), (e: unknown) => e instanceof ProviderError && e.code === code, code);
    }
    const f = fakeFetch(() => json({}, 403, { "x-ratelimit-remaining": "0", "retry-after": "90" }));
    await assert.rejects(new GitHubClient(null, f).resolveCommit(repo, "main"), (e: unknown) => e instanceof ProviderError && e.retryAfterSeconds === 90 && /token raises/.test(e.message));
  });

  it("lists branches page by page and flags truncation", async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `b${i}`, commit: { sha: "c".repeat(40) } }));
    const short = fakeFetch(() => json(page(3)));
    assert.deepEqual((await new GitHubClient(null, short).listBranches(repo)).truncated, false);
    const long = fakeFetch(() => json(page(100)));
    const r = await new GitHubClient(null, long).listBranches(repo);
    assert.equal(r.branches.length, 300);
    assert.equal(r.truncated, true);
    assert.equal(long.calls.length, 3, "bounded to 3 pages");
  });

  it("checks that a commit is on a branch", async () => {
    for (const [status, expected] of [["identical", true], ["behind", true], ["ahead", false], ["diverged", false]] as const) {
      const f = fakeFetch(() => json({ status }));
      assert.equal(await new GitHubClient(null, f).isCommitOnBranch(repo, "d".repeat(40), "main"), expected, status);
    }
  });

  it("downloads the archive through the codeload redirect without sending the token there, within the size cap", async () => {
    const zip = Buffer.from("PK\u0003\u0004fake-zip");
    const f = fakeFetch((url) =>
      url.includes("/zipball/") ? new Response(null, { status: 302, headers: { location: "https://codeload.github.com/octo-org/app.repo/legacy.zip/sha" } }) : new Response(zip),
    );
    const bytes = await new GitHubClient("ghp_token_for_unit_tests_only", f).downloadArchive(repo, "e".repeat(40), 1024);
    assert.deepEqual(bytes, zip);
    assert.equal(new URL(f.calls[1].url).host, "codeload.github.com");
    assert.equal(headerOf(f.calls[1].init, "authorization"), null);
    const evil = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://attacker.example/zip" } }));
    await assert.rejects(new GitHubClient(null, evil).downloadArchive(repo, "e".repeat(40), 1024), ProviderError);
    const big = fakeFetch((url) => (url.includes("/zipball/") ? new Response(null, { status: 302, headers: { location: "https://codeload.github.com/z" } }) : new Response("x".repeat(5000))));
    await assert.rejects(new GitHubClient(null, big).downloadArchive(repo, "e".repeat(40), 1024), (e: unknown) => e instanceof ProviderError && e.code === "too_large" && /import limit/.test(e.message));
    await assert.rejects(new GitHubClient(null, big).downloadArchive(repo, "not-a-sha", 1024), ProviderError);
  });

  it("listing repositories needs a token", async () => {
    await assert.rejects(new GitHubClient(null, fakeFetch(() => json([]))).listAccessibleRepositories(), (e: unknown) => e instanceof ProviderError && e.code === "unauthorized");
  });
});

describe("Jira client", () => {
  const site = "https://acme.atlassian.net";

  it("accepts only Jira Cloud sites", () => {
    assert.deepEqual(normalizeJiraSite("acme.atlassian.net"), { ok: true, site });
    assert.deepEqual(normalizeJiraSite("https://ACME.atlassian.net/jira/software"), { ok: true, site });
    for (const bad of ["http://acme.atlassian.net", "https://acme.atlassian.net.evil.com", "https://evil.com/acme.atlassian.net", "https://u:p@acme.atlassian.net", "https://acme.atlassian.net:8080", "https://10.0.0.1", "https://localhost", ""]) {
      assert.equal(normalizeJiraSite(bad).ok, false, bad);
    }
  });

  it("maps issues defensively", () => {
    const issue = mapJiraIssue({ id: "10001", key: "ACME-1", fields: { summary: "S", status: { name: "Done", statusCategory: { key: "done" } }, issuetype: { name: "Bug" }, priority: { name: "High" }, assignee: { displayName: "Dev" }, updated: "2026-10-01T10:00:00.000+0000" } }, "ACME");
    assert.deepEqual(issue, { id: "10001", key: "ACME-1", summary: "S", status: "Done", statusCategory: "done", issueType: "Bug", priority: "High", assignee: "Dev", updated: "2026-10-01T10:00:00.000+0000" });
    assert.equal(mapJiraIssue({ id: "10001", key: "OTHER-1", fields: {} }, "ACME"), null, "another project");
    assert.equal(mapJiraIssue({ id: 10001, key: "ACME-1" }, "ACME"), null, "non-string id");
    assert.equal(mapJiraIssue({ id: "1", key: "ACME-1", fields: { summary: "" } }, "ACME")?.summary, "(no summary)");
    assert.equal(mapJiraIssue({ id: "1", key: "ACME-1", fields: { status: { statusCategory: { key: "weird" } } } }, "ACME")?.statusCategory, "unknown");
  });

  it("sends Basic auth only to the validated site and checks DNS", async () => {
    const f = fakeFetch(() => json({ accountId: "abc", displayName: "Dev One" }));
    const me = await new JiraClient(site, "dev@acme.test", "api-token-unit-test", { fetchImpl: f, lookupImpl: publicDns }).myself();
    assert.equal(me.displayName, "Dev One");
    assert.equal(new URL(f.calls[0].url).host, "acme.atlassian.net");
    assert.equal(headerOf(f.calls[0].init, "authorization"), `Basic ${Buffer.from("dev@acme.test:api-token-unit-test").toString("base64")}`);
    await assert.rejects(new JiraClient(site, "a@b.c", "token-x", { fetchImpl: f, lookupImpl: async () => [{ address: "10.0.0.5", family: 4 }] }).myself(), ProviderError);
    assert.throws(() => new JiraClient("https://evil.com", "a@b.c", "t"), ProviderError);
  });

  it("maps invalid credentials, missing permissions, deleted projects and rate limits", async () => {
    for (const [status, code, headers] of [[401, "unauthorized", {}], [403, "forbidden", {}], [404, "not_found", {}], [429, "rate_limited", { "retry-after": "17" }], [500, "bad_response", {}]] as const) {
      const f = fakeFetch(() => json({}, status, headers));
      await assert.rejects(new JiraClient(site, "a@b.c", "token-x", { fetchImpl: f, lookupImpl: publicDns }).myself(), (e: unknown) => e instanceof ProviderError && e.code === code && (code !== "rate_limited" || e.retryAfterSeconds === 17), code);
    }
  });

  it("paginates issue search with nextPageToken and never follows redirects", async () => {
    const f = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      assert.equal(body.jql, 'project = "ACME" ORDER BY key ASC');
      return body.nextPageToken
        ? json({ issues: [{ id: "3", key: "ACME-3", fields: { summary: "c" } }], isLast: true })
        : json({ issues: [{ id: "1", key: "ACME-1", fields: { summary: "a" } }, { id: "x", key: "ACME-2" }], nextPageToken: "tok-2", isLast: false });
    });
    const client = new JiraClient(site, "a@b.c", "token-x", { fetchImpl: f, lookupImpl: publicDns });
    const first = await client.searchIssuesPage("ACME");
    assert.equal(first.issues.length, 1);
    assert.equal(first.rejected, 1);
    assert.equal(first.nextPageToken, "tok-2");
    const second = await client.searchIssuesPage("ACME", "tok-2");
    assert.equal(second.nextPageToken, null);
    await assert.rejects(client.searchIssuesPage('ACME" OR project = "OTHER'), ProviderError, "the key cannot inject JQL");
    const redirecting = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://id.atlassian.com/login" } }));
    await assert.rejects(new JiraClient(site, "a@b.c", "token-x", { fetchImpl: redirecting, lookupImpl: publicDns }).myself(), (e: unknown) => e instanceof ProviderError && e.code === "bad_response");
  });
});

describe("Jira sync policy", () => {
  const issue = (n: number): JiraIssue => ({ id: String(n), key: `ACME-${n}`, summary: `s${n}`, status: null, statusCategory: "unknown", issueType: null, priority: null, assignee: null, updated: null });
  const pages = (count: number, perPage = 2) => async (token?: string) => {
    const index = token ? Number(token) : 0;
    return { issues: [issue(index * perPage + 1), issue(index * perPage + 2)], rejected: 0, nextPageToken: index + 1 < count ? String(index + 1) : null };
  };

  it("complete sync: every page stored, then missing issues marked", async () => {
    let marked = 0;
    const stored: string[] = [];
    const outcome = await runJiraSync({
      fetchPage: pages(3),
      storePage: async (issues) => { stored.push(...issues.map((i) => i.key)); return { inserted: issues.length, updated: 0 }; },
      markMissing: async () => { marked++; return 4; },
    });
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(stored.length, 6);
    assert.equal(marked, 1);
    assert.equal(outcome.missing, 4);
    assert.match(outcome.message, /6 new.*4 no longer in Jira/);
  });

  it("a rate limit part-way keeps what was imported and marks nothing missing", async () => {
    let marked = false;
    const outcome = await runJiraSync({
      fetchPage: async (token) => {
        if (token === "1") throw new ProviderError("rate_limited", "Jira rate limit reached; try again in about 30 second(s).", 429, 30);
        return { issues: [issue(1)], rejected: 0, nextPageToken: "1" };
      },
      storePage: async (issues) => ({ inserted: issues.length, updated: 0 }),
      markMissing: async () => { marked = true; return 0; },
    });
    assert.equal(outcome.status, "PARTIAL");
    assert.equal(outcome.retryAfterSeconds, 30);
    assert.equal(marked, false);
    assert.match(outcome.message, /Stopped after 1 issues.*nothing was marked missing/);
  });

  it("a failure on the first page is FAILED (e.g. revoked credentials)", async () => {
    const outcome = await runJiraSync({
      fetchPage: async () => { throw new ProviderError("unauthorized", "Jira rejected the email or API token.", 401); },
      storePage: async () => ({ inserted: 0, updated: 0 }),
      markMissing: async () => 0,
    });
    assert.equal(outcome.status, "FAILED");
    assert.match(outcome.message, /rejected/);
  });

  it("stops at the per-sync issue limit without marking missing", async () => {
    let marked = false;
    const outcome = await runJiraSync({ fetchPage: pages(100), storePage: async (i) => ({ inserted: i.length, updated: 0 }), markMissing: async () => { marked = true; return 0; }, maxIssues: 5 });
    assert.equal(outcome.status, "PARTIAL");
    assert.equal(marked, false);
    assert.match(outcome.message, /limit of 5 issues/);
  });

  it("a re-run reports updates, not duplicates (idempotency is enforced by the database upsert)", async () => {
    const outcome = await runJiraSync({ fetchPage: pages(1), storePage: async (i) => ({ inserted: 0, updated: i.length }), markMissing: async () => 0 });
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(outcome.inserted, 0);
    assert.equal(outcome.updated, 2);
  });

  it("a storage failure part-way is PARTIAL; malformed records are counted", async () => {
    let calls = 0;
    const outcome = await runJiraSync({
      fetchPage: async (token) => ({ issues: [issue(1)], rejected: 1, nextPageToken: token ? null : "1" }),
      storePage: async () => { if (++calls === 2) throw new Error("db down"); return { inserted: 1, updated: 0 }; },
      markMissing: async () => 0,
    });
    assert.equal(outcome.status, "PARTIAL");
    assert.equal(outcome.rejected, 1);
  });
});
