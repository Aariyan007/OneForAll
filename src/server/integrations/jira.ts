import { type FetchLike, type LookupLike, ProviderError, type ProviderResponse, parseJson, providerRequest, retryAfterSeconds } from "./provider-http";

// Jira Cloud REST client for the one-way issue import. Pure apart from injected HTTP. Only https://<site>.atlassian.net
// sites are accepted, every resolved address must be public, and redirects are never followed. Authentication is an
// Atlassian account email plus API token (HTTP Basic), sent only to the validated site.

const SITE_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,254}$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-[0-9]{1,18}$/;
const TIMEOUT_MS = 20_000;
const JSON_LIMIT = 4 * 1024 * 1024;
export const ISSUE_PAGE_SIZE = 100;
const PROJECT_PAGE_SIZE = 50;
const MAX_PROJECT_PAGES = 4;

export function normalizeJiraSite(input: string): { ok: true; site: string } | { ok: false; error: string } {
  const raw = input.trim();
  if (raw === "" || raw.length > 300) return { ok: false, error: "Enter your Jira Cloud site, for example your-company.atlassian.net." };
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "That is not a valid Jira Cloud site address." };
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port !== "" && url.port !== "443")) {
    return { ok: false, error: "Use the https address of your Jira Cloud site, without credentials or a port." };
  }
  const host = url.hostname.toLowerCase();
  if (!SITE_HOST.test(host)) return { ok: false, error: "Only Jira Cloud sites (<name>.atlassian.net) are supported." };
  return { ok: true, site: `https://${host}` };
}

export function isJiraProjectKey(value: string): boolean {
  return PROJECT_KEY.test(value);
}

export type JiraIssue = {
  id: string;
  key: string;
  summary: string;
  status: string | null;
  statusCategory: "new" | "indeterminate" | "done" | "unknown";
  issueType: string | null;
  priority: string | null;
  assignee: string | null;
  updated: string | null;
};

type RawIssue = {
  id?: unknown;
  key?: unknown;
  fields?: {
    summary?: unknown;
    status?: { name?: unknown; statusCategory?: { key?: unknown } } | null;
    issuetype?: { name?: unknown } | null;
    priority?: { name?: unknown } | null;
    assignee?: { displayName?: unknown } | null;
    updated?: unknown;
  };
};

const str = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : null);

// One Jira issue -> the fields OneForAll mirrors, or null when the record is malformed (counted, never guessed).
export function mapJiraIssue(raw: RawIssue, projectKey: string): JiraIssue | null {
  const id = typeof raw.id === "string" && /^[0-9]{1,20}$/.test(raw.id) ? raw.id : null;
  const key = typeof raw.key === "string" && ISSUE_KEY.test(raw.key) && raw.key.startsWith(`${projectKey}-`) ? raw.key : null;
  if (!id || !key) return null;
  const f = raw.fields ?? {};
  const category = f.status?.statusCategory?.key;
  const updated = typeof f.updated === "string" && Number.isFinite(Date.parse(f.updated)) ? f.updated : null;
  return {
    id,
    key,
    summary: str(f.summary, 1000) ?? "(no summary)",
    status: str(f.status?.name, 100),
    statusCategory: category === "new" || category === "indeterminate" || category === "done" ? category : "unknown",
    issueType: str(f.issuetype?.name, 100),
    priority: str(f.priority?.name, 100),
    assignee: str(f.assignee?.displayName, 255),
    updated,
  };
}

export class JiraClient {
  private readonly host: string;

  constructor(
    private readonly site: string,
    private readonly email: string,
    private readonly token: string,
    private readonly deps: { fetchImpl?: FetchLike; lookupImpl?: LookupLike } = {},
  ) {
    const normalized = normalizeJiraSite(site);
    if (!normalized.ok || normalized.site !== site) throw new ProviderError("invalid_request", "Invalid Jira site.");
    this.host = new URL(site).hostname;
  }

