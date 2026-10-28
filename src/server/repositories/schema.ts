import { z } from "zod";

export const PROVIDERS = ["GITHUB", "GITLAB", "BITBUCKET", "GENERIC_GIT"] as const;
export const VISIBILITIES = ["PUBLIC", "PRIVATE", "INTERNAL", "UNKNOWN"] as const;
export const REPOSITORY_STATUSES = ["PENDING", "CONNECTED", "DISCONNECTED", "ERROR"] as const;

export type Provider = (typeof PROVIDERS)[number];
export type Visibility = (typeof VISIBILITIES)[number];
export type RepositoryStatus = (typeof REPOSITORY_STATUSES)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  GITHUB: "GitHub",
  GITLAB: "GitLab",
  BITBUCKET: "Bitbucket",
  GENERIC_GIT: "Generic Git",
};
export const VISIBILITY_LABELS: Record<Visibility, string> = {
  PUBLIC: "Public",
  PRIVATE: "Private",
  INTERNAL: "Internal",
  UNKNOWN: "Unknown",
};
export const STATUS_LABELS: Record<RepositoryStatus, string> = {
  PENDING: "Pending",
  CONNECTED: "Connected",
  DISCONNECTED: "Disconnected",
  ERROR: "Error",
};

export const providerSchema = z.enum(PROVIDERS, { error: "Choose a provider." });
export const visibilitySchema = z.enum(VISIBILITIES, { error: "Choose a visibility." });
export const repositoryStatusSchema = z.enum(REPOSITORY_STATUSES, { error: "Invalid status." });

// Mirrors the database CHECKs (the database is the authority; this gives clean errors early).
// Never assume "main": the branch is required and stored as given.
export const branchSchema = z
  .string()
  .trim()
  .min(1, "Enter the default branch.")
  .max(255, "Use at most 255 characters.")
  .refine((value) => !/[\s~^:?*[\\]/.test(value) && !value.startsWith("-") && !value.includes(".."), {
    message: "That is not a valid branch name.",
  });

const OWNER_PATTERN = /^[A-Za-z0-9._/-]+$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export type RepositoryIdentity = { repositoryUrl: string; owner: string; name: string };

// Validates the URL and derives owner/name from it, so they never depend on separately trusted input.
// Only https URLs without credentials, query strings or fragments are accepted: a token pasted into
// the URL (https://user:token@host/...) is rejected here and by the database CHECK.
export function parseRepositoryUrl(
  provider: Provider,
  raw: string,
): { ok: true; identity: RepositoryIdentity } | { ok: false; error: string } {
  const input = raw.trim();
  if (input === "") return { ok: false, error: "Enter the repository URL." };
  if (input.length > 2048) return { ok: false, error: "That URL is too long." };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "Enter a valid https:// repository URL." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Only https:// repository URLs are supported." };
  if (url.username || url.password) {
    return { ok: false, error: "Remove credentials from the URL. Never put tokens or passwords in it." };
  }
  if (url.search || url.hash) return { ok: false, error: "Remove the query string or fragment from the URL." };
  if (!url.hostname) return { ok: false, error: "Enter a valid https:// repository URL." };

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length > 0) segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, "");
  if (segments.length < 2) return { ok: false, error: "The URL must point to a repository (owner/name)." };
  if ((provider === "GITHUB" || provider === "BITBUCKET") && segments.length !== 2) {
    return { ok: false, error: `Use the repository root URL, for example https://${url.host}/owner/name.` };
  }

  const owner = segments.slice(0, -1).join("/");
  const name = segments[segments.length - 1];
  if (!OWNER_PATTERN.test(owner) || owner.length > 100) return { ok: false, error: "The owner in the URL is not valid." };
  if (!NAME_PATTERN.test(name) || name.length > 100) return { ok: false, error: "The repository name in the URL is not valid." };

  return { ok: true, identity: { repositoryUrl: `https://${url.host}/${segments.join("/")}`, owner, name } };
}

