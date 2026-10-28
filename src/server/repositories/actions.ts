"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import { GitHubClient, gitHubRepoFromUrl } from "@/server/integrations/github";
import { GENERIC_MESSAGE, PERMISSION_MESSAGE } from "@/server/requirements/errors";
import {
  type RepositoryActionResult,
  type RepositoryFormState,
  isAllowedRepositoryTransition,
  parseConnectForm,
  repositoryStatusSchema,
  updateRepositorySchema,
} from "./schema";

// Every action verifies the session server-side, validates input, then lets the database (RLS,
// constraints and the lifecycle trigger) decide. Ids from the browser are only targets, never proof of
// authority. created_by is derived from auth.uid() inside the RPC, and a new repository is always PENDING.
// Metadata only: nothing here contacts a provider or handles credentials.

const projectIdsSchema = z.object({
  organizationId: idSchema,
  departmentId: idSchema,
  teamId: idSchema,
  projectId: idSchema,
});

function projectPath(ids: z.infer<typeof projectIdsSchema>) {
  return `/organizations/${ids.organizationId}/departments/${ids.departmentId}/teams/${ids.teamId}/projects/${ids.projectId}`;
}

function toErrorMessage(error: { code?: string; message: string }): string {
  switch (error.code) {
    case "42501":
      return PERMISSION_MESSAGE;
    case "23505":
      return "This project already has a repository. Disconnect it first.";
    case "23514":
      return error.message.includes("status transition")
        ? "That status change is not allowed."
        : "Some of the submitted values are not valid.";
    default:
      return GENERIC_MESSAGE;
  }
}

// Default branch (and visibility) of a public GitHub repository, read from GitHub itself.
async function detectGitHubDefaultBranch(
  provider: string,
  repositoryUrl: string,
): Promise<{ ok: true; branch: string; private: boolean } | { ok: false; error: string }> {
  const manual = "Could not detect the default branch automatically. Enter it manually.";
  if (provider !== "GITHUB") return { ok: false, error: "Enter the default branch (automatic detection works for GitHub repositories)." };
  const repo = gitHubRepoFromUrl(repositoryUrl);
  if (!repo) return { ok: false, error: manual };
  try {
    const info = await new GitHubClient(null).getRepository(repo);
    return info.defaultBranch ? { ok: true, branch: info.defaultBranch, private: info.private } : { ok: false, error: manual };
  } catch {
    return { ok: false, error: `${manual} (A private repository needs its branch entered, or a GitHub token under Integrations.)` };
  }
}

export async function createRepository(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  _prev: RepositoryFormState,
  formData: FormData,
): Promise<RepositoryFormState> {
  await requireUser();

  const ids = projectIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId });
  if (!ids.success) return { error: "Invalid project." };
  const parsed = parseConnectForm(formData);
  if (!parsed.success) return { fieldErrors: parsed.fieldErrors };

  const { provider, repositoryUrl, owner, name, visibility } = parsed.data;
  let defaultBranch = parsed.data.defaultBranch;
  let detectedVisibility = visibility;
  if (defaultBranch === "") {
    // No branch typed: ask the provider (public GitHub repositories need no token). Never assume "main".
    const detected = await detectGitHubDefaultBranch(provider, repositoryUrl);
    if (!detected.ok) return { fieldErrors: { defaultBranch: [detected.error] } };
    defaultBranch = detected.branch;
    if (visibility === "UNKNOWN") detectedVisibility = detected.private ? "PRIVATE" : "PUBLIC";
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_repository", {
    p_project_id: ids.data.projectId,
    p_provider: provider,
    p_repository_url: repositoryUrl,
    p_owner: owner,
    p_name: name,
    p_default_branch: defaultBranch,
    p_visibility: detectedVisibility,
  });
  if (error) return { error: toErrorMessage(error) };

  // No redirect(): the form opens this page with a full load (see src/components/ui/reload.ts).
  return { redirectTo: projectPath(ids.data) };
}

// Only default_branch and visibility are editable. The repository's identity (provider, URL, owner, name)
// is immutable: to point the project at a different repository, disconnect and connect again.
export async function updateRepository(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  _prev: RepositoryFormState,
  formData: FormData,
): Promise<RepositoryFormState> {
  await requireUser();

  const ids = projectIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId });
  const fields = updateRepositorySchema.safeParse({
    defaultBranch: formData.get("defaultBranch") ?? "",
    visibility: formData.get("visibility"),
  });
  if (!ids.success) return { error: "Invalid project." };
  if (!fields.success) return { fieldErrors: z.flattenError(fields.error).fieldErrors };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("repositories")
    .update({ default_branch: fields.data.defaultBranch, visibility: fields.data.visibility })
    .eq("project_id", ids.data.projectId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  // RLS hides rows the caller cannot update, so zero rows means not found or not permitted.
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidatePath(projectPath(ids.data));
  return {};
}

export async function updateRepositoryStatus(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  status: string,
): Promise<RepositoryActionResult> {
  await requireUser();

  const ids = projectIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId });
  const next = repositoryStatusSchema.safeParse(status);
  if (!ids.success) return { error: "Invalid project." };
  if (!next.success) return { error: "Invalid status." };

  const supabase = await createClient();
  const { data: current, error: readError } = await supabase
    .from("repositories")
    .select("status")
    .eq("project_id", ids.data.projectId)
    .maybeSingle();
  if (readError) return { error: toErrorMessage(readError) };
  if (!current) return { error: PERMISSION_MESSAGE };

  const from = repositoryStatusSchema.safeParse(current.status);
  if (!from.success) return { error: GENERIC_MESSAGE };
  if (from.data === next.data) return {};
  if (!isAllowedRepositoryTransition(from.data, next.data)) {
    return { error: `A ${from.data} repository cannot move to ${next.data}.` };
  }

  // `.eq("status", from)` makes the change a compare-and-set, so a concurrent change is not overwritten.
  const { data, error } = await supabase
    .from("repositories")
    .update({ status: next.data })
    .eq("project_id", ids.data.projectId)
    .eq("status", from.data)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidatePath(projectPath(ids.data));
  return {};
}

// "Disconnect" removes the repository record (there is no soft delete), freeing the project to connect another.
export async function disconnectRepository(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  // The trailing (prev, formData) pair is the signature useActionState requires; neither is needed here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: RepositoryActionResult,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<RepositoryActionResult> {
  await requireUser();

  const ids = projectIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId });
  if (!ids.success) return { error: "Invalid project." };

  const supabase = await createClient();
  const { data, error } = await supabase.from("repositories").delete().eq("project_id", ids.data.projectId).select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  // No revalidatePath: DisconnectRepositoryForm reloads the page instead (see src/components/ui/reload.ts).
  return { success: "Repository disconnected." };
}
