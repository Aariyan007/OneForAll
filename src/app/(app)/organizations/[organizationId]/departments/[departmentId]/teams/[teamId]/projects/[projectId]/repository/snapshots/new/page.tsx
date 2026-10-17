import Link from "next/link";
import { notFound } from "next/navigation";
import { CreateSnapshotForm } from "@/components/repository-snapshots/create-snapshot-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { IconCommit } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { createSnapshot } from "@/server/repository-snapshots/actions";
import { getRepositoryContext } from "@/server/repository-snapshots/queries";

export const metadata = { title: "Create snapshot · OneForAll" };

export default async function NewSnapshotPage({
  params,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/repository/snapshots/new">) {
  const { organizationId, departmentId, teamId, projectId } = await params;
  const context = await getRepositoryContext(organizationId, departmentId, teamId, projectId);
  // Only OWNER/ADMIN may create snapshots, so everyone else gets the same 404 as an invalid path.
  // This is a UI gate only; RLS rejects the insert regardless.
  if (!context || !context.canManage) notFound();
  const { organization, department, team, project, repository } = context;
  const projectPath = `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}`;
  const snapshotsHref = `${projectPath}/repository/snapshots`;

  return (
    <PageBody width="form">
      <PageHeader
        crumbs={[
          { label: project.name, href: projectPath },
          { label: "Snapshots", href: snapshotsHref },
          { label: "New" },
        ]}
        title="Create a snapshot"
        description={`Record ${repository.owner} / ${repository.name} at a specific commit.`}
      />
      <div className="flex flex-col gap-4">
        <Alert tone="info">
          This records a reference to a branch and commit and does not download any code; you then upload a ZIP of that commit on the snapshot page. For a
          GitHub repository, the import on the{" "}
          <Link href={`${projectPath}/integrations`} className="underline underline-offset-2">
            Integrations
          </Link>{" "}
          page fetches the exact commit for you instead.
        </Alert>
        <Card>
          <CardHeader icon={<IconCommit size={16} />} title="Snapshot details" />
          <div className="px-5 py-5">
            {/* Bound here, in the Server Component. Never `.bind()` inside the Client Component. */}
            <CreateSnapshotForm
              action={createSnapshot.bind(null, organization.id, department.id, team.id, project.id)}
              cancelHref={snapshotsHref}
            />
          </div>
        </Card>
      </div>
    </PageBody>
  );
}