export type RepositoryFormState = {
  error?: string;
  // Page to open after success (server-built from verified ids); see src/components/ui/reload.ts.
  redirectTo?: string;
  fieldErrors?: {
    provider?: string[];
    repositoryUrl?: string[];
    owner?: string[];
    name?: string[];
    defaultBranch?: string[];
    visibility?: string[];
  };
};

export type RepositoryActionResult = { error?: string; success?: string };

const connectFieldsSchema = z.object({
  provider: providerSchema,
  repositoryUrl: z.string(),
  owner: z.string().trim().max(100, "Use at most 100 characters."),
  name: z.string().trim().max(100, "Use at most 100 characters."),
  // Optional: when empty, the branch is detected from the provider when the repository is connected.
  defaultBranch: z.union([z.literal(""), branchSchema]),
  visibility: visibilitySchema,
});

export const updateRepositorySchema = z.object({ defaultBranch: branchSchema, visibility: visibilitySchema });

export type ConnectRepositoryInput = {
  provider: Provider;
  repositoryUrl: string;
  owner: string;
  name: string;
  defaultBranch: string;
  visibility: Visibility;
};

// Owner and name are optional in the form. When supplied they must agree with the URL, which stays the
// single source of truth; the derived values are what get stored.
export function parseConnectForm(
  formData: FormData,
): { success: true; data: ConnectRepositoryInput } | { success: false; fieldErrors: NonNullable<RepositoryFormState["fieldErrors"]> } {
  const base = connectFieldsSchema.safeParse({
    provider: formData.get("provider"),
    repositoryUrl: formData.get("repositoryUrl") ?? "",
    owner: formData.get("owner") ?? "",
    name: formData.get("name") ?? "",
    defaultBranch: String(formData.get("defaultBranch") ?? "").trim(),
    visibility: formData.get("visibility"),
  });
  const fieldErrors: NonNullable<RepositoryFormState["fieldErrors"]> = base.success
    ? {}
    : (z.flattenError(base.error).fieldErrors as NonNullable<RepositoryFormState["fieldErrors"]>);

  const provider = providerSchema.safeParse(formData.get("provider"));
  let identity: RepositoryIdentity | null = null;
  if (provider.success) {
    const parsed = parseRepositoryUrl(provider.data, String(formData.get("repositoryUrl") ?? ""));
    if (parsed.ok) identity = parsed.identity;
    else fieldErrors.repositoryUrl = [parsed.error];
  }

  if (identity) {
    const owner = String(formData.get("owner") ?? "").trim();
    const name = String(formData.get("name") ?? "").trim();
    if (owner && owner.toLowerCase() !== identity.owner.toLowerCase()) {
      fieldErrors.owner = [`Does not match the URL (${identity.owner}). Leave blank to use it.`];
    }
    if (name && name.toLowerCase() !== identity.name.toLowerCase()) {
      fieldErrors.name = [`Does not match the URL (${identity.name}). Leave blank to use it.`];
    }
  }

  if (!base.success || !identity || Object.keys(fieldErrors).length > 0) return { success: false, fieldErrors };
  return {
    success: true,
    data: {
      provider: base.data.provider,
      repositoryUrl: identity.repositoryUrl,
      owner: identity.owner,
      name: identity.name,
      defaultBranch: base.data.defaultBranch,
      visibility: base.data.visibility,
    },
  };
}

// Mirrors the database trigger: PENDING -> CONNECTED | ERROR, CONNECTED -> DISCONNECTED | ERROR,
// DISCONNECTED -> PENDING, ERROR -> PENDING.
const ALLOWED_TRANSITIONS: Record<RepositoryStatus, readonly RepositoryStatus[]> = {
  PENDING: ["CONNECTED", "ERROR"],
  CONNECTED: ["DISCONNECTED", "ERROR"],
  DISCONNECTED: ["PENDING"],
  ERROR: ["PENDING"],
};

export function isAllowedRepositoryTransition(from: RepositoryStatus, to: RepositoryStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
