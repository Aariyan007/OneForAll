import { notFound } from "next/navigation";
import {
  AddSkillForm,
  AssignmentModeControl,
  AvailabilityControl,
  DirectoryEntryEditor,
  SkillsEditor,
} from "@/components/workforce/workforce-controls";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Avatar, EmptyState, MetricCard } from "@/components/ui/data";
import { IconActivity, IconSettings, IconSparkle, IconUsers } from "@/components/ui/icons";
import { PageBody, PageHeader, SectionHeader } from "@/components/ui/page";
import { DEFAULT_UNESTIMATED_HOURS } from "@/lib/workforce/assignment";
import { getOrgAccess } from "@/server/authz/access";
import { getAssignmentMode, getWorkload, listDepartmentsWithTeams, listDirectory, listSkills } from "@/server/workforce/queries";

export const metadata = { title: "Workforce · OneForAll" };

function hours(n: number) {
  return Number.isInteger(n) ? `${n} h` : `${n.toFixed(1)} h`;
}

export default async function WorkforcePage({ params }: PageProps<"/organizations/[organizationId]/workforce">) {
  const { organizationId } = await params;
  const access = await getOrgAccess(organizationId);
  if (!access) notFound();
  const { organization, user } = access;
  const manage = access.can("workforce.manage");
  const base = `/organizations/${organization.id}/workforce`;

  const [directory, skills, workload, mode, departments] = await Promise.all([
    listDirectory(organization.id),
    listSkills(organization.id),
    manage ? getWorkload(organization.id) : Promise.resolve(new Map()),
    getAssignmentMode(organization.id),
    manage ? listDepartmentsWithTeams(organization.id) : Promise.resolve([]),
  ]);
  const mine = directory.find((d) => d.userId === user.id) ?? null;
  const members = directory.filter((d) => d.userId);
  const totals = [...workload.values()].reduce((acc, w) => ({ active: acc.active + w.activeTasks, blocked: acc.blocked + w.blocked, overdue: acc.overdue + w.overdue }), { active: 0, blocked: 0, overdue: 0 });

  return (
    <PageBody>
      <PageHeader
        crumbs={[{ label: organization.name, href: `/organizations/${organization.id}/departments` }, { label: "Workforce" }]}
        icon={<IconUsers size={18} />}
        title="Workforce"
        description={manage ? "Directory, skills, availability and workload used for task assignment." : "Your skills and availability, used when work is assigned."}
        actions={
          manage && (
            <>
              <ButtonLink href={`${base}/template`} variant="ghost" prefetch={false}>
                Download template
              </ButtonLink>
              <ButtonLink href={`${base}/export`} variant="secondary" prefetch={false}>
                Export CSV
              </ButtonLink>
              <ButtonLink href={`${base}/import`} variant="primary">
                Import CSV
              </ButtonLink>
            </>
          )
        }
      />

      <div className="flex flex-col gap-8">
        {mine ? (
          <section>
            <Card>
              <CardHeader title="Your profile" description="Owners and admins see this when they assign work. You can change your availability and skills." icon={<IconSparkle size={16} />} />
              <div className="grid gap-5 px-5 py-4 md:grid-cols-[220px_minmax(0,1fr)]">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] text-fg-3">Availability</span>
                  <AvailabilityControl organizationId={organization.id} profileId={mine.id} value={mine.availability} label="Your availability" />
                  <span className="t-small text-fg-3">{[mine.jobTitle, [mine.department, mine.team].filter(Boolean).join(" / ")].filter(Boolean).join(" · ") || "No job title or team recorded."}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] text-fg-3">Skills</span>
                  <SkillsEditor organizationId={organization.id} profileId={mine.id} skills={skills} selected={mine.skills.map((s) => s.id)} label="Your skills" />
                </div>
              </div>
            </Card>
          </section>
        ) : (
          <EmptyState compact icon={<IconUsers size={20} />} title="No directory entry" description="Your directory entry is created when you join. Ask an admin if it is missing." />
        )}

        <section>
          <SectionHeader title="Assignment policy" icon={<IconSettings size={16} />} description="How tasks get an assignee in this organization." />
          <Card className="p-4">
            <AssignmentModeControl organizationId={organization.id} mode={mode} editable={access.can("org.assignmentPolicy.edit")} />
          </Card>
        </section>

        {manage && (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <MetricCard label="Members" value={members.length} icon={<IconUsers size={15} />} hint={`${directory.length - members.length} directory-only entries`} />
              <MetricCard label="Active tasks" value={totals.active} icon={<IconActivity size={15} />} hint="To do, in progress, blocked, in review" />
              <MetricCard label="Blocked" value={totals.blocked} icon={<IconActivity size={15} />} hint="Assigned tasks waiting on something" />
              <MetricCard label="Overdue" value={totals.overdue} icon={<IconActivity size={15} />} hint="Active tasks past their due date" />
            </div>

            <section>
              <SectionHeader
                title={`Directory (${directory.length})`}
                description={`Workload counts active assigned tasks; estimated hours are summed, tasks without an estimate count as ${DEFAULT_UNESTIMATED_HOURS} h when ranking.`}
              />
              {directory.length === 0 ? (
                <EmptyState icon={<IconUsers size={20} />} title="The directory is empty" description="Import a CSV or invite members." />
              ) : (
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-border">
                    {directory.map((d) => {
                      const w = d.userId ? workload.get(d.userId) : undefined;
                      return (
                        <li key={d.id} className="px-5 py-3.5">
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div className="flex min-w-0 items-start gap-3">
                              <Avatar name={d.fullName || d.email} />
                              <div className="min-w-0">
                                <p className="truncate text-[13.5px] font-medium text-fg">
                                  {d.fullName || d.email}{" "}
                                  {!d.userId && <span className="ml-1 rounded border border-border-strong px-1.5 py-0.5 text-[11px] font-normal text-fg-3">not a member</span>}
                                </p>
                                <p className="truncate text-[12.5px] text-fg-3">
                                  {d.email}
                                  {d.employeeCode && <> · {d.employeeCode}</>}
                                  {(d.jobTitle || d.team || d.department) && <> · {[d.jobTitle, [d.department, d.team].filter(Boolean).join(" / ")].filter(Boolean).join(" · ")}</>}
                                </p>
                                <p className="mt-1 flex flex-wrap gap-1">
                                  {d.skills.length === 0 ? (
                                    <span className="text-[12px] text-fg-3">No skills recorded</span>
                                  ) : (
                                    d.skills.map((s) => (
                                      <span key={s.id} className="rounded-full border border-border-strong px-2 py-0.5 text-[11.5px] text-fg-2">
                                        {s.name}
                                      </span>
                                    ))
                                  )}
                                </p>
                              </div>
                            </div>
                            <div className="flex flex-wrap items-start gap-4 lg:justify-end">
                              {w && (
                                <dl className="grid grid-cols-4 gap-3 text-center text-[12px]">
                                  <div><dt className="text-fg-3">Active</dt><dd className="font-medium text-fg">{w.activeTasks}</dd></div>
                                  <div><dt className="text-fg-3">Hours</dt><dd className="font-medium text-fg">{hours(w.activeHours)}</dd></div>
                                  <div><dt className="text-fg-3">Blocked</dt><dd className={w.blocked ? "font-medium text-danger" : "text-fg"}>{w.blocked}</dd></div>
                                  <div><dt className="text-fg-3">Overdue</dt><dd className={w.overdue ? "font-medium text-warning" : "text-fg"}>{w.overdue}</dd></div>
                                </dl>
                              )}
                              <AvailabilityControl organizationId={organization.id} profileId={d.id} value={d.availability} label={`Availability of ${d.fullName || d.email}`} />
                            </div>
                          </div>
                          <details className="mt-2">
                            <summary className="cursor-pointer text-[12.5px] text-fg-3 hover:text-fg">Edit entry and skills</summary>
                            <div className="mt-3 flex flex-col gap-4 rounded-lg border border-border bg-surface-2/40 p-4">
                              <DirectoryEntryEditor organizationId={organization.id} entry={d} departments={departments} />
                              <SkillsEditor organizationId={organization.id} profileId={d.id} skills={skills} selected={d.skills.map((s) => s.id)} label={`Skills of ${d.fullName || d.email}`} />
                            </div>
                          </details>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}
            </section>

            <section>
              <SectionHeader title={`Skill vocabulary (${skills.length})`} description="Skills people can have and tasks can require. Imports add missing skills automatically." />
              <Card className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap gap-1.5">
                  {skills.length === 0 ? (
                    <span className="t-small text-fg-3">No skills yet.</span>
                  ) : (
                    skills.map((s) => (
                      <span key={s.id} className="rounded-full border border-border-strong px-2.5 py-0.5 text-[12px] text-fg-2">
                        {s.name}
                      </span>
                    ))
                  )}
                </div>
                <AddSkillForm organizationId={organization.id} />
              </Card>
            </section>
          </>
        )}
      </div>
    </PageBody>
  );
}
