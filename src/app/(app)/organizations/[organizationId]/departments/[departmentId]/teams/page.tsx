import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { CardLink } from "@/components/ui/card";
import { Avatar, EmptyState, MetricCard, Stat } from "@/components/ui/data";
import { IconArrowRight, IconLayers, IconPlus, IconUsers } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { requireUser } from "@/server/auth/session";
import { can } from "@/lib/authz/permissions";
import { idSchema } from "@/server/departments/schema";
import { listDepartments } from "@/server/departments/queries";
import { getMyOrganization } from "@/server/organizations/queries";
import { getMyDepartment, listTeams } from "@/server/teams/queries";

export const metadata = { title: "Teams · OneForAll" };

export default async function TeamsPage({
  params,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams">) {
  const { organizationId, departmentId } = await params;
  if (!idSchema.safeParse(organizationId).success || !idSchema.safeParse(departmentId).success) notFound();

  const user = await requireUser();
  const organization = await getMyOrganization(organizationId, user.id);
  if (!organization) notFound();
  // Also proves the department belongs to this organization, not just to some tenant the caller can see.
  const department = await getMyDepartment(organization.id, departmentId);
  if (!department) notFound();

  const [teams, departments] = await Promise.all([listTeams(department.id), listDepartments(organization.id)]);
  // Presentation only: the department's description and member count from the existing list query.
  const details = departments.find((d) => d.id === department.id);
  // UI hint only. The database enforces who may actually create teams.
  const canManage = can(organization.role, "hierarchy.manage");
  const deptsHref = `/organizations/${organization.id}/departments`;
  const newHref = `${deptsHref}/${department.id}/teams/new`;

  return (
    <PageBody>
      <PageHeader
        crumbs={[
          { label: organization.name, href: deptsHref },
          { label: "Departments", href: deptsHref },
          { label: department.name },
          { label: "Teams" },
        ]}
        icon={<IconLayers size={18} />}
        title={department.name}
        description={details?.description || "Teams in this department and the projects they own."}
        actions={
          canManage && (
            <ButtonLink href={newHref} variant="primary">
              <IconPlus size={15} />
              New team
            </ButtonLink>
          )
        }
      />

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Teams" value={teams.length} icon={<IconUsers size={15} />} />
        {details && <MetricCard label="Department members" value={details.memberCount} icon={<IconUsers size={15} />} />}
      </div>

      {teams.length === 0 ? (
        <EmptyState
          icon={<IconUsers size={20} />}
          title="No teams yet"
          description="Teams are the people who build and own projects. Create a team to start adding projects."
          action={
            canManage ? (
              <ButtonLink href={newHref} variant="primary">
                <IconPlus size={15} />
                Create team
              </ButtonLink>
            ) : (
              <p className="t-small text-fg-3">An owner or admin can create the first team.</p>
            )
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {teams.map((team) => (
            <CardLink key={team.id} href={`${deptsHref}/${department.id}/teams/${team.id}/projects`} className="flex flex-col p-5">
              <div className="flex items-start gap-3">
                <Avatar name={team.name} square />
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold text-fg">{team.name}</p>
                  <p className="truncate font-mono text-[11.5px] text-fg-3">{team.slug}</p>
                </div>
              </div>
              <p className="t-small mt-3 line-clamp-2 min-h-10 text-fg-2">
                {team.description || <span className="text-fg-3">No description</span>}
              </p>
              <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                <Stat icon={<IconUsers size={13} />}>
                  {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
                </Stat>
                <span className="inline-flex items-center gap-1 text-[12.5px] text-fg-2 transition-colors group-hover:text-accent">
                  View projects <IconArrowRight size={13} />
                </span>
              </div>
            </CardLink>
          ))}
        </div>
      )}
    </PageBody>
  );
}
