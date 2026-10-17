import { type FetchLike, ProviderError, type ProviderResponse, parseJson, providerRequest, retryAfterSeconds } from "./provider-http";

// GitHub REST client for automatic source import. Pure apart from injected HTTP. It only ever talks to
// https://api.github.com, and follows the archive redirect only to https://codeload.github.com (without the token).
// Owner and repository name always come from the project's connected repository record (verified server-side),
// never from a URL typed by a user. github.com only (GitHub Enterprise Server is not supported).

const API_HOST = "api.github.com";
const ARCHIVE_HOST = "codeload.github.com";
const API_TIMEOUT_MS = 15_000;
const ARCHIVE_TIMEOUT_MS = 60_000;
const JSON_LIMIT = 2 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_PAGES = 3; // branches / repositories listed: at most 300, flagged as truncated beyond that

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

export type GitHubRepo = { owner: string; name: string };

export function parseGitHubRepo(owner: string, name: string): GitHubRepo | null {
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}

// owner/name of a connected repository, when it is a github.com repository URL.
export function gitHubRepoFromUrl(repositoryUrl: string): GitHubRepo | null {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return parseGitHubRepo(parts[0], parts[1].replace(/\.git$/i, ""));
}

export type GitHubBranch = { name: string; sha: string };
export type GitHubCommit = { sha: string; message: string; authoredAt: string | null; htmlUrl: string };
export type GitHubRepository = { fullName: string; owner: string; name: string; private: boolean; defaultBranch: string; htmlUrl: string };

const repoPath = (repo: GitHubRepo) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

export class GitHubClient {
  constructor(
    private readonly token: string | null,
    private readonly fetchImpl?: FetchLike,
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "OneForAll",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private fail(response: ProviderResponse): never {
    const { status, headers } = response;
    const remaining = headers.get("x-ratelimit-remaining");
    if (status === 429 || (status === 403 && remaining === "0")) {
      const wait = retryAfterSeconds(headers, "x-ratelimit-reset");
      throw new ProviderError("rate_limited", `GitHub rate limit reached${wait !== undefined ? `; try again in about ${Math.ceil(wait / 60)} minute(s)` : ""}.${this.token ? "" : " Adding a token raises the limit."}`, status, wait);
    }
    if (status === 401) throw new ProviderError("unauthorized", "GitHub rejected the token. It may be expired or revoked; enter a new one.", status);
    if (status === 403) throw new ProviderError("forbidden", "GitHub denied access. Check that the token can read this repository's contents.", status);
    if (status === 404) {
      throw new ProviderError("not_found", this.token ? "Not found on GitHub, or the token cannot access it." : "Not found on GitHub. A private repository needs a token with read access.", status);
    }
    if (status === 409) throw new ProviderError("conflict", "The repository is empty.", status);
    if (status === 422) throw new ProviderError("invalid_request", "GitHub could not resolve that branch or commit.", status);
    throw new ProviderError("bad_response", `GitHub answered with an unexpected status (${status}).`, status);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await providerRequest({
      url: `https://${API_HOST}${path}`,
      headers: this.headers(),
      allowHost: (host) => host === API_HOST,
      maxBytes: JSON_LIMIT,
      timeoutMs: API_TIMEOUT_MS,
      fetchImpl: this.fetchImpl,
    });
    if (response.status !== 200) this.fail(response);
    return parseJson<T>(response);
  }

  async getRepository(repo: GitHubRepo): Promise<GitHubRepository> {
    const r = await this.get<{ full_name: string; owner: { login: string }; name: string; private: boolean; default_branch: string; html_url: string }>(repoPath(repo));
    return { fullName: r.full_name, owner: r.owner.login, name: r.name, private: r.private, defaultBranch: r.default_branch, htmlUrl: r.html_url };
  }

  async listBranches(repo: GitHubRepo): Promise<{ branches: GitHubBranch[]; truncated: boolean }> {
    const branches: GitHubBranch[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await this.get<{ name: string; commit: { sha: string } }[]>(`${repoPath(repo)}/branches?per_page=${PAGE_SIZE}&page=${page}`);
      for (const row of rows) if (typeof row.name === "string" && SHA.test(row.commit?.sha ?? "")) branches.push({ name: row.name, sha: row.commit.sha });
      if (rows.length < PAGE_SIZE) return { branches, truncated: false };
    }
    return { branches, truncated: true };
  }

  // A branch name or a full commit SHA -> the exact commit.
  async resolveCommit(repo: GitHubRepo, ref: string): Promise<GitHubCommit> {
    const c = await this.get<{ sha: string; html_url: string; commit: { message: string; author: { date: string } | null } }>(
      `${repoPath(repo)}/commits/${encodeURIComponent(ref)}`,
    );
    if (!SHA.test(c.sha)) throw new ProviderError("bad_response", "GitHub returned an invalid commit id.");
    return { sha: c.sha, message: (c.commit?.message ?? "").split("\n")[0].slice(0, 200), authoredAt: c.commit?.author?.date ?? null, htmlUrl: c.html_url };
  }

  // True when `sha` is the tip of `branch` or one of its ancestors.
  async isCommitOnBranch(repo: GitHubRepo, sha: string, branch: string): Promise<boolean> {
    const r = await this.get<{ status: string }>(`${repoPath(repo)}/compare/${encodeURIComponent(branch)}...${sha}`);
    return r.status === "identical" || r.status === "behind";
  }

  // The source archive (ZIP) of exactly this commit, at most `maxBytes`.
  async downloadArchive(repo: GitHubRepo, sha: string, maxBytes: number): Promise<Buffer> {
    if (!SHA.test(sha)) throw new ProviderError("invalid_request", "Invalid commit id.");
    let response: ProviderResponse;
    try {
      response = await providerRequest({
        url: `https://${API_HOST}${repoPath(repo)}/zipball/${sha}`,
        headers: this.headers(),
        allowHost: (host) => host === API_HOST,
        allowRedirectHost: (host) => host === ARCHIVE_HOST,
        maxRedirects: 1,
        maxBytes,
        timeoutMs: ARCHIVE_TIMEOUT_MS,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      if (error instanceof ProviderError && error.code === "too_large") {
        throw new ProviderError("too_large", `The repository archive is larger than the ${Math.round(maxBytes / 1024 / 1024)} MiB import limit.`);
      }
      throw error;
    }
    if (response.status !== 200) this.fail(response);
    return response.body;
  }

  // Repositories the token can access (token required).
  async listAccessibleRepositories(): Promise<{ repositories: GitHubRepository[]; truncated: boolean }> {
    if (!this.token) throw new ProviderError("unauthorized", "Add a GitHub token to list repositories.");
    const repositories: GitHubRepository[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await this.get<{ full_name: string; owner: { login: string }; name: string; private: boolean; default_branch: string; html_url: string }[]>(
        `/user/repos?per_page=${PAGE_SIZE}&page=${page}&sort=updated`,
      );
      for (const r of rows) {
        if (parseGitHubRepo(r.owner?.login ?? "", r.name ?? "")) {
          repositories.push({ fullName: r.full_name, owner: r.owner.login, name: r.name, private: r.private, defaultBranch: r.default_branch, htmlUrl: r.html_url });
        }
      }
      if (rows.length < PAGE_SIZE) return { repositories, truncated: false };
    }
    return { repositories, truncated: true };
  }

  // Who the token belongs to (validates a token when it is saved).
  async whoAmI(): Promise<{ login: string }> {
    const r = await this.get<{ login: string }>("/user");
    return { login: r.login };
  }
}
