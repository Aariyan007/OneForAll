import { notFound } from "next/navigation";
import { MarkFailedForm, SourceUploadForm } from "@/components/repository-sources/source-upload-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { KeyValueList, MetricCard, formatDateTime } from "@/components/ui/data";
import { IconArrowRight, IconBranch, IconClock, IconCode, IconCommit, IconFileCode, IconLink, IconLock, IconNetwork, IconSymbol } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status";
import { formatBytes } from "@/lib/repository-sources/upload";
import { markStaleSnapshotFailed } from "@/server/repository-sources/actions";
import { ARCHIVE_LIMITS, STALE_PROCESSING_MILLIS } from "@/server/repository-sources/limits";
import { getSnapshotDetail } from "@/server/repository-sources/queries";
import { STATUS_LABELS } from "@/server/repository-snapshots/schema";
import { MAX_SOURCE_BYTES } from "@/server/repository-structure/limits";
import { ANALYSIS_STATUS_LABELS } from "@/server/repository-structure/schema";

export const metadata = { title: "Snapshot · OneForAll" };

function isStale(startedAt: string | null) {
  return startedAt !== null && Date.now() - Date.parse(startedAt) >= STALE_PROCESSING_MILLIS;
}

const UPLOAD_HINT = `ZIP only, for example "Download ZIP" from your Git host or \`git archive --format=zip\`. The archive is processed in memory and not kept. Files over ${formatBytes(ARCHIVE_LIMITS.maxFileBytes)} are not recorded; node_modules, .git, dist, build, .next and coverage are not recorded. Every exclusion is counted and shown after the upload.`;

function snapshotLabel(status: string) {
  return (STATUS_LABELS as Record<string, string>)[status] ?? status;
}
function analysisLabel(status: string) {
  return (ANALYSIS_STATUS_LABELS as Record<string, string>)[status] ?? status;
}
// A count that was not recorded is shown as unavailable, never as zero.
function count(value: number | null | undefined) {
  return value === null || value === undefined ? <span className="text-fg-3">Not recorded</span> : <span className="tabular-nums">{value}</span>;
}

