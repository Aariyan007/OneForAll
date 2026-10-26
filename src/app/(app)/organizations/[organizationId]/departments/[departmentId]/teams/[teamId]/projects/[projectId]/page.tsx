import Link from "next/link";
import { notFound } from "next/navigation";
import { GitHubImportLauncher } from "@/components/integrations/integration-client";
import { ProjectTeamsEditor } from "@/components/tasks/task-controls";
import { DisconnectRepositoryForm } from "@/components/repositories/disconnect-repository-form";
import { RepositoryIntelligence } from "@/components/repository-snapshots/repository-intelligence";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardFooter, CardHeader, IconTile } from "@/components/ui/card";
import { EmptyState, KeyValueList, formatDate } from "@/components/ui/data";
import {
  IconArrowRight,
  IconBranch,
  IconExternal,
  IconFolder,
  IconGlobe,
  IconListChecks,
  IconLock,
  IconPlus,
  IconSettings,
} from "@/components/ui/icons";
import { PageBody, PageHeader, SectionHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status";
import { idSchema } from "@/server/departments/schema";
import { gitHubTargetOf } from "@/server/integrations/service";
import { getMyProject, getTeamContext } from "@/server/projects/queries";
import { disconnectRepository } from "@/server/repositories/actions";
import { getMyRepository } from "@/server/repositories/queries";
import { PROVIDER_LABELS, STATUS_LABELS, VISIBILITY_LABELS } from "@/server/repositories/schema";
import { listRequirements } from "@/server/requirements/queries";
import { listDepartmentsWithTeams } from "@/server/workforce/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Project · OneForAll" };

// Labels for values read from the database; falls back to the raw value for anything unexpected.
function label(labels: Record<string, string>, value: string) {
  return labels[value] ?? value;
}

