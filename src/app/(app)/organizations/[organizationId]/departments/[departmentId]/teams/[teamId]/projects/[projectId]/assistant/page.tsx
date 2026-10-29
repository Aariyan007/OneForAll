import { notFound } from "next/navigation";
import { AssistantPanel } from "@/components/ai/assistant-panel";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/data";
import { IconBranch, IconSparkle } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { getAssistantData } from "@/server/ai/queries";

export const metadata = { title: "AI Assistant · OneForAll" };

const TABS = ["ask", "trace", "review", "generate"] as const;

export default async function AssistantPage({
  params,
  searchParams,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/assistant">) {
  const { organizationId, departmentId, teamId, projectId } = await params;
  const query = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);
  const data = await getAssistantData(organizationId, departmentId, teamId, projectId, one(query.snapshot));
  // 404 for malformed, mismatched, cross-tenant or not-permitted paths alike.
  if (!data) notFound();
  const { organization, department, team, project } = data;
  const projectPath = `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}`;
  const snapshotsHref = `${projectPath}/repository/snapshots`;
  const tab = TABS.find((t) => t === one(query.tab)) ?? "ask";
  const requirement = one(query.requirement);

  return (
    <PageBody>
      <PageHeader
        crumbs={[
          { label: team.name, href: `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects` },
          { label: project.name, href: projectPath },
          { label: "AI Assistant" },
        ]}
        icon={<IconSparkle size={18} />}
        title="AI Assistant"
        description="Ask about the code, trace requirements, review files and draft tests or docs, grounded in a recorded snapshot."
      />
      {!data.repository ? (
        <EmptyState
          icon={<IconBranch size={20} />}
          title="Connect a repository first"
          description="The assistant works on recorded snapshots of this project's repository."
          action={
            <ButtonLink href={`${projectPath}#repository`} variant="primary">
              Go to repository
            </ButtonLink>
          }
        />
      ) : !data.selected ? (
        <EmptyState
          icon={<IconBranch size={20} />}
          title="No snapshot with stored source text"
          description="Upload a ZIP or import a commit on a snapshot. Snapshots recorded before the assistant existed need the same archive uploaded again to store their text."
          action={
            <ButtonLink href={snapshotsHref} variant="primary">
              Open snapshots
            </ButtonLink>
          }
        />
      ) : (
        <AssistantPanel
          projectPath={projectPath}
          snapshotsHref={snapshotsHref}
          snapshots={data.snapshots}
          selectedSnapshotId={data.selected.id}
          files={data.files}
          requirements={data.requirements}
          configured={data.configured}
          providers={data.providers}
          enabled={data.enabled}
          initialTab={tab}
          initialRequirementId={requirement}
          runs={data.runs}
        />
      )}
    </PageBody>
  );
}