export default async function SnapshotPage({
  params,
  searchParams,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/repository/snapshots/[snapshotId]">) {
  const { organizationId, departmentId, teamId, projectId, snapshotId } = await params;
  // Set only by the upload route's redirect for a plain (no-JavaScript) form post whose archive was rejected.
  const uploadRejected = (await searchParams).upload === "rejected";
  const detail = await getSnapshotDetail(organizationId, departmentId, teamId, projectId, snapshotId);
  // 404 for malformed, mismatched, cross-tenant, not-permitted paths and snapshots of other repositories alike.
  if (!detail) notFound();
  const { organization, department, team, project, repository, snapshot, source, manifestFiles, supportedFiles, analysis, canManage } = detail;

  const projectPath = `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}`;
  const snapshotsHref = `${projectPath}/repository/snapshots`;
  const graphHref = `${snapshotsHref}/${snapshot.id}/graph`;
  const projectGraphHref = `${snapshotsHref}/${snapshot.id}/project-graph`;
  // Uploads go to the snapshot's upload Route Handler. The ids in that URL and in the bound action below are only
  // targets: both re-verify the whole chain from the database.
  const uploadUrl = `${snapshotsHref}/${snapshot.id}/source`;
  const markFailed = markStaleSnapshotFailed.bind(null, organization.id, department.id, team.id, project.id, snapshot.id);

  const completed = snapshot.status === "COMPLETED";
  const graphReady = completed && analysis?.status === "COMPLETED";
  const analysable = completed && (!analysis || analysis.status === "PENDING" || analysis.status === "FAILED");
  const needsSource = snapshot.status === "PENDING" || snapshot.status === "FAILED";
  const shortSha = snapshot.commit_sha.slice(0, 12);

  const uploadForm = (label: string, hint = UPLOAD_HINT) =>
    canManage ? (
      <SourceUploadForm uploadUrl={uploadUrl} label={label} maxBytes={ARCHIVE_LIMITS.maxUploadBytes} hint={hint} />
    ) : (
      <p className="t-small flex items-center gap-1.5 text-fg-3">
        <IconLock size={13} />
        Only organization owners and admins can upload source.
      </p>
    );

  return (
    <PageBody>
      <PageHeader
        crumbs={[
          { label: project.name, href: projectPath },
          { label: "Repository Intelligence", href: `${projectPath}#intelligence` },
          { label: "Snapshots", href: snapshotsHref },
          { label: shortSha },
        ]}
        icon={<IconCommit size={18} />}
        title={`Snapshot ${shortSha}`}
        description={`${repository.owner} / ${repository.name}`}
        badges={
          <>
            <span className="t-small text-fg-3">Snapshot</span>
            <StatusBadge kind="snapshot" value={snapshot.status} label={snapshotLabel(snapshot.status)} />
            <span className="t-small ml-1.5 text-fg-3">Analysis</span>
            {analysis ? (
              <StatusBadge kind="analysis" value={analysis.status} label={analysisLabel(analysis.status)} />
            ) : (
              <StatusBadge kind="analysis" value="NONE" label="Not analysed" />
            )}
          </>
        }
        actions={
          <>
            {completed && (
              <ButtonLink href={projectGraphHref} variant="primary">
                <IconNetwork size={15} />
                View Project Graph
              </ButtonLink>
            )}
            {graphReady && (
              <ButtonLink href={graphHref} variant="secondary">
                <IconNetwork size={15} />
                Symbol graph
              </ButtonLink>
            )}
            <ButtonLink href={snapshotsHref} variant="secondary">
              All snapshots
            </ButtonLink>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* Next step: always the first thing on the page */}
          <Card className="overflow-hidden">
            <CardHeader icon={<IconFileCode size={16} />} title="Source ingestion" description="What this snapshot needs next." />
            <div className="flex flex-col gap-4 px-5 py-4">
              {uploadRejected && (
                <Alert tone="danger" title="The last upload was rejected">
                  Nothing was recorded. Check that the file is a .zip of this commit within the limits below, then try again.
                </Alert>
              )}
              {snapshot.status === "PENDING" && !source && (
                <>
                  <Alert tone="info" title="Upload the source code to continue">
                    This snapshot records branch <span className="font-mono text-fg">{snapshot.branch}</span> and commit{" "}
                    <span className="font-mono text-fg">{shortSha}</span>. Creating it did not fetch any code: OneForAll does not download repositories
                    from GitHub or GitLab. Upload a ZIP of this commit to record its files and analyse its structure.
                  </Alert>
                  {uploadForm("Upload and process")}
                </>
              )}
              {snapshot.status === "PENDING" && source && uploadForm("Upload and process")}
              {snapshot.status === "PROCESSING" && (
                <>
                  <Alert tone="info" title="Processing has not finished">
                    Started {snapshot.started_at ? formatDateTime(snapshot.started_at) : "recently"}. Processing runs inside the upload request and has
                    not completed. If it is still processing after {STALE_PROCESSING_MILLIS / 60000} minutes, the request was interrupted and the
                    snapshot can be marked as failed, then uploaded again.
                  </Alert>
                  {canManage && isStale(snapshot.started_at) && <MarkFailedForm action={markFailed} />}
                </>
              )}
              {snapshot.status === "FAILED" && (
                <>
                  <Alert tone="danger" title="Ingestion failed">
                    {snapshot.error_message ?? "The upload did not complete."} Nothing from the failed attempt is analysed. Upload the archive again to
                    retry; the failed attempt&apos;s files are replaced, not kept.
                  </Alert>
                  {uploadForm("Upload again and retry")}
                </>
              )}
              {graphReady && (
                <Alert tone="success" title="Source recorded and analysed">
                  The Repository Graph shows the structure of the recorded files that were analysed.
                </Alert>
              )}
              {analysable && (
                <>
                  <Alert tone="warning" title={analysis?.status === "FAILED" ? "Structure analysis failed" : "Not analysed yet"}>
                    {analysis?.status === "FAILED" && analysis.error_message ? `${analysis.error_message} ` : ""}
                    The file manifest is recorded and sealed. The archive is not kept, so analysing needs the same archive again: every file must
                    match the recorded manifest exactly.
                  </Alert>
                  {uploadForm(
                    "Upload the same archive to analyse",
                    "Upload the archive this snapshot was recorded from. Files that do not match the recorded hashes are refused.",
                  )}
                </>
              )}
              {graphReady && detail.storedTextFiles === 0 && (
                <>
                  <Alert tone="info" title="Source text is not stored for this snapshot">
                    It was recorded before OneForAll kept the text of files, so the AI assistant cannot read it yet. Upload the same archive again to
                    store the text; nothing else changes.
                  </Alert>
                  {uploadForm(
                    "Upload the same archive to store the text",
                    "Upload the archive this snapshot was recorded from. Files that do not match the recorded hashes are refused.",
                  )}
                </>
              )}
              {completed && analysis?.status === "PROCESSING" && <Alert tone="info">Structure analysis is running.</Alert>}
            </div>
          </Card>

          {/* Ingestion summary: only recorded facts */}
          {source && (
            <Card className="overflow-hidden">
              <CardHeader
                icon={<IconFileCode size={16} />}
                title="Ingestion summary"
                description="Counted when the archive was processed."
                actions={
                  source.verification === "PROVIDER_FETCHED" ? <Badge tone="success">Fetched from GitHub</Badge> : <Badge tone="warning">Unverified upload</Badge>
                }
              />
              <div className="flex flex-col gap-4 px-5 py-4">
                {!completed && (
                  <Alert tone="danger" title="This attempt did not complete">
                    The figures below are from an upload that did not finish. Its files are not a completed snapshot and were not analysed.
                  </Alert>
                )}
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <MetricCard label="Files in archive" value={source.entries_total} />
                  <MetricCard label="Recorded" value={source.files_accepted} tone={completed ? "success" : "default"} hint="in the manifest" />
                  <MetricCard label="Not recorded" value={source.files_skipped} hint="see the breakdown" />
                  <MetricCard label="Parseable" value={supportedFiles} hint="TypeScript, JavaScript, Python, Java" />
                </div>
                <KeyValueList
                  items={[
                    { label: "Over the per-file limit", value: count(source.files_skipped_oversized) },
                    { label: "In generated folders", value: count(source.files_skipped_generated) },
                    { label: "Archive metadata", value: count(source.files_skipped_metadata) },
                    { label: "May contain credentials", value: count(source.files_skipped_sensitive) },
                    { label: "Analysed", value: analysis?.status === "COMPLETED" ? count(analysis.files_analyzed) : <span className="text-fg-3">Unavailable until analysis completes</span> },
                    { label: "Unsupported language", value: analysis?.status === "COMPLETED" ? count(analysis.files_unsupported) : <span className="text-fg-3">Unavailable until analysis completes</span> },
                    { label: "Could not be analysed", value: analysis?.status === "COMPLETED" ? count(analysis.files_failed) : <span className="text-fg-3">Unavailable until analysis completes</span> },
                  ]}
                />
                <p className="t-small text-fg-3">
                  The Repository Graph covers only recorded files that were analysed. Files not recorded (above) and files that could not be analysed
                  (larger than {formatBytes(MAX_SOURCE_BYTES)} for the parser, bytes not matching the manifest, or syntax errors) are not in it.
                </p>
              </div>
            </Card>
          )}

          {/* Reference: what each identifier means */}
          <Card className="overflow-hidden">
            <CardHeader icon={<IconBranch size={16} />} title="Reference" description="What identifies this snapshot, and where its files came from." />
            <div className="px-5 py-4">
              <KeyValueList
                items={[
                  { label: "Repository URL", value: <span className="break-all font-mono text-[12px]">{repository.repository_url}</span> },
                  { label: "Branch", value: <span className="font-mono">{snapshot.branch}</span> },
                  { label: "Commit SHA", value: <span className="break-all font-mono text-[12px]">{snapshot.commit_sha}</span> },
                  { label: "Created", value: formatDateTime(snapshot.created_at) },
                  {
                    label: "Source bytes",
                    value: source
                      ? source.source_kind === "GITHUB_ARCHIVE"
                        ? "Fetched by the server from GitHub for this exact commit"
                        : "Uploaded ZIP archive (unverified)"
                      : manifestFiles > 0
                        ? "Recorded without a source record"
                        : "None uploaded",
                  },
                  ...(source
                    ? [
                        {
                          label: "Commit stated by the archive",
                          value: source.archive_commit
                            ? `${source.archive_commit.slice(0, 12)} (matches${source.source_kind === "GITHUB_ARCHIVE" ? "" : "; self-reported"})`
                            : "Not stated by the archive",
                        },
                        {
                          label: "Archive",
                          value: `${formatBytes(source.archive_bytes)} · ${source.source_kind === "GITHUB_ARCHIVE" ? "fetched" : "uploaded"} ${formatDateTime(source.created_at)}`,
                        },
                        { label: "Archive SHA-256", value: <span className="break-all font-mono text-[12px]">{source.archive_sha256}</span> },
                      ]
                    : []),
                ]}
              />
              <p className="t-small mt-3 text-fg-3">
                {source?.source_kind === "GITHUB_ARCHIVE"
                  ? "The commit was resolved on GitHub and its archive downloaded by the server for exactly that commit (github.com is the authority). Files matching the exclusion rules were not recorded."
                  : "The branch and commit are references entered when the snapshot was created. OneForAll has not checked them against the Git host, and an uploaded archive is not proof that its files are what that commit contains."}
              </p>
            </div>
          </Card>
        </div>

        {/* Analysis */}
        <aside className="flex h-fit flex-col gap-4">
          <Card className="overflow-hidden">
            <CardHeader
              icon={<IconCode size={16} />}
              title="Structure analysis"
              actions={
                analysis ? (
                  <StatusBadge kind="analysis" value={analysis.status} label={analysisLabel(analysis.status)} />
                ) : (
                  <StatusBadge kind="analysis" value="NONE" label="Not analysed" />
                )
              }
            />
            <div className="flex flex-col gap-3 px-5 py-4">
              {!analysis && <p className="t-small text-fg-3">{completed ? "Not analysed yet." : "Runs after the source manifest is recorded."}</p>}
              {analysis?.status === "COMPLETED" && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <MetricCard label="Symbols" value={analysis.symbols_count} icon={<IconSymbol size={14} />} />
                    <MetricCard label="Relationships" value={analysis.relationships_count} icon={<IconLink size={14} />} />
                  </div>
                  <p className="t-small text-fg-3">
                    {analysis.files_analyzed} of {analysis.files_total} recorded files analysed
                  </p>
                </>
              )}
              {analysis?.status === "FAILED" && analysis.error_message && (
                <Alert tone="danger" title="Analysis failed">
                  {analysis.error_message}
                </Alert>
              )}
              {completed && (
                <ButtonLink href={projectGraphHref} variant="primary">
                  <IconNetwork size={15} />
                  View Project Graph
                  <IconArrowRight size={13} />
                </ButtonLink>
              )}
              {graphReady && (
                <ButtonLink href={graphHref} variant="secondary">
                  <IconNetwork size={15} />
                  Symbol graph
                  <IconArrowRight size={13} />
                </ButtonLink>
              )}
              {analysis?.completed_at && (
                <p className="t-small flex items-center gap-1.5 text-fg-3">
                  <IconClock size={13} />
                  Finished {formatDateTime(analysis.completed_at)}
                </p>
              )}
            </div>
          </Card>
          <Card className="px-5 py-4">
            <p className="t-caption text-fg-3">Recorded files</p>
            <p className="mt-1.5 text-[22px] font-semibold tabular-nums text-fg">{manifestFiles}</p>
            <p className="t-small mt-1 text-fg-3">
              {manifestFiles === 0
                ? needsSource
                  ? "No files recorded. This snapshot is not complete."
                  : "No files recorded."
                : !completed
                  ? "From an attempt that did not complete. This snapshot is not complete."
                  : `${supportedFiles} in languages the analyzer parses.`}
            </p>
          </Card>
        </aside>
      </div>
    </PageBody>
  );
}