export default async function ProjectPage({
  params,
  searchParams,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]">) {
  const { organizationId, departmentId, teamId, projectId } = await params;
  // Set by the GitHub import after a successful import; only ever used to look up a snapshot of this repository.
  const imported = (await searchParams).imported;
  const importedSnapshotId = typeof imported === "string" && idSchema.safeParse(imported).success ? imported : undefined;
  if (!idSchema.safeParse(projectId).success) notFound();

  const context = await getTeamContext(organizationId, departmentId, teamId);
  // No team-membership pre-check: getMyProject() is RLS-filtered, which also admits collaborating teams.
  if (!context) notFound();
  const { organization, department, team, canManage } = context;

  // Scoped to this team and RLS-filtered: a project from another team or tenant is simply not found.
  const project = await getMyProject(team.id, projectId);
  if (!project) notFound();

  // RLS returns the repository only when this project is visible to the caller.
  const supabase = await createClient();
  const [repository, requirements, { data: collaborators }, orgTeams] = await Promise.all([
    getMyRepository(project.id),
    listRequirements(project.id),
    supabase.from("project_teams").select("team_id").eq("project_id", project.id),
    canManage ? listDepartmentsWithTeams(organization.id) : Promise.resolve([]),
  ]);
  const allTeams = orgTeams.flatMap((d) => d.teams.map((t) => ({ id: t.id, name: `${d.name} / ${t.name}` })));
  const collaboratorIds = new Set((collaborators ?? []).map((c) => c.team_id));

  const deptsHref = `/organizations/${organization.id}/departments`;
  const teamsHref = `${deptsHref}/${department.id}/teams`;
  const projectsHref = `${teamsHref}/${team.id}/projects`;
  const projectPath = `${projectsHref}/${project.id}`;
  const openRequirements = requirements.filter((r) => r.status !== "COMPLETED" && r.status !== "CANCELLED").length;
  const doneRequirements = requirements.filter((r) => r.status === "COMPLETED").length;
  // Automatic import needs a github.com repository; any other repository uses the ZIP upload on a snapshot.
  const gitHubImport = canManage && gitHubTargetOf(repository) !== null;

  return (
    <PageBody>
      <PageHeader
        crumbs={[
          { label: organization.name, href: deptsHref },
          { label: department.name, href: teamsHref },
          { label: team.name, href: projectsHref },
          { label: project.name },
        ]}
        icon={<IconFolder size={18} />}
        title={project.name}
        description={project.description || undefined}
        badges={
          <>
            <StatusBadge kind="projectType" value={project.project_type} />
            <StatusBadge kind="project" value={project.status} />
            <span className="ml-1 font-mono text-[11.5px] text-fg-3">{project.slug}</span>
          </>
        }
        actions={
          <>
            <ButtonLink href={`${projectPath}/requirements`} variant="secondary">
              <IconListChecks size={15} />
              Requirements
            </ButtonLink>
            <ButtonLink href={`${projectPath}/integrations`} variant="secondary">
              <IconSettings size={15} />
              Integrations
            </ButtonLink>
            {canManage && (
              <ButtonLink href={`${projectPath}/requirements/new`} variant="primary">
                <IconPlus size={15} />
                New requirement
              </ButtonLink>
            )}
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-8">
          {/* Engineering at a glance */}
          <section>
            <SectionHeader title="Engineering" description="Planning and code for this project." />
            <div className="grid gap-3 sm:grid-cols-2">
              <EngineeringCard
                href={`${projectPath}/requirements`}
                icon={<IconListChecks size={16} />}
                title="Requirements"
                description="Backlog of what this project must deliver."
                stat={requirements.length}
                statLabel={requirements.length === 1 ? "requirement" : "requirements"}
                footer={requirements.length > 0 ? `${openRequirements} open · ${doneRequirements} completed` : "No requirements yet"}
                cta="Open backlog"
              />
              <EngineeringCard
                href={repository ? "#repository" : canManage ? `${projectPath}/repository/new` : "#repository"}
                icon={<IconBranch size={16} />}
                title="Repository"
                description={repository ? `${repository.owner} / ${repository.name}` : "No repository connected."}
                badge={repository ? <StatusBadge kind="repository" value={repository.status} label={label(STATUS_LABELS, repository.status)} /> : undefined}
                footer={repository ? `${label(PROVIDER_LABELS, repository.provider)} · ${repository.default_branch}` : canManage ? "Record the repository this project ships" : "An owner or admin can connect one"}
                cta={repository ? "View repository" : canManage ? "Connect repository" : "Details"}
              />
            </div>
          </section>

          {/* Repository */}
          <section id="repository" className="scroll-mt-24">
            <SectionHeader title="Repository" description="The primary repository recorded for this project." icon={<IconBranch size={16} />} />
            {repository ? (
              <Card>
                <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <IconTile tone="accent">
                      <IconBranch size={16} />
                    </IconTile>
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-semibold text-fg">
                        {repository.owner} <span className="text-fg-3">/</span> {repository.name}
                      </p>
                      <a
                        href={repository.repository_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex max-w-full items-center gap-1 truncate font-mono text-[12px] text-fg-3 transition-colors hover:text-accent"
                      >
                        <span className="truncate">{repository.repository_url}</span>
                        <IconExternal size={12} className="shrink-0" />
                      </a>
                    </div>
                  </div>
                  <StatusBadge kind="repository" value={repository.status} label={label(STATUS_LABELS, repository.status)} />
                </div>
                <div className="grid grid-cols-2 border-t border-border sm:grid-cols-4">
                  <RepoFact label="Provider" value={label(PROVIDER_LABELS, repository.provider)} />
                  <RepoFact label="Default branch" value={<span className="font-mono">{repository.default_branch}</span>} />
                  <RepoFact
                    label="Visibility"
                    value={
                      <span className="inline-flex items-center gap-1.5">
                        {repository.visibility === "PUBLIC" ? <IconGlobe size={13} /> : <IconLock size={13} />}
                        {label(VISIBILITY_LABELS, repository.visibility)}
                      </span>
                    }
                  />
                  <RepoFact label="Status" value={label(STATUS_LABELS, repository.status)} />
                </div>
                {/* UI hint only. The import route re-checks OWNER/ADMIN and the database decides every write. */}
                {gitHubImport && (
                  <div className="flex flex-col gap-2 border-t border-border px-5 py-4">
                    {repository.status === "ERROR" && (
                      <p className="t-small text-warning">
                        GitHub did not allow access to this repository on the last check. A private repository needs a token:{" "}
                        <Link href={`${projectPath}/integrations`} className="underline underline-offset-2">
                          add one under Integrations
                        </Link>
                        , then import again.
                      </p>
                    )}
                    <GitHubImportLauncher
                      apiUrl={`${projectPath}/integrations/github`}
                      defaultBranch={repository.default_branch}
                      snapshotsHref={`${projectPath}/repository/snapshots`}
                      resultHref={`${projectPath}?imported={snapshotId}#intelligence`}
                    />
                  </div>
                )}
                {/* UI hint only. The database enforces who may actually disconnect. */}
                {canManage && (
                  <CardFooter className="justify-end">
                    <DisconnectRepositoryForm
                      action={disconnectRepository.bind(null, organization.id, department.id, team.id, project.id)}
                    />
                  </CardFooter>
                )}
              </Card>
            ) : (
              <EmptyState
                compact
                icon={<IconBranch size={20} />}
                title="No repository connected"
                description="Record the repository this project ships to unlock snapshots and structure intelligence. Nothing is cloned and no credentials are stored."
                action={
                  canManage && (
                    <ButtonLink
                      href={`/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}/repository/new`}
                      variant="primary"
                    >
                      <IconPlus size={15} />
                      Connect repository
                    </ButtonLink>
                  )
                }
              />
            )}
          </section>

          {/* The sidebar's "Engineering Intelligence" link targets #intelligence, so the anchor exists either way. */}
          {!repository && (
            <section id="intelligence" className="scroll-mt-24">
              <SectionHeader
                title="Repository Intelligence"
                description="Snapshots of the code this project ships, and the structure extracted from them."
                icon={<IconBranch size={16} />}
              />
              <EmptyState
                compact
                icon={<IconBranch size={20} />}
                title="Connect a repository first"
                description="Snapshots, structure analysis and the AI assistant work on a connected repository."
              />
            </section>
          )}

          {repository && (
            <RepositoryIntelligence
              organizationId={organization.id}
              departmentId={department.id}
              teamId={team.id}
              projectId={project.id}
              repositoryId={repository.id}
              repositoryPath={`/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}/repository`}
              canManage={canManage}
              gitHubImport={gitHubImport}
              importedSnapshotId={importedSnapshotId}
            />
          )}
        </div>

        {/* Side panel (below the main column until xl) */}
        <aside className="grid gap-3 sm:grid-cols-2 xl:flex xl:flex-col">
          <Card>
            <CardHeader title="Project overview" />
            <div className="px-5 py-4">
              <KeyValueList
                items={[
                  { label: "Type", value: <StatusBadge kind="projectType" value={project.project_type} /> },
                  { label: "Status", value: <StatusBadge kind="project" value={project.status} /> },
                  { label: "Team", value: <Link href={projectsHref} className="hover:text-accent">{team.name}</Link> },
                  { label: "Department", value: <Link href={teamsHref} className="hover:text-accent">{department.name}</Link> },
                  { label: "Organization", value: <Link href={deptsHref} className="hover:text-accent">{organization.name}</Link> },
                  { label: "Created", value: formatDate(project.created_at) },
                ]}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="Teams on this project" description={`${team.name} owns it. Collaborating teams can see it and receive handoffs.`} />
            <div className="px-5 py-4">
              {canManage ? (
                <ProjectTeamsEditor
                  ids={{ organizationId: organization.id, departmentId: department.id, teamId: team.id, projectId: project.id }}
                  teams={allTeams.filter((t) => collaboratorIds.has(t.id))}
                  available={allTeams.filter((t) => t.id !== team.id && !collaboratorIds.has(t.id))}
                />
              ) : (
                <p className="t-small text-fg-2">{collaboratorIds.size === 0 ? "No collaborating teams." : `${collaboratorIds.size} collaborating team${collaboratorIds.size === 1 ? "" : "s"}.`}</p>
              )}
            </div>
          </Card>
          <Card className="px-5 py-4">
            <p className="t-caption text-fg-3">Access</p>
            <p className="t-small mt-1.5 text-fg-2">
              {canManage
                ? "You can manage this project as an organization owner or admin."
                : "You can work on tasks assigned to you; planning and assignment are done by owners and admins."}
            </p>
          </Card>
        </aside>
      </div>
    </PageBody>
  );
}

function RepoFact({ label: title, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border px-5 py-3 [&:not(:last-child)]:border-r max-sm:[&:nth-child(2)]:border-r-0 max-sm:[&:nth-child(-n+2)]:border-b">
      <p className="t-caption text-fg-3">{title}</p>
      <p className="t-small mt-1 truncate text-fg">{value}</p>
    </div>
  );
}

function EngineeringCard({
  href,
  icon,
  title,
  description,
  stat,
  statLabel,
  badge,
  footer,
  cta,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  stat?: number;
  statLabel?: string;
  badge?: React.ReactNode;
  footer: string;
  cta: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-xl border border-border bg-surface p-5 shadow-1 transition-[border-color,background-color,transform] duration-150 hover:-translate-y-px hover:border-border-strong hover:bg-surface-2"
    >
      <div className="flex items-start justify-between gap-3">
        <IconTile>{icon}</IconTile>
        {badge}
      </div>
      <p className="t-h3 mt-4 text-fg">{title}</p>
      <p className="t-small mt-0.5 truncate text-fg-3">{description}</p>
      {stat !== undefined && (
        <p className="mt-4 flex items-baseline gap-1.5">
          <span className="text-[24px] font-semibold leading-none tracking-tight text-fg tabular-nums">{stat}</span>
          <span className="t-small text-fg-3">{statLabel}</span>
        </p>
      )}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
        <span className="t-small truncate text-fg-3">{footer}</span>
        <span className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-fg-2 transition-colors group-hover:text-accent">
          {cta} <IconArrowRight size={13} />
        </span>
      </div>
    </Link>
  );
}
