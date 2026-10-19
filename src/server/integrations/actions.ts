"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import { PERMISSION_MESSAGE } from "@/server/requirements/errors";
import { getIntegrationContext } from "./context";
import { GitHubClient, parseGitHubRepo } from "./github";
import {
  connectJira,
  disconnectIntegration,
  gitHubTargetOf,
  listGitHubRepositories,
  removeGitHubToken,
  saveGitHubToken,
  selectJiraProject,
} from "./service";

// Integration settings actions. Every action verifies the session, re-checks the whole project chain from the database
// and refuses early unless the caller can manage the project; the database functions re-check OWNER/ADMIN for every
// write. Secrets arrive only in the POST body, are never echoed back, logged or stored in plaintext.
// No revalidatePath here: on this Next.js version (16.2.9) applying the re-rendered page that a revalidating Server
// Action returns was observed to leave the client transition pending (the change was saved, the UI stayed "pending").
// ActionForm reloads the page after a successful change instead (see src/components/ui/reload.ts).

export type IntegrationFormState = { error?: string; success?: string };

const idsSchema = z.object({ organizationId: idSchema, departmentId: idSchema, teamId: idSchema, projectId: idSchema });
type Ids = z.infer<typeof idsSchema>;

async function managed(raw: Ids) {
  await requireUser();
  const ids = idsSchema.safeParse(raw);
  if (!ids.success) return null;
  const context = await getIntegrationContext(ids.data.organizationId, ids.data.departmentId, ids.data.teamId, ids.data.projectId);
  if (!context || !context.canManage) return null;
  return { ids: ids.data, context };
}

const field = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

export async function saveGitHubTokenAction(
  organizationId: string, departmentId: string, teamId: string, projectId: string,
  _prev: IntegrationFormState, formData: FormData,
): Promise<IntegrationFormState> {
  const target = await managed({ organizationId, departmentId, teamId, projectId });
  if (!target) return { error: PERMISSION_MESSAGE };
  const result = await saveGitHubToken(target.context.project.id, target.context.repository, field(formData, "token"));
  if (!result.ok) return { error: result.error };
  return { success: `Token saved. It belongs to GitHub user ${result.login} and is stored encrypted.` };
}

export async function removeGitHubTokenAction(
  organizationId: string, departmentId: string, teamId: string, projectId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: IntegrationFormState, _formData: FormData,
): Promise<IntegrationFormState> {
  const target = await managed({ organizationId, departmentId, teamId, projectId });
  if (!target) return { error: PERMISSION_MESSAGE };
  const result = await removeGitHubToken(target.context.project.id);
  if (!result.ok) return { error: result.error };
  return { success: "Token removed. Public repositories can still be imported without one." };
}

// Connects one of the token's repositories as the project's repository (the project must not have one yet).
export async function connectGitHubRepositoryAction(
  organizationId: string, departmentId: string, teamId: string, projectId: string,
  _prev: IntegrationFormState, formData: FormData,
): Promise<IntegrationFormState> {
  const target = await managed({ organizationId, departmentId, teamId, projectId });
  if (!target) return { error: PERMISSION_MESSAGE };
  if (target.context.repository) return { error: "This project already has a repository. Disconnect it first." };
  const [owner, name] = field(formData, "repository").split("/");
  const repo = parseGitHubRepo(owner ?? "", name ?? "");
  if (!repo) return { error: "Choose a repository." };

  // Re-read it from GitHub with the stored token: never trust the submitted visibility or default branch.
  const listed = await listGitHubRepositories(target.context.project.id);
  if (!listed.ok) return { error: listed.error };
  const chosen = listed.repositories.find((r) => r.owner === repo.owner && r.name === repo.name);
  if (!chosen) return { error: "That repository is not available to the saved token." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_repository", {
    p_project_id: target.context.project.id,
    p_provider: "GITHUB",
    p_repository_url: `https://github.com/${chosen.owner}/${chosen.name}`,
    p_owner: chosen.owner,
    p_name: chosen.name,
    p_default_branch: chosen.defaultBranch,
    p_visibility: chosen.private ? "PRIVATE" : "PUBLIC",
  });
  if (error) return { error: error.code === "23505" ? "This project already has a repository." : "The repository could not be connected." };
  return { success: `Connected ${chosen.fullName}.` };
}

// Verifies that a public repository is reachable without a token (used by the "check access" button).
export async function checkGitHubAccessAction(
  organizationId: string, departmentId: string, teamId: string, projectId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: IntegrationFormState, _formData: FormData,
): Promise<IntegrationFormState> {
  const target = await managed({ organizationId, departmentId, teamId, projectId });
  if (!target) return { error: PERMISSION_MESSAGE };
  const repository = target.context.repository;
  const repo = gitHubTargetOf(repository);
  if (!repo) return { error: "Connect a GitHub repository (https://github.com/owner/name) first." };
  try {
    const info = await new GitHubClient(null).getRepository(repo);
    return { success: `${info.fullName} is ${info.private ? "private" : "public"}; default branch ${info.defaultBranch}.` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "GitHub could not be reached." };
  }
}

export async function connectJiraAction(
  organizationId: string, departmentId: string, teamId: string, projectId: string,
  _prev: IntegrationFormState, formData: FormData,
): Promise<IntegrationFormState> {
  const target = await managed({ organizationId, departmentId, teamId, projectId });
  if (!target) return { error: PERMISSION_MESSAGE };
  const result = await connectJira(target.context.project.id, field(formData, "site"), field(formData, "email"), field(formData, "token"));
  if (!result.ok) return { error: result.error };
  return { success: `Connected to Jira as ${result.displayName}. The API token is stored encrypted. Choose a Jira project next.` };
}

export async function selectJiraProjectAction(
  organizationId: string, departmentId: string, teamId: string, projectId: string,
  _prev: IntegrationFormState, formData: FormData,
): Promise<IntegrationFormState> {
  const target = await managed({ organizationId, departmentId, teamId, projectId });
  if (!target) return { error: PERMISSION_MESSAGE };
  const result = await selectJiraProject(target.context.project.id, field(formData, "projectKey"));
  if (!result.ok) return { error: result.error };
  return { success: "Jira project selected. Run a sync to import its issues." };
}

export async function disconnectIntegrationAction(
  organizationId: string, departmentId: string, teamId: string, projectId: string, kind: "GITHUB" | "JIRA",
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: IntegrationFormState, _formData: FormData,
): Promise<IntegrationFormState> {
  const target = await managed({ organizationId, departmentId, teamId, projectId });
  if (!target) return { error: PERMISSION_MESSAGE };
  if (kind !== "GITHUB" && kind !== "JIRA") return { error: "Unknown integration." };
  const result = await disconnectIntegration(target.context.project.id, kind);
  if (!result.ok) return { error: result.error };
  return { success: kind === "JIRA" ? "Jira disconnected. Imported issues are kept." : "GitHub disconnected. Snapshots are kept." };
}
