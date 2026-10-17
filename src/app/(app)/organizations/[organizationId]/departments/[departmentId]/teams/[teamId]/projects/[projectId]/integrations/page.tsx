import { notFound } from "next/navigation";
import {
  ActionForm,
  GitHubImportPanel,
  GitHubRepositoryPicker,
  JiraProjectPicker,
  JiraSyncButton,
  SecretField,
  TextField,
} from "@/components/integrations/integration-client";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, formatDateTime } from "@/components/ui/data";
import { IconArrowLeft, IconBranch, IconExternal, IconListChecks, IconLock, IconSettings } from "@/components/ui/icons";
import { PageBody, PageHeader, SectionHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status";
import {
  checkGitHubAccessAction,
  connectGitHubRepositoryAction,
  connectJiraAction,
  disconnectIntegrationAction,
  removeGitHubTokenAction,
  saveGitHubTokenAction,
  selectJiraProjectAction,
} from "@/server/integrations/actions";
import { getIntegrationContext } from "@/server/integrations/context";
import { getIntegrationKey } from "@/server/integrations/integration-key";
import { gitHubTargetOf, listJiraIssues, listProjectIntegrations, type IntegrationRow } from "@/server/integrations/service";

export const metadata = { title: "Integrations · OneForAll" };

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function isStale(iso: string | null) {
  return iso !== null && Date.now() - Date.parse(iso) > STALE_AFTER_MS;
}

function LastResult({ integration }: { integration: IntegrationRow }) {
  if (!integration.last_sync_at && !integration.last_error) return <p className="t-small text-fg-3">No operation recorded yet.</p>;
  const stale = isStale(integration.last_sync_at);
  return (
    <div className="flex flex-col gap-1.5 text-[12.5px]">
      {integration.last_sync_at && (
        <p className="text-fg-2">
          Last run {formatDateTime(integration.last_sync_at)}{" "}
          {integration.last_sync_status && (
            <Badge tone={integration.last_sync_status === "SUCCEEDED" ? "success" : integration.last_sync_status === "PARTIAL" ? "warning" : "danger"}>
              {integration.last_sync_status.toLowerCase()}
            </Badge>
          )}{" "}
          {stale && <Badge tone="muted">stale (over 24 h)</Badge>}
        </p>
      )}
      {integration.last_sync_message && <p className="text-fg-3">{integration.last_sync_message}</p>}
      {integration.last_error && <p className="text-danger">{integration.last_error}</p>}
    </div>
  );
}

export default async function IntegrationsPage({
  params,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/integrations">) {
  const { organizationId, departmentId, teamId, projectId } = await params;
  const context = await getIntegrationContext(organizationId, departmentId, teamId, projectId);
  if (!context) notFound();
  const { organization, department, team, project, repository, canManage } = context;

  const [integrations, jiraIssues] = await Promise.all([listProjectIntegrations(project.id), listJiraIssues(project.id)]);
  const github = integrations.find((i) => i.kind === "GITHUB") ?? null;
  const jira = integrations.find((i) => i.kind === "JIRA") ?? null;
  const jiraConnected = jira !== null && jira.status !== "DISCONNECTED";
  const keyConfigured = getIntegrationKey() !== null; // a boolean only; the key never leaves the server

  const projectPath = `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}`;
  const base = `${projectPath}/integrations`;
  const ids = [organization.id, department.id, team.id, project.id] as const;
  const gitHubTarget = gitHubTargetOf(repository);

  return (
    <PageBody>
      <PageHeader
        crumbs={[{ label: project.name, href: projectPath }, { label: "Integrations" }]}
        icon={<IconSettings size={18} />}
        title="Integrations"
        description="Import source code from GitHub and issues from Jira Cloud into this project. Credentials are stored encrypted and used only on the server."
        actions={
          <ButtonLink href={projectPath} variant="secondary">
            <IconArrowLeft size={15} />
            Project
          </ButtonLink>
        }
      />

      {canManage && !keyConfigured && (
        <Alert tone="warning" title="Credential storage is not configured">
          The server has no INTEGRATION_ENCRYPTION_KEY, so tokens cannot be saved. Public GitHub repositories can still be imported. See
          docs/manual-setup-checklist.md.
        </Alert>
      )}

      <div className="mt-6 flex flex-col gap-8">
        {/* GitHub */}
        <section aria-labelledby="github-heading">
          <SectionHeader title="GitHub" description="Automatic source import of an exact commit into a snapshot." icon={<IconBranch size={16} />} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Card>
              <CardHeader
                title={gitHubTarget ? `${gitHubTarget.owner} / ${gitHubTarget.name}` : "No GitHub repository connected"}
                description={
                  gitHubTarget
                    ? "Choose a branch (and optionally a commit). The server resolves it to an exact commit, downloads that commit and processes it like an uploaded archive."
                    : repository
                      ? "This project's repository is not a github.com repository. Automatic import supports GitHub; use the ZIP upload on a snapshot instead."
                      : "Connect a repository first: pick one with a token, or connect it manually from the project page."
                }
                actions={github && <StatusBadge kind="repository" value={github.status} label={github.status.charAt(0) + github.status.slice(1).toLowerCase()} />}
              />
              <div className="flex flex-col gap-4 border-t border-border px-5 py-4">
                {gitHubTarget && canManage && (
                  <GitHubImportPanel apiUrl={`${base}/github`} defaultBranch={repository!.default_branch} snapshotsHref={`${projectPath}/repository/snapshots`} />
                )}
                {gitHubTarget && !canManage && <p className="t-small text-fg-3">Only organization owners and admins can import source.</p>}
                {!repository && canManage && github?.has_credential && (
                  <GitHubRepositoryPicker apiUrl={`${base}/github`} action={connectGitHubRepositoryAction.bind(null, ...ids)} />
                )}
                {!repository && canManage && !github?.has_credential && (
                  <p className="t-small text-fg-3">Save a token to choose from your repositories, or connect a public repository from the project page.</p>
                )}
                {github && <LastResult integration={github} />}
              </div>
            </Card>
            <Card>
              <CardHeader title="Access" description="Public repositories work without a token (GitHub allows 60 requests per hour per server)." />
              <div className="flex flex-col gap-4 border-t border-border px-5 py-4 text-[12.5px]">
                <p className="flex items-center gap-1.5 text-fg-2">
                  <IconLock size={13} />
                  {github?.has_credential ? "A token is saved (encrypted)." : "No token saved: public repositories only."}
                </p>
                {canManage ? (
                  <>
                    {keyConfigured && (
                      <ActionForm action={saveGitHubTokenAction.bind(null, ...ids)} submitLabel={github?.has_credential ? "Replace token" : "Save token"} pendingLabel="Checking with GitHub…">
                        <SecretField
                          name="token"
                          label="GitHub token"
                          hint="A fine-grained personal access token with read-only Contents and Metadata access to this repository. It is checked with GitHub, stored encrypted and never shown again."
                        />
                      </ActionForm>
                    )}
                    {github?.has_credential && (
                      <ActionForm action={removeGitHubTokenAction.bind(null, ...ids)} submitLabel="Remove token" pendingLabel="Removing…" variant="secondary" confirm="Remove the saved GitHub token?" />
                    )}
                    {gitHubTarget && !github?.has_credential && (
                      <ActionForm action={checkGitHubAccessAction.bind(null, ...ids)} submitLabel="Check public access" pendingLabel="Checking…" variant="secondary" />
                    )}
                  </>
                ) : (
                  <p className="text-fg-3">Only organization owners and admins can manage access.</p>
                )}
              </div>
            </Card>
          </div>
        </section>

        {/* Jira */}
        <section aria-labelledby="jira-heading">
          <SectionHeader title="Jira Cloud" description="One-way import of a Jira project's issues (Jira → OneForAll). Read-only here." icon={<IconListChecks size={16} />} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Card>
              <CardHeader
                title={jiraConnected ? (jira!.jira_project_key ? `${jira!.jira_project_key} · ${jira!.jira_project_name ?? ""}` : "No Jira project selected") : "Jira is not connected"}
                description={jiraConnected ? `${jira!.jira_site} · ${jira!.jira_account_email}` : "Connect with an Atlassian account email and an API token."}
                actions={jira && <StatusBadge kind="repository" value={jira.status} label={jira.status.charAt(0) + jira.status.slice(1).toLowerCase()} />}
              />
              <div className="flex flex-col gap-4 border-t border-border px-5 py-4">
                {jiraConnected && canManage && (
                  <>
                    <JiraProjectPicker apiUrl={`${base}/jira`} action={selectJiraProjectAction.bind(null, ...ids)} selectedKey={jira!.jira_project_key} />
                    {jira!.jira_project_key && <JiraSyncButton apiUrl={`${base}/jira`} />}
                  </>
                )}
                {jiraConnected && !canManage && <p className="t-small text-fg-3">Only organization owners and admins can change or sync this integration.</p>}
                {jira && <LastResult integration={jira} />}
                {!jiraConnected && !canManage && <p className="t-small text-fg-3">An owner or admin can connect Jira.</p>}
              </div>
            </Card>
            {canManage && (
              <Card>
                <CardHeader title={jiraConnected ? "Credentials" : "Connect Jira"} description="Validated with Jira before anything is saved." />
                <div className="flex flex-col gap-4 border-t border-border px-5 py-4">
                  {keyConfigured ? (
                    <ActionForm action={connectJiraAction.bind(null, ...ids)} submitLabel={jiraConnected ? "Update credentials" : "Connect"} pendingLabel="Checking with Jira…">
                      <TextField name="site" label="Jira site" placeholder="your-company.atlassian.net" hint="Jira Cloud only (<name>.atlassian.net)." />
                      <TextField name="email" label="Atlassian account email" type="email" />
                      <SecretField name="token" label="API token" hint="Create one at id.atlassian.com → Security → API tokens. Stored encrypted; never shown again." />
                    </ActionForm>
                  ) : (
                    <p className="t-small text-fg-3">Credential storage is not configured on this server.</p>
                  )}
                  {jiraConnected && (
                    <ActionForm
                      action={disconnectIntegrationAction.bind(null, ...ids, "JIRA")}
                      submitLabel="Disconnect Jira"
                      pendingLabel="Disconnecting…"
                      variant="danger"
                      confirm="Disconnect Jira? The API token is deleted; imported issues are kept."
                    />
                  )}
                </div>
              </Card>
            )}
          </div>

          <Card className="mt-4 overflow-hidden">
            <CardHeader
              title="Imported Jira issues"
              description={
                jira?.last_sync_at
                  ? `Imported from Jira (one-way, read-only). Last synchronized ${formatDateTime(jira.last_sync_at)}. Showing ${jiraIssues.issues.length} of ${jiraIssues.total}.`
                  : "Imported from Jira (one-way, read-only). Nothing has been imported yet."
              }
            />
            {jiraIssues.issues.length === 0 ? (
              <div className="border-t border-border px-5 py-6">
                <EmptyState compact icon={<IconListChecks size={18} />} title="No imported issues" description="Select a Jira project and run a sync. Native requirements and tasks are not affected." />
              </div>
            ) : (
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[720px] text-left text-[12.5px]">
                  <thead className="text-fg-3">
                    <tr className="border-b border-border">
                      <th className="px-5 py-2 font-medium">Key</th>
                      <th className="px-3 py-2 font-medium">Summary</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Type</th>
                      <th className="px-3 py-2 font-medium">Priority</th>
                      <th className="px-3 py-2 font-medium">Assignee</th>
                      <th className="px-3 py-2 font-medium">Updated in Jira</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jiraIssues.issues.map((issue) => (
                      <tr key={issue.id} className="border-b border-border last:border-0">
                        <td className="px-5 py-2 font-mono">
                          <a href={`${issue.jira_site}/browse/${issue.issue_key}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                            {issue.issue_key}
                            <IconExternal size={11} />
                          </a>
                        </td>
                        <td className="max-w-[360px] truncate px-3 py-2 text-fg" title={issue.summary}>
                          {issue.summary}
                          {issue.missing_in_source && (
                            <Badge tone="warning" className="ml-2">
                              no longer in Jira
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Badge tone={issue.status_category === "done" ? "success" : issue.status_category === "indeterminate" ? "accent" : "muted"}>{issue.status_name ?? "Unknown"}</Badge>
                        </td>
                        <td className="px-3 py-2 text-fg-2">{issue.issue_type ?? "—"}</td>
                        <td className="px-3 py-2 text-fg-2">{issue.priority_name ?? "—"}</td>
                        <td className="px-3 py-2 text-fg-2">{issue.assignee_name ?? "Unassigned"}</td>
                        <td className="px-3 py-2 text-fg-3">{issue.jira_updated_at ? formatDateTime(issue.jira_updated_at) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </section>
      </div>
    </PageBody>
  );
}
