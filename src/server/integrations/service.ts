import "server-only";
import { createClient } from "@/lib/supabase/server";
import { ingestSnapshotArchive } from "@/server/repository-sources/ingestion";
import { ARCHIVE_LIMITS } from "@/server/repository-sources/limits";
import { snapshotBranchSchema } from "@/server/repository-snapshots/schema";
import type { Database } from "@/types/database";
import { CredentialError, credentialAad, decryptCredential, encryptCredential } from "./crypto";
import { type GitHubRepo, GitHubClient, gitHubRepoFromUrl } from "./github";
import { INTEGRATION_KEY_MISSING, getIntegrationKey } from "./integration-key";
import { JiraClient, isJiraProjectKey, normalizeJiraSite } from "./jira";
import { type SyncOutcome, runJiraSync } from "./jira-sync";
import { ProviderError } from "./provider-http";

// Project integrations: GitHub source import and Jira Cloud issue import. Server-only. Every function receives an
// already verified project (organization -> department -> team -> project chain checked from the database by the
// caller) and every write goes through SECURITY DEFINER functions that re-check OWNER/ADMIN themselves (migration
// 20261021000001). Credentials are encrypted here before they reach the database and decrypted only here; they are
// never returned to a caller, logged or put in an error message.

export type IntegrationKind = "GITHUB" | "JIRA";
export type IntegrationRow = Database["public"]["Tables"]["project_integrations"]["Row"];
type RepositoryRow = { id: string; provider: string; repository_url: string; owner: string; name: string; default_branch: string };

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; code?: string };

const SHA = /^[0-9a-f]{40}$/;
const GENERIC = "Something went wrong. Try again.";

function providerMessage(error: unknown, fallback = GENERIC): { error: string; code?: string } {
  if (error instanceof ProviderError) return { error: error.message, code: error.code };
  if (error instanceof CredentialError) return { error: error.message, code: "credential" };
  return { error: fallback };
}

// ---------------------------------------------------------------------------------------------------------------
// Integration rows and credentials

export async function listProjectIntegrations(projectId: string): Promise<IntegrationRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("project_integrations").select("*").eq("project_id", projectId);
  if (error) throw new Error("Failed to load integrations.");
  return data;
}

async function getIntegration(projectId: string, kind: IntegrationKind): Promise<IntegrationRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("project_integrations").select("*").eq("project_id", projectId).eq("kind", kind).maybeSingle();
  if (error) throw new Error("Failed to load the integration.");
  return data;
}

async function saveIntegration(
  projectId: string,
  kind: IntegrationKind,
  options: { secret?: string; clear?: boolean; jiraSite?: string; jiraEmail?: string } = {},
): Promise<string> {
  let ciphertext: string | null = null;
  if (options.secret !== undefined) {
    const key = getIntegrationKey();
    if (!key) throw new Error(INTEGRATION_KEY_MISSING);
    ciphertext = encryptCredential(key, options.secret, credentialAad(projectId, kind));
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_project_integration", {
    p_project_id: projectId,
    p_kind: kind,
    p_ciphertext: ciphertext ?? undefined,
    p_clear_credential: options.clear ?? false,
    p_jira_site: options.jiraSite,
    p_jira_account_email: options.jiraEmail,
  });
  if (error || !data) throw new Error(error?.code === "42501" ? "You do not have permission to change this project's integrations." : "The integration could not be saved.");
  return data;
}

async function readSecret(integration: IntegrationRow): Promise<string | null> {
  if (!integration.has_credential || integration.status === "DISCONNECTED") return null;
  const key = getIntegrationKey();
  if (!key) throw new Error(INTEGRATION_KEY_MISSING);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_integration_ciphertext", { p_integration_id: integration.id });
  if (error) throw new Error("You do not have permission to use this integration.");
  if (!data) return null;
  return decryptCredential(key, data, credentialAad(integration.project_id, integration.kind as IntegrationKind));
}

async function recordResult(integrationId: string, ok: boolean, syncStatus: "SUCCEEDED" | "PARTIAL" | "FAILED" | null, message: string) {
  const supabase = await createClient();
  await supabase.rpc("record_integration_result", {
    p_integration_id: integrationId,
    p_status: ok ? "CONNECTED" : "ERROR",
    // NULL = a validation only (no sync result); the generated type does not express SQL NULL for this parameter.
    p_sync_status: syncStatus as string,
    p_message: message.slice(0, 500),
  });
}

