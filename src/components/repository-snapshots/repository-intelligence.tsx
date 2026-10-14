import Link from "next/link";
import { AnalyzeStructureForm } from "@/components/repository-structure/analyze-structure-form";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, MetricCard, formatDateTime } from "@/components/ui/data";
import {
  IconActivity,
  IconArrowRight,
  IconBranch,
  IconClock,
  IconCode,
  IconCommit,
  IconFileCode,
  IconLink,
  IconNetwork,
  IconPlus,
  IconSymbol,
} from "@/components/ui/icons";
import { SectionHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status";
import { listSnapshots } from "@/server/repository-snapshots/queries";
import { STATUS_LABELS } from "@/server/repository-snapshots/schema";
import { analyzeStructure } from "@/server/repository-structure/actions";
import { getAnalysisForSnapshot } from "@/server/repository-structure/queries";
import { getAnalysisReadiness } from "@/server/repository-structure/readiness";
import { ANALYSIS_STATUS_LABELS } from "@/server/repository-structure/schema";

type Props = {
  organizationId: string;
  departmentId: string;
  teamId: string;
  projectId: string;
  repositoryId: string;
  repositoryPath: string; // .../projects/[projectId]/repository
  canManage: boolean;
};

const PREVIEW_COUNT = 5;

function statusLabel(status: string) {
  return (STATUS_LABELS as Record<string, string>)[status] ?? status;
}

function analysisStatusLabel(status: string) {
  return (ANALYSIS_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

// Snapshot metadata plus the structure-analysis summary of the latest COMPLETED snapshot (counts only: no file
// tree, no code, no symbol browser). RLS limits what is returned to what this user may see.
export async function RepositoryIntelligence({
  organizationId,
  departmentId,
  teamId,
  projectId,
  repositoryId,
  repositoryPath,
  canManage,
}: Props) {
  const snapshots = await listSnapshots(repositoryId);
  const latest = snapshots[0];
  const analyzable = snapshots.find((snapshot) => snapshot.status === "COMPLETED");
  const analysis = analyzable ? await getAnalysisForSnapshot(analyzable.id) : null;
  // PENDING/FAILED analyses can be (re)run; PROCESSING and COMPLETED cannot.
  const canRun = canManage && analyzable && (!analysis || analysis.status === "PENDING" || analysis.status === "FAILED");
  // Never offer an action that is certain to fail (no repository source ingestion / persistence key yet).
  const readiness = getAnalysisReadiness();

  return (
    <section id="intelligence" className="scroll-mt-24">
      <SectionHeader
        icon={<IconNetwork size={16} />}
        title="Repository Intelligence"
        description="Snapshots of the code this project ships, and the structure extracted from them."
        actions={
          <>
            {/* UI hint only. The database enforces who may actually create snapshots. */}
            {canManage && (
              <ButtonLink href={`${repositoryPath}/snapshots/new`} variant="secondary" size="sm">
                <IconPlus size={14} />
                Create snapshot
              </ButtonLink>
            )}
            {latest && (
              <ButtonLink href={`${repositoryPath}/snapshots`} variant="ghost" size="sm">
                {snapshots.length > PREVIEW_COUNT ? `View all ${snapshots.length} snapshots` : "Snapshot list"}
                <IconArrowRight size={13} />
              </ButtonLink>
            )}
          </>
        }
      />

      {!latest ? (
        <EmptyState
          compact
          icon={<IconCommit size={20} />}
          title="No snapshots available"
          description="A snapshot records the repository at a specific commit. Structure analysis runs on completed snapshots."
          action={
            canManage && (
              <ButtonLink href={`${repositoryPath}/snapshots/new`} variant="primary">
                <IconPlus size={15} />
                Create snapshot
              </ButtonLink>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* Latest snapshot */}
          <Card className="overflow-hidden">
            <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-2 text-fg-2">
                  <IconCommit size={16} />
                </span>
                <div className="min-w-0">
                  <p className="t-caption text-fg-3">Latest snapshot</p>
                  <p className="truncate font-mono text-[13px] text-fg" title={latest.commit_sha}>
                    {latest.commit_sha}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge kind="snapshot" value={latest.status} label={statusLabel(latest.status)} />
                <ButtonLink href={`${repositoryPath}/snapshots/${latest.id}`} variant={canManage && (latest.status === "PENDING" || latest.status === "FAILED") ? "primary" : "secondary"} size="sm">
                  {canManage && (latest.status === "PENDING" || latest.status === "FAILED") ? "Upload source" : "Open snapshot"}
                  <IconArrowRight size={13} />
                </ButtonLink>
              </div>
            </div>
            {latest.status === "PENDING" && latest.fileCount === 0 && (
              <p className="t-small border-t border-border px-5 py-2.5 text-fg-3">
                No source recorded yet. Snapshots are not downloaded from GitHub or GitLab; upload a ZIP of this commit to record its files.
              </p>
            )}
            <div className="grid grid-cols-1 border-t border-border sm:grid-cols-3">
              <Fact icon={<IconBranch size={13} />} label="Branch" value={<span className="font-mono">{latest.branch}</span>} />
              <Fact icon={<IconFileCode size={13} />} label="Files recorded" value={<span className="tabular-nums">{latest.fileCount}</span>} />
              <Fact icon={<IconClock size={13} />} label="Created" value={formatDateTime(latest.created_at)} />
            </div>
          </Card>

          {/* Structure analysis */}
          {analyzable ? (
            <Card className="overflow-hidden">
              <CardHeader
                icon={<IconCode size={16} />}
                title="Structure analysis"
                description={
                  <>
                    Snapshot <span className="font-mono text-fg-2">{analyzable.commit_sha.slice(0, 12)}</span>
                  </>
                }
                actions={
                  analysis ? (
                    <StatusBadge kind="analysis" value={analysis.status} label={analysisStatusLabel(analysis.status)} />
                  ) : (
                    <StatusBadge kind="analysis" value="NONE" label="Not analysed" />
                  )
                }
              />
              <div className="flex flex-col gap-4 px-5 py-5">
                {!analysis ? (
                  <p className="t-small text-fg-3">
                    Not analysed yet. Analysis extracts symbols and their relationships from the snapshot’s source files.
                  </p>
                ) : (
                  <>
                    {analysis.status === "COMPLETED" && (
                      <>
                        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                          <MetricCard label="Symbols" value={analysis.symbols_count} icon={<IconSymbol size={15} />} hint="Classes, functions, methods…" />
                          <MetricCard label="Relationships" value={analysis.relationships_count} icon={<IconLink size={15} />} hint="Contains, imports, extends…" />
                          <MetricCard
                            label="Files analysed"
                            value={
                              <>
                                {analysis.files_analyzed}
                                <span className="text-[15px] font-normal text-fg-3"> / {analysis.files_total}</span>
                              </>
                            }
                            icon={<IconFileCode size={15} />}
                          />
                        </div>
                        <Coverage
                          total={analysis.files_total}
                          analyzed={analysis.files_analyzed}
                          unsupported={analysis.files_unsupported}
                          failed={analysis.files_failed}
                        />
                        <div>
                          <ButtonLink href={`${repositoryPath}/snapshots/${analyzable.id}/graph`} variant="primary" size="sm">
                            <IconNetwork size={14} />
                            View Repository Graph
                            <IconArrowRight size={13} />
                          </ButtonLink>
                        </div>
                      </>
                    )}
                    {analysis.status === "PROCESSING" && (
                      <div className="flex items-center gap-2.5 text-[13px] text-info">
                        <IconActivity size={16} />
                        Analysis in progress…
                      </div>
                    )}
                    {analysis.completed_at && (
                      <p className="t-small flex items-center gap-1.5 text-fg-3">
                        <IconClock size={13} />
                        Finished {formatDateTime(analysis.completed_at)}
                      </p>
                    )}
                  </>
                )}
                {analysis?.status === "FAILED" && analysis.error_message && (
                  <Alert tone="danger" title="Analysis failed">
                    {analysis.error_message}
                  </Alert>
                )}
                {/* UI hint only. The database enforces who may actually run an analysis. */}
                {!readiness.ready && (!analysis || analysis.status === "PENDING" || analysis.status === "FAILED") && (
                  <Alert tone="info">
                    {canManage ? (
                      <>
                        Analysis needs the snapshot&apos;s source.{" "}
                        <Link href={`${repositoryPath}/snapshots/${analyzable.id}`} className="underline underline-offset-2 hover:text-fg">
                          Upload its archive to analyse it
                        </Link>
                        .
                      </>
                    ) : (
                      readiness.message
                    )}
                  </Alert>
                )}
                {canRun && readiness.ready && (
                  <div>
                    <AnalyzeStructureForm
                      action={analyzeStructure.bind(null, organizationId, departmentId, teamId, projectId, analyzable.id)}
                      label={analysis?.status === "FAILED" ? "Retry Analysis" : "Analyze Structure"}
                    />
                  </div>
                )}
              </div>
            </Card>
          ) : (
            <EmptyState
              compact
              icon={<IconCode size={20} />}
              title="No structure analysis yet"
              description="Structure analysis becomes available once a snapshot of this repository is completed."
            />
          )}

          {/* Recent snapshots */}
          <Card className="overflow-hidden">
            <CardHeader title="Recent snapshots" description={`${snapshots.length} recorded`} />
            <ul className="divide-y divide-border">
              {snapshots.slice(0, PREVIEW_COUNT).map((snapshot) => (
                <li key={snapshot.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3">
                  <span className="font-mono text-[12.5px] text-fg">{snapshot.commit_sha.slice(0, 12)}</span>
                  <span className="inline-flex items-center gap-1 font-mono text-[12px] text-fg-3">
                    <IconBranch size={12} />
                    {snapshot.branch}
                  </span>
                  <span className="t-small text-fg-3">{formatDateTime(snapshot.created_at)}</span>
                  <span className="ml-auto">
                    <StatusBadge kind="snapshot" value={snapshot.status} label={statusLabel(snapshot.status)} />
                  </span>
                </li>
              ))}
            </ul>
            {snapshots.length > PREVIEW_COUNT && (
              <Link
                href={`${repositoryPath}/snapshots`}
                className="flex items-center justify-center gap-1 border-t border-border py-2.5 text-[12.5px] text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
              >
                View all {snapshots.length} snapshots <IconArrowRight size={13} />
              </Link>
            )}
          </Card>
        </div>
      )}
    </section>
  );
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-border px-5 py-3 sm:block sm:[&:not(:last-child)]:border-r max-sm:[&:not(:last-child)]:border-b">
      <p className="t-caption flex items-center gap-1.5 text-fg-3">
        {icon}
        {label}
      </p>
      <p className="t-small truncate text-fg sm:mt-1">{value}</p>
    </div>
  );
}

// File coverage bar: analysed / unsupported / failed out of the snapshot's files (real counts only).
function Coverage({ total, analyzed, unsupported, failed }: { total: number; analyzed: number; unsupported: number; failed: number }) {
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const segments = [
    { label: "Analysed", value: analyzed, className: "bg-success" },
    { label: "Unsupported", value: unsupported, className: "bg-fg-3" },
    { label: "Failed", value: failed, className: "bg-danger" },
  ];
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="t-caption text-fg-3">File coverage</span>
        <span className="t-small text-fg-3 tabular-nums">{total} files</span>
      </div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-surface-3"
        role="img"
        aria-label={`${analyzed} analysed, ${unsupported} unsupported, ${failed} failed of ${total} files`}
      >
        {segments.map((segment) =>
          segment.value > 0 ? <span key={segment.label} className={segment.className} style={{ width: `${pct(segment.value)}%` }} /> : null,
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1">
        {segments.map((segment) => (
          <span key={segment.label} className="t-small inline-flex items-center gap-1.5 text-fg-3">
            <span className={`size-2 rounded-full ${segment.className}`} />
            {segment.label}
            <span className="text-fg tabular-nums">{segment.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