  private fail(response: ProviderResponse): never {
    const { status } = response;
    if (status === 401) throw new ProviderError("unauthorized", "Jira rejected the email or API token. It may be wrong, expired or revoked.", status);
    if (status === 403) throw new ProviderError("forbidden", "Jira denied access. The account needs permission to browse this project.", status);
    if (status === 404) throw new ProviderError("not_found", "Not found in Jira (the site, project or issue does not exist or is not visible).", status);
    if (status === 429) {
      const wait = retryAfterSeconds(response.headers);
      throw new ProviderError("rate_limited", `Jira rate limit reached${wait !== undefined ? `; try again in about ${wait} second(s)` : ""}.`, status, wait);
    }
    if (status === 400) throw new ProviderError("invalid_request", "Jira refused the request.", status);
    throw new ProviderError("bad_response", `Jira answered with an unexpected status (${status}).`, status);
  }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await providerRequest({
      url: `${this.site}${path}`,
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        Authorization: `Basic ${Buffer.from(`${this.email}:${this.token}`, "utf8").toString("base64")}`,
        "User-Agent": "OneForAll",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      allowHost: (host) => host === this.host,
      maxBytes: JSON_LIMIT,
      timeoutMs: TIMEOUT_MS,
      checkDns: true,
      fetchImpl: this.deps.fetchImpl,
      lookupImpl: this.deps.lookupImpl,
    });
    if (response.status !== 200) this.fail(response);
    return parseJson<T>(response);
  }

  async myself(): Promise<{ accountId: string; displayName: string }> {
    const me = await this.request<{ accountId?: string; displayName?: string }>("/rest/api/3/myself");
    if (typeof me.accountId !== "string") throw new ProviderError("bad_response", "Jira returned an unexpected account.");
    return { accountId: me.accountId, displayName: typeof me.displayName === "string" ? me.displayName : me.accountId };
  }

  async listProjects(): Promise<{ projects: { id: string; key: string; name: string }[]; truncated: boolean }> {
    const projects: { id: string; key: string; name: string }[] = [];
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const r = await this.request<{ values?: { id?: unknown; key?: unknown; name?: unknown }[]; isLast?: boolean }>(
        `/rest/api/3/project/search?startAt=${page * PROJECT_PAGE_SIZE}&maxResults=${PROJECT_PAGE_SIZE}&orderBy=key`,
      );
      for (const p of r.values ?? []) {
        if (typeof p.id === "string" && /^[0-9]{1,20}$/.test(p.id) && typeof p.key === "string" && PROJECT_KEY.test(p.key)) {
          projects.push({ id: p.id, key: p.key, name: typeof p.name === "string" ? p.name.slice(0, 255) : p.key });
        }
      }
      if (r.isLast !== false || (r.values ?? []).length < PROJECT_PAGE_SIZE) return { projects, truncated: false };
    }
    return { projects, truncated: true };
  }

  async getProject(key: string): Promise<{ id: string; key: string; name: string }> {
    if (!PROJECT_KEY.test(key)) throw new ProviderError("invalid_request", "Invalid Jira project key.");
    const p = await this.request<{ id?: unknown; key?: unknown; name?: unknown }>(`/rest/api/3/project/${encodeURIComponent(key)}`);
    if (typeof p.id !== "string" || p.key !== key) throw new ProviderError("bad_response", "Jira returned an unexpected project.");
    return { id: p.id, key, name: typeof p.name === "string" ? p.name.slice(0, 255) : key };
  }

  // One page of a project's issues (enhanced JQL search, token-based pagination). The key is validated, so the JQL
  // cannot be altered by it.
  async searchIssuesPage(projectKey: string, nextPageToken?: string): Promise<{ issues: JiraIssue[]; rejected: number; nextPageToken: string | null }> {
    if (!PROJECT_KEY.test(projectKey)) throw new ProviderError("invalid_request", "Invalid Jira project key.");
    const r = await this.request<{ issues?: RawIssue[]; nextPageToken?: unknown; isLast?: unknown }>("/rest/api/3/search/jql", {
      jql: `project = "${projectKey}" ORDER BY key ASC`,
      fields: ["summary", "status", "issuetype", "priority", "assignee", "updated"],
      maxResults: ISSUE_PAGE_SIZE,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    const issues: JiraIssue[] = [];
    let rejected = 0;
    for (const raw of r.issues ?? []) {
      const issue = mapJiraIssue(raw, projectKey);
      if (issue) issues.push(issue);
      else rejected++;
    }
    const token = typeof r.nextPageToken === "string" && r.nextPageToken !== "" && r.isLast !== true ? r.nextPageToken : null;
    return { issues, rejected, nextPageToken: token };
  }
}