export async function disconnectIntegration(projectId: string, kind: IntegrationKind): Promise<Result> {
  const integration = await getIntegration(projectId, kind);
  if (!integration) return { ok: false, error: "This integration is not connected." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("disconnect_project_integration", { p_integration_id: integration.id });
  if (error) return { ok: false, error: "The integration could not be disconnected." };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub

export function gitHubTargetOf(repository: RepositoryRow | null): GitHubRepo | null {
  if (!repository || repository.provider !== "GITHUB") return null;
  return gitHubRepoFromUrl(repository.repository_url);
}

async function gitHubClientFor(projectId: string): Promise<{ client: GitHubClient; integration: IntegrationRow | null; hasToken: boolean }> {
  const integration = await getIntegration(projectId, "GITHUB");
  const token = integration ? await readSecret(integration) : null;
  return { client: new GitHubClient(token), integration, hasToken: token !== null };
}

export async function saveGitHubToken(projectId: string, repository: RepositoryRow | null, token: string): Promise<Result<{ login: string }>> {
  const trimmed = token.trim();
  if (trimmed.length < 20 || trimmed.length > 255 || /\s/.test(trimmed)) return { ok: false, error: "That does not look like a GitHub token." };
  if (!getIntegrationKey()) return { ok: false, error: INTEGRATION_KEY_MISSING };
  const client = new GitHubClient(trimmed);
  let login: string;
  try {
    login = (await client.whoAmI()).login;
    const target = gitHubTargetOf(repository);
    if (target) await client.getRepository(target);
  } catch (error) {
    return { ok: false, ...providerMessage(error) };
  }
  try {
    const id = await saveIntegration(projectId, "GITHUB", { secret: trimmed });
    await recordResult(id, true, null, `Token saved for ${login}.`);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : GENERIC };
  }
  return { ok: true, login };
}

export async function removeGitHubToken(projectId: string): Promise<Result> {
  try {
    await saveIntegration(projectId, "GITHUB", { clear: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : GENERIC };
  }
}

export async function listGitHubBranches(projectId: string, repository: RepositoryRow | null) {
  const target = gitHubTargetOf(repository);
  if (!target) return { ok: false as const, error: "Connect a GitHub repository (https://github.com/owner/name) to this project first." };
  try {
    const { client } = await gitHubClientFor(projectId);
    return { ok: true as const, ...(await client.listBranches(target)) };
  } catch (error) {
    return { ok: false as const, ...providerMessage(error) };
  }
}

export async function listGitHubRepositories(projectId: string) {
  try {
    const { client, hasToken } = await gitHubClientFor(projectId);
    if (!hasToken) return { ok: false as const, error: "Add a GitHub token to list your repositories." };
    return { ok: true as const, ...(await client.listAccessibleRepositories()) };
  } catch (error) {
    return { ok: false as const, ...providerMessage(error) };
  }
}

export type ResolvedCommit = { sha: string; branch: string; message: string; authoredAt: string | null; htmlUrl: string };

// branch (+ optional full commit SHA) -> the exact commit, verified to be on that branch.
export async function resolveGitHubCommit(projectId: string, repository: RepositoryRow | null, branchInput: string, commitInput: string): Promise<Result<{ commit: ResolvedCommit }>> {
  const target = gitHubTargetOf(repository);
  if (!target) return { ok: false, error: "Connect a GitHub repository (https://github.com/owner/name) to this project first." };
  const branch = snapshotBranchSchema.safeParse(branchInput);
  if (!branch.success) return { ok: false, error: "Choose a valid branch." };
  const commit = commitInput.trim().toLowerCase();
  if (commit !== "" && !SHA.test(commit)) return { ok: false, error: "Enter the full 40-character commit SHA, or leave it empty for the branch tip." };
  try {
    const { client } = await gitHubClientFor(projectId);
    const resolved = await client.resolveCommit(target, commit || branch.data);
    if (commit && resolved.sha !== commit) return { ok: false, error: "GitHub resolved a different commit." };
    if (commit && !(await client.isCommitOnBranch(target, resolved.sha, branch.data))) {
      return { ok: false, error: `Commit ${commit.slice(0, 12)} is not on branch ${branch.data}.` };
    }
    return { ok: true, commit: { ...resolved, branch: branch.data } };
  } catch (error) {
    return { ok: false, ...providerMessage(error) };
  }
}

export type ImportResult = Result<{ snapshotId: string; message: string; analysisError?: string }> & { snapshotId?: string; changed?: boolean };

// Fetches exactly `sha` from GitHub and ingests it through the existing pipeline (same reader, limits, exclusions,
// signed manifest, atomic COMPLETED, structure analysis). The commit is re-verified here; the client's resolve step is
// only a preview. A COMPLETED snapshot of the commit is never replaced.
export async function importGitHubCommit(projectId: string, repository: RepositoryRow, branchInput: string, shaInput: string): Promise<ImportResult> {
  const resolved = await resolveGitHubCommit(projectId, repository, branchInput, shaInput);
  if (!resolved.ok) return resolved;
  const { sha, branch } = resolved.commit;
  const target = gitHubTargetOf(repository)!;
  const supabase = await createClient();

  // Reuse a PENDING/FAILED snapshot of this commit, refuse a COMPLETED or PROCESSING one, otherwise create one.
  const { data: existing, error: existingError } = await supabase
    .from("repository_snapshots")
    .select("id, status")
    .eq("repository_id", repository.id)
    .eq("commit_sha", sha)
    .order("created_at", { ascending: false });
  if (existingError) return { ok: false, error: GENERIC };
  const completed = existing.find((s) => s.status === "COMPLETED");
  if (completed) return { ok: false, error: `Commit ${sha.slice(0, 12)} is already imported.`, code: "duplicate", snapshotId: completed.id };
  if (existing.some((s) => s.status === "PROCESSING")) return { ok: false, error: "This commit is already being imported." , code: "busy" };
  let snapshotId = existing.find((s) => s.status === "PENDING" || s.status === "FAILED")?.id;
  if (!snapshotId) {
    const { data, error } = await supabase.rpc("create_repository_snapshot", { p_repository_id: repository.id, p_commit_sha: sha, p_branch: branch });
    if (error || !data[0]) return { ok: false, error: error?.code === "42501" ? "You do not have permission to import into this project." : "The snapshot could not be created." };
    snapshotId = data[0].id;
  }

  let integrationId: string;
  try {
    integrationId = (await getIntegration(projectId, "GITHUB"))?.id ?? (await saveIntegration(projectId, "GITHUB"));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : GENERIC, snapshotId };
  }

  let bytes: Buffer;
  try {
    const { client } = await gitHubClientFor(projectId);
    bytes = await client.downloadArchive(target, sha, ARCHIVE_LIMITS.maxUploadBytes);
  } catch (error) {
    const failure = providerMessage(error, "The repository archive could not be downloaded.");
    await recordResult(integrationId, failure.code !== "unauthorized" && failure.code !== "credential", "FAILED", `Import of ${sha.slice(0, 12)} failed: ${failure.error}`);
    // Nothing was ingested; the snapshot stays PENDING and the import can be retried.
    return { ok: false, ...failure, snapshotId };
  }

  const result = await ingestSnapshotArchive(repository.id, snapshotId, { kind: "GITHUB_ARCHIVE", bytes });
  if (!result.ok) {
    await recordResult(integrationId, true, "FAILED", `Import of ${sha.slice(0, 12)} failed: ${result.error}`);
    return { ok: false, error: result.error, snapshotId, changed: result.changed };
  }
  await recordResult(integrationId, true, result.analysisError ? "PARTIAL" : "SUCCEEDED", `Imported ${sha.slice(0, 12)} from ${branch}. ${result.message}`);
  return { ok: true, snapshotId, message: result.message, analysisError: result.analysisError, changed: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Jira

export async function connectJira(projectId: string, siteInput: string, emailInput: string, tokenInput: string): Promise<Result<{ displayName: string }>> {
  const site = normalizeJiraSite(siteInput);
  if (!site.ok) return { ok: false, error: site.error };
  const email = emailInput.trim();
  if (!/^[^@\s]{1,200}@[^@\s]{1,200}$/.test(email)) return { ok: false, error: "Enter the email address of the Atlassian account." };
  const token = tokenInput.trim();
  if (token.length < 10 || token.length > 2048 || /\s/.test(token)) return { ok: false, error: "That does not look like an Atlassian API token." };
  if (!getIntegrationKey()) return { ok: false, error: INTEGRATION_KEY_MISSING };

  let displayName: string;
  try {
    displayName = (await new JiraClient(site.site, email, token).myself()).displayName;
  } catch (error) {
    return { ok: false, ...providerMessage(error, "Jira could not be reached.") };
  }
  try {
    const id = await saveIntegration(projectId, "JIRA", { secret: token, jiraSite: site.site, jiraEmail: email });
    await recordResult(id, true, null, `Connected as ${displayName}.`);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : GENERIC };
  }
  return { ok: true, displayName };
}

async function jiraClientFor(projectId: string): Promise<{ client: JiraClient; integration: IntegrationRow }> {
  const integration = await getIntegration(projectId, "JIRA");
  if (!integration || integration.status === "DISCONNECTED" || !integration.jira_site || !integration.jira_account_email) {
    throw new ProviderError("invalid_request", "Connect Jira first.");
  }
  const token = await readSecret(integration);
  if (!token) throw new ProviderError("unauthorized", "The Jira API token is missing. Connect Jira again.");
  return { client: new JiraClient(integration.jira_site, integration.jira_account_email, token), integration };
}

export async function listJiraProjects(projectId: string) {
  try {
    const { client } = await jiraClientFor(projectId);
    return { ok: true as const, ...(await client.listProjects()) };
  } catch (error) {
    return { ok: false as const, ...providerMessage(error) };
  }
}

export async function selectJiraProject(projectId: string, key: string): Promise<Result> {
  if (!isJiraProjectKey(key)) return { ok: false, error: "Choose a Jira project." };
  try {
    const { client, integration } = await jiraClientFor(projectId);
    const project = await client.getProject(key);
    const supabase = await createClient();
    const { error } = await supabase.rpc("select_jira_project", { p_integration_id: integration.id, p_project_id: project.id, p_project_key: project.key, p_project_name: project.name });
    if (error) return { ok: false, error: "The Jira project could not be saved." };
    return { ok: true };
  } catch (error) {
    return { ok: false, ...providerMessage(error) };
  }
}

export async function syncJira(projectId: string): Promise<Result<{ outcome: SyncOutcome }>> {
  let client: JiraClient;
  let integration: IntegrationRow;
  try {
    ({ client, integration } = await jiraClientFor(projectId));
  } catch (error) {
    return { ok: false, ...providerMessage(error) };
  }
  const key = integration.jira_project_key;
  if (!key) return { ok: false, error: "Choose a Jira project before synchronizing." };

  const supabase = await createClient();
  const seenAt = new Date().toISOString();
  const outcome = await runJiraSync({
    fetchPage: (token) => client.searchIssuesPage(key, token),
    storePage: async (issues) => {
      const { data, error } = await supabase.rpc("upsert_jira_issues", { p_integration_id: integration.id, p_issues: issues, p_seen_at: seenAt });
      if (error || !data[0]) throw new Error("store failed");
      return { inserted: data[0].inserted, updated: data[0].updated };
    },
    markMissing: async () => {
      const { data, error } = await supabase.rpc("mark_missing_jira_issues", { p_integration_id: integration.id, p_seen_at: seenAt });
      if (error) throw new Error("mark failed");
      return data;
    },
  });
  const credentialsBroken = outcome.status === "FAILED" && /rejected|denied|token/i.test(outcome.message);
  await recordResult(integration.id, !credentialsBroken, outcome.status, outcome.message);
  return { ok: true, outcome };
}

export async function listJiraIssues(projectId: string, limit = 200) {
  const supabase = await createClient();
  const { data, error, count } = await supabase
    .from("jira_issues")
    .select("id, issue_key, summary, status_name, status_category, issue_type, priority_name, assignee_name, jira_site, jira_updated_at, last_synced_at, missing_in_source", { count: "exact" })
    .eq("project_id", projectId)
    .order("missing_in_source", { ascending: true })
    .order("jira_updated_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error("Failed to load imported Jira issues.");
  return { issues: data, total: count ?? data.length };
}
