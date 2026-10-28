import { notFound } from "next/navigation";
import { ProjectGraphViewer } from "@/components/project-graph/project-graph-viewer";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState, MetricCard } from "@/components/ui/data";
import { IconArrowLeft, IconBranch, IconCode, IconCommit, IconFileCode, IconFolder, IconLink, IconNetwork, IconSymbol } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { loadProjectGraph } from "@/server/repository-graph/project";

export const metadata = { title: "Project graph · OneForAll" };

export default async function ProjectGraphPage({
  params,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/repository/snapshots/[snapshotId]/project-graph">) {
  const { organizationId, departmentId, teamId, projectId, snapshotId } = await params;
  const result = await loadProjectGraph(organizationId, departmentId, teamId, projectId, snapshotId);
  // 404 for malformed, mismatched, cross-tenant and not-permitted paths alike.
  if (!result) notFound();
  const { access, data } = result;
  const { organization, department, team, project } = access.context;
  const projectPath = `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}`;
  const snapshotPath = `${projectPath}/repository/snapshots/${data.snapshot.id}`;
  const { counts } = data;
  const completed = data.snapshot.status === "COMPLETED";

  return (
    <PageBody>
      <PageHeader
        crumbs={[
          { label: project.name, href: projectPath },
          { label: "Snapshots", href: `${projectPath}/repository/snapshots` },
          { label: data.snapshot.commit.slice(0, 12) },
        ]}
        icon={<IconNetwork size={18} />}
        title="Project graph"
        description="The whole imported project: directories, files, the imports between files and the symbols found in them. Everything shown is read from what was actually imported and parsed."
        badges={
          <>
            <Badge tone="neutral">
              <IconBranch size={12} />
              {data.repository.owner} / {data.repository.name}
            </Badge>
            {data.snapshot.branch && (
              <Badge tone="neutral">
                <span className="font-mono">{data.snapshot.branch}</span>
              </Badge>
            )}
            <Badge tone="neutral">
              <IconCommit size={12} />
              <span className="font-mono" title={data.snapshot.commit}>{data.snapshot.commit.slice(0, 12)}</span>
            </Badge>
          </>
        }
        actions={
          <>
            <ButtonLink href={`${snapshotPath}/graph`} variant="secondary">
              <IconSymbol size={15} />
              Symbol graph
            </ButtonLink>
            <ButtonLink href={`${projectPath}#intelligence`} variant="secondary">
              <IconArrowLeft size={15} />
              Repository Intelligence
            </ButtonLink>
          </>
        }
      />

      {!completed ? (
        <EmptyState
          icon={<IconCode size={20} />}
          title="This import is not completed"
          description={`Status: ${data.snapshot.status}. The project graph is built once the import has finished.`}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
            <MetricCard label="Files" value={counts.files} icon={<IconFileCode size={15} />} hint={`${counts.parsedFiles} parsed · ${counts.unsupportedFiles} no parser`} />
            <MetricCard label="Directories" value={counts.directories} icon={<IconFolder size={15} />} />
            <MetricCard label="Symbols" value={counts.symbols} icon={<IconSymbol size={15} />} />
            <MetricCard label="Import links" value={counts.importEdges} icon={<IconLink size={15} />} hint="file → file" />
            <MetricCard label="Graph nodes" value={counts.nodes} icon={<IconNetwork size={15} />} />
            <MetricCard label="Graph edges" value={counts.edges} icon={<IconNetwork size={15} />} />
          </div>
          {counts.failedFiles > 0 && (
            <Alert tone="warning" title="Some files could not be parsed">
              {counts.failedFiles} file(s) failed structure analysis. They still appear as files; their symbols are missing.
            </Alert>
          )}
          {data.analysis.status !== "COMPLETED" && (
            <Alert tone="info" title="Structure analysis not completed">
              Directories, files and imports are shown. Symbols appear once the structure analysis of this snapshot has completed.
            </Alert>
          )}
          {counts.files === 0 ? (
            <EmptyState icon={<IconFileCode size={20} />} title="No files" description="The import contains no files." />
          ) : (
            <ProjectGraphViewer
              key={data.snapshot.id}
              data={data}
              dataUrl={`${snapshotPath}/project-graph/data`}
              filesUrl={`${snapshotPath}/files`}
              canRebuild={organization.role === "OWNER" || organization.role === "ADMIN"}
            />
          )}
        </div>
      )}
    </PageBody>
  );
}
