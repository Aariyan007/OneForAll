import { notFound } from "next/navigation";
import { RepositoryGraphExplorer } from "@/components/repository-graph/repository-graph-explorer";
import { RepositoryGraphWorkspace } from "@/components/repository-graph/repository-graph-workspace";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState, MetricCard } from "@/components/ui/data";
import { IconArrowLeft, IconBranch, IconCode, IconCommit, IconFileCode, IconLink, IconNetwork, IconSymbol } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status";
import { getSnapshotGraph, GRAPH_MAX_RELATIONSHIPS, GRAPH_MAX_SYMBOLS } from "@/server/repository-graph/queries";
import { ANALYSIS_STATUS_LABELS } from "@/server/repository-structure/schema";

export const metadata = { title: "Repository graph · OneForAll" };

export default async function RepositoryGraphPage({
  params,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/repository/snapshots/[snapshotId]/graph">) {
  const { organizationId, departmentId, teamId, projectId, snapshotId } = await params;
  const result = await getSnapshotGraph(organizationId, departmentId, teamId, projectId, snapshotId);
  // 404 for malformed, mismatched, cross-tenant, not-permitted paths and snapshots of other repositories alike.
  if (!result) notFound();
  const { organization, department, team, project, repository, snapshot } = result;

  const projectPath = `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}`;
  const snapshotsHref = `${projectPath}/repository/snapshots`;

  return (
    <PageBody>
      <PageHeader
        crumbs={[
          { label: project.name, href: projectPath },
          { label: "Repository Intelligence", href: `${projectPath}#intelligence` },
          { label: "Snapshots", href: snapshotsHref },
          { label: snapshot.commit_sha.slice(0, 12) },
        ]}
        icon={<IconNetwork size={18} />}
        title="Repository Graph"
        description="Symbols and structural relationships stored by the structure analysis of this snapshot. Read-only: nothing here is inferred or generated."
        badges={
          <>
            <Badge tone="neutral">
              <IconBranch size={12} />
              {repository.owner} / {repository.name}
            </Badge>
            <Badge tone="neutral">
              <span className="font-mono">{snapshot.branch}</span>
            </Badge>
            <Badge tone="neutral">
              <IconCommit size={12} />
              <span className="font-mono" title={snapshot.commit_sha}>
                {snapshot.commit_sha.slice(0, 12)}
              </span>
            </Badge>
          </>
        }
        actions={
          <ButtonLink href={`${projectPath}#intelligence`} variant="secondary">
            <IconArrowLeft size={15} />
            Repository Intelligence
          </ButtonLink>
        }
      />

      {result.state === "no-analysis" && (
        <EmptyState
          icon={<IconCode size={20} />}
          title="No structure analysis for this snapshot"
          description="The graph is built only from a completed structure analysis. This snapshot has not been analysed, so there is nothing to draw."
          action={
            <ButtonLink href={`${projectPath}#intelligence`} variant="secondary">
              Back to Repository Intelligence
            </ButtonLink>
          }
        />
      )}

      {result.state === "not-completed" && (
        <EmptyState
          icon={<IconCode size={20} />}
          title="The structure analysis is not completed"
          description={
            <>
              Status: <StatusBadge kind="analysis" value={result.analysis.status} label={ANALYSIS_STATUS_LABELS[result.analysis.status as keyof typeof ANALYSIS_STATUS_LABELS] ?? result.analysis.status} />
              <span className="mt-2 block">Only a completed analysis is shown as repository structure.</span>
            </>
          }
        />
      )}

      {result.state === "explore" && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Symbols" value={result.analysis.symbols_count} icon={<IconSymbol size={15} />} />
            <MetricCard label="Relationships" value={result.analysis.relationships_count} icon={<IconLink size={15} />} />
            <MetricCard label="Files represented" value={result.overview.files.length} icon={<IconFileCode size={15} />} hint={`of ${result.analysis.files_total} in the snapshot`} />
            <MetricCard
              label="Files analysed"
              value={
                <>
                  {result.analysis.files_analyzed}
                  <span className="text-[15px] font-normal text-fg-3"> / {result.analysis.files_total}</span>
                </>
              }
              icon={<IconCode size={15} />}
            />
          </div>
          <Alert tone="info" title="Large analysis: explored in parts">
            More than {GRAPH_MAX_SYMBOLS} symbols or {GRAPH_MAX_RELATIONSHIPS} relationships are too many to draw as one graph. Start from the overview,
            open a file or search for a symbol; each view says what it contains and what it does not.
          </Alert>
          <RepositoryGraphWorkspace
            key={result.analysis.id}
            overview={result.overview}
            dataUrl={`${snapshotsHref}/${snapshot.id}/graph/data`}
            meta={{ analysisId: result.analysis.id, snapshotId: snapshot.id, commitSha: snapshot.commit_sha, branch: snapshot.branch }}
            totals={{ symbols: result.analysis.symbols_count, relationships: result.analysis.relationships_count }}
          />
        </div>
      )}

      {result.state === "ready" && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Symbols" value={result.graph.summary.totalNodes} icon={<IconSymbol size={15} />} />
            <MetricCard label="Relationships" value={result.graph.summary.totalEdges} icon={<IconLink size={15} />} />
            <MetricCard label="Files represented" value={result.graph.summary.filesRepresented} icon={<IconFileCode size={15} />} hint={`of ${result.analysis.files_total} in the snapshot`} />
            <MetricCard
              label="Files analysed"
              value={
                <>
                  {result.analysis.files_analyzed}
                  <span className="text-[15px] font-normal text-fg-3"> / {result.analysis.files_total}</span>
                </>
              }
              icon={<IconCode size={15} />}
            />
          </div>

          {!result.complete && (
            <Alert tone="warning" title="The graph may be incomplete">
              The analysis records {result.analysis.symbols_count} symbols and {result.analysis.relationships_count} relationships, but{" "}
              {result.graph.summary.totalNodes} symbols and {result.graph.summary.totalEdges} relationships could be shown
              {result.graph.diagnostics.rejectedNodes + result.graph.diagnostics.rejectedEdges > 0 &&
                ` (${result.graph.diagnostics.rejectedNodes} symbol and ${result.graph.diagnostics.rejectedEdges} relationship records failed validation)`}
              .
            </Alert>
          )}

          {result.graph.summary.totalNodes === 0 ? (
            <EmptyState
              icon={<IconSymbol size={20} />}
              title="No symbols were extracted"
              description="The analysis completed, but no supported source file produced symbols. This is the real result of the analysis, not an error."
            />
          ) : (
            <>
              <p className="t-small text-fg-2" data-graph-mode="complete">
                <span className="font-medium text-fg">Complete graph.</span> Every stored symbol and relationship of this analysis is loaded; filters and
                focus only change what is drawn.
              </p>
              <RepositoryGraphExplorer key={result.graph.analysisId} graph={result.graph} />
            </>
          )}
        </div>
      )}
    </PageBody>
  );
}
