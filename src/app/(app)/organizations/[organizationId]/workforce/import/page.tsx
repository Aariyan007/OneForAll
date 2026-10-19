import { notFound } from "next/navigation";
import { DirectoryImport, StructureImport } from "@/components/workforce/workforce-controls";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { IconUsers } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { DIRECTORY_COLUMNS } from "@/lib/workforce/csv";
import { STRUCTURE_COLUMNS } from "@/lib/workforce/structure-csv";
import { getOrgAccess } from "@/server/authz/access";

export const metadata = { title: "Import workforce · OneForAll" };

export default async function WorkforceImportPage({ params }: PageProps<"/organizations/[organizationId]/workforce/import">) {
  const { organizationId } = await params;
  const access = await getOrgAccess(organizationId);
  if (!access || !access.can("workforce.import")) notFound();
  const base = `/organizations/${access.organization.id}/workforce`;

  return (
    <PageBody width="narrow">
      <PageHeader
        crumbs={[
          { label: access.organization.name, href: `/organizations/${access.organization.id}/departments` },
          { label: "Workforce", href: base },
          { label: "Import" },
        ]}
        icon={<IconUsers size={18} />}
        title="Import the workforce directory"
        description="Upload a CSV, review what would change, then confirm. Nothing is written before you confirm."
        actions={
          <ButtonLink href={`${base}/template`} variant="secondary" prefetch={false}>
            Download template
          </ButtonLink>
        }
      />
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader title="Rules" />
          <ul className="t-small flex list-disc flex-col gap-1.5 px-9 py-4 text-fg-2">
            <li>
              Columns: <span className="font-mono text-fg">{DIRECTORY_COLUMNS.join(", ")}</span>. Only <span className="font-mono">email</span> is required.
            </li>
            <li>People are matched by email. Empty cells keep current values; skills (separated by ;) are added, never removed.</li>
            <li>Departments and teams are matched by name in this organization. A team name used in several departments needs the department.</li>
            <li>Availability: AVAILABLE, BUSY or UNAVAILABLE.</li>
            <li>The import creates no accounts, invitations or roles; role, password or token columns make the file invalid.</li>
            <li>For people who are already members, the home team also grants access to that team&apos;s projects.</li>
          </ul>
        </Card>
        <Card className="p-5">
          <DirectoryImport organizationId={access.organization.id} />
        </Card>
        {access.can("structure.import") && (
          <section id="structure" aria-labelledby="structure-heading" className="flex flex-col gap-3 scroll-mt-24">
            <Card>
              <CardHeader
                title={<span id="structure-heading">Departments and teams</span>}
                description="Create the organization structure first, then import the employee directory that refers to it."
                actions={
                  <span className="flex flex-wrap gap-2">
                    <ButtonLink href={`${base}/template?kind=departments`} variant="secondary" size="sm" prefetch={false}>
                      Departments template
                    </ButtonLink>
                    <ButtonLink href={`${base}/template?kind=teams`} variant="secondary" size="sm" prefetch={false}>
                      Teams template
                    </ButtonLink>
                  </span>
                }
              />
              <ul className="t-small flex list-disc flex-col gap-1.5 px-9 py-4 text-fg-2">
                <li>
                  Departments: <span className="font-mono text-fg">{STRUCTURE_COLUMNS.DEPARTMENTS.join(", ")}</span>. Teams:{" "}
                  <span className="font-mono text-fg">{STRUCTURE_COLUMNS.TEAMS.join(", ")}</span>.
                </li>
                <li>Names are matched case-insensitively; existing entries are kept (a non-empty description updates theirs).</li>
                <li>A team&apos;s department must already exist. Nobody is added to a department or team by this import.</li>
              </ul>
            </Card>
            <Card className="p-5">
              <StructureImport organizationId={access.organization.id} />
            </Card>
          </section>
        )}
      </div>
    </PageBody>
  );
}
