import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/ui/data";
import { IconFolder } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { cx } from "@/lib/cx";
import { createClient } from "@/lib/supabase/server";
import { idSchema } from "@/server/departments/schema";
import { getRepositoryContext } from "@/server/repository-snapshots/queries";

export const metadata = { title: "Source · OneForAll" };

// Read-only view of one stored file of a snapshot, with line numbers; ?from=&to= highlights the lines an AI answer
// cited. Everything is read as the signed-in user (RLS), and the text is rendered as plain text nodes.

const MAX_PATH = 1024;

export default async function SnapshotFilePage({
  params,
  searchParams,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/repository/snapshots/[snapshotId]/files">) {
  const { organizationId, departmentId, teamId, projectId, snapshotId } = await params;
  const query = await searchParams;
  const path = typeof query.path === "string" ? query.path.slice(0, MAX_PATH) : "";
  const from = Number(typeof query.from === "string" ? query.from : NaN);
  const to = Number(typeof query.to === "string" ? query.to : NaN);
  if (!idSchema.safeParse(snapshotId).success) notFound();
  const context = await getRepositoryContext(organizationId, departmentId, teamId, projectId);
  if (!context) notFound();
  const supabase = await createClient();
  const { data: snapshot } = await supabase
    .from("repository_snapshots")
    .select("id, commit_sha")
    .eq("id", snapshotId)
    .eq("repository_id", context.repository.id)
    .maybeSingle();
  if (!snapshot) notFound();

  const { data: file } = path
    ? await supabase.from("repository_files").select("id, path, language, size_bytes").eq("snapshot_id", snapshot.id).eq("path", path).maybeSingle()
    : { data: null };
  const { data: content } = file
    ? await supabase.from("repository_file_contents").select("content").eq("file_id", file.id).maybeSingle()
    : { data: null };

  const projectPath = `/organizations/${organizationId}/departments/${departmentId}/teams/${teamId}/projects/${projectId}`;
  const snapshotHref = `${projectPath}/repository/snapshots/${snapshot.id}`;
  const lines = content ? content.content.replace(/\n$/, "").split("\n") : [];
  const highlighted = (n: number) => Number.isInteger(from) && Number.isInteger(to) && n >= from && n <= to;

  return (
    <PageBody>
      <PageHeader
        crumbs={[
          { label: context.project.name, href: projectPath },
          { label: `Snapshot ${snapshot.commit_sha.slice(0, 12)}`, href: snapshotHref },
          { label: "Source" },
        ]}
        icon={<IconFolder size={18} />}
        title={path || "Source"}
        description={file ? `${file.language ?? "Text"} · ${lines.length} lines · read-only` : undefined}
      />
      {!file || !content ? (
        <EmptyState
          icon={<IconFolder size={20} />}
          title="File not available"
          description="This path is not in the snapshot, or its text is not stored (binary, too large, or recorded before text was kept)."
          action={
            <Link href={snapshotHref} className="text-[13px] text-accent hover:underline">
              Back to the snapshot
            </Link>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-bg-subtle">
          <table className="w-full border-collapse font-mono text-[12.5px] leading-5">
            <tbody>
              {lines.map((line, i) => {
                const n = i + 1;
                return (
                  <tr key={n} id={`L${n}`} className={cx(highlighted(n) && "bg-accent/15")}>
                    <td className="w-12 select-none border-r border-border px-3 text-right align-top text-fg-3">{n}</td>
                    <td className="whitespace-pre px-3 text-fg">{line.replace(/\r$/, "")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </PageBody>
  );
}
