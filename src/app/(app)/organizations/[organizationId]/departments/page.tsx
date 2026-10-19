import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { CardLink, IconTile } from "@/components/ui/card";
import { EmptyState, MetricCard, Stat } from "@/components/ui/data";
import { IconArrowRight, IconLayers, IconPlus, IconUsers } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status";
import { requireUser } from "@/server/auth/session";
import { can } from "@/lib/authz/permissions";
import { idSchema } from "@/server/departments/schema";
import { listDepartments } from "@/server/departments/queries";
import { getMyOrganization } from "@/server/organizations/queries";

export const metadata = { title: "Departments · OneForAll" };

export default async function DepartmentsPage({ params }: PageProps<"/organizations/[organizationId]/departments">) {
  const { organizationId } = await params;
  if (!idSchema.safeParse(organizationId).success) notFound();

  const user = await requireUser();
  const organization = await getMyOrganization(organizationId, user.id);
  if (!organization) notFound();

  const departments = await listDepartments(organization.id);
  // UI hint only. The database enforces who may actually create departments.
  const canManage = can(organization.role, "hierarchy.manage");
  const newHref = `/organizations/${organization.id}/departments/new`;
  const members = departments.reduce((sum, d) => sum + d.memberCount, 0);

  return (
    <PageBody>
      <PageHeader
        crumbs={[{ label: "Organizations", href: "/organizations/new" }, { label: organization.name }, { label: "Departments" }]}
        icon={<IconLayers size={18} />}
        title="Departments"
        description={`Organize engineering teams and ownership across ${organization.name}.`}
        badges={<StatusBadge kind="role" value={organization.role} label={`Your role: ${organization.role.charAt(0)}${organization.role.slice(1).toLowerCase()}`} />}
        actions={
          <>
            <ButtonLink href={`/organizations/${organization.id}/members`} variant="secondary">
              <IconUsers size={15} />
              Members
            </ButtonLink>
            <ButtonLink href={`/organizations/${organization.id}/workforce`} variant="secondary">
              Workforce
            </ButtonLink>
            {canManage && (
              <ButtonLink href={newHref} variant="primary">
                <IconPlus size={15} />
                New department
              </ButtonLink>
            )}
          </>
        }
      />

      {departments.length > 0 && (
        <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Departments" value={departments.length} icon={<IconLayers size={15} />} />
          <MetricCard label="Department members" value={members} icon={<IconUsers size={15} />} hint="Summed across departments" />
        </div>
      )}

      {departments.length === 0 ? (
        <EmptyState
          icon={<IconLayers size={20} />}
          title="No departments yet"
          description="Departments help organize teams and ownership within your organization, such as Engineering, Platform or Data."
          action={
            canManage ? (
              <ButtonLink href={newHref} variant="primary">
                <IconPlus size={15} />
                Create department
              </ButtonLink>
            ) : (
              <p className="t-small text-fg-3">An owner or admin can create the first department.</p>
            )
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {departments.map((department) => (
            <CardLink
              key={department.id}
              href={`/organizations/${organization.id}/departments/${department.id}/teams`}
              className="flex flex-col p-5"
            >
              <div className="flex items-start gap-3">
                <IconTile>
                  <IconLayers size={16} />
                </IconTile>
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold text-fg">{department.name}</p>
                  <p className="truncate font-mono text-[11.5px] text-fg-3">{department.slug}</p>
                </div>
              </div>
              <p className="t-small mt-3 line-clamp-2 min-h-10 text-fg-2">
                {department.description || <span className="text-fg-3">No description</span>}
              </p>
              <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                <Stat icon={<IconUsers size={13} />}>
                  {department.memberCount} {department.memberCount === 1 ? "member" : "members"}
                </Stat>
                <span className="inline-flex items-center gap-1 text-[12.5px] text-fg-2 transition-colors group-hover:text-accent">
                  View teams <IconArrowRight size={13} />
                </span>
              </div>
            </CardLink>
          ))}
        </div>
      )}
    </PageBody>
  );
}
