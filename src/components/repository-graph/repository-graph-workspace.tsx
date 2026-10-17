"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconArrowRight, IconFileCode, IconFocus, IconLayers, IconNetwork, IconSearch } from "@/components/ui/icons";
import { cx } from "@/lib/cx";
import {
  EMPTY_SUBGRAPH,
  EXPLORE_NODE_CAP,
  SEARCH_LIMIT,
  type Subgraph,
  ancestorsOf,
  buildOverviewTree,
  loadedDegrees,
  mergePiece,
  subgraphAsGraph,
  subgraphStatus,
  visibleTreeRows,
} from "@/lib/repository-graph/explore";
import type { GraphOverview, GraphPiece, GraphSearchResult, RepositoryGraph } from "@/lib/repository-graph/types";
import { RepositoryGraphExplorer } from "./repository-graph-explorer";
import { kindMeta } from "./graph-style";

// Explorer for analyses too large to send whole. The page sends only an overview (files with counts); everything else
// is loaded on demand from the graph data Route Handler in bounded pieces: one file, the neighbours of one symbol, a
// search. Every view states what it is (overview, file view, focused subgraph) and what it has NOT loaded.

type Meta = Pick<RepositoryGraph, "analysisId" | "snapshotId" | "commitSha" | "branch">;

type View =
  | { type: "overview" }
  | { type: "file"; fileId: string; filePath: string }
  | { type: "focus"; rootId: string; rootLabel: string };

type Props = {
  overview: GraphOverview;
  dataUrl: string;
  meta: Meta;
  totals: { symbols: number; relationships: number };
};

const TREE_ROW_STEP = 300; // rows rendered at a time in the overview list

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" }, signal });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || body === null) throw new Error(body?.error ?? "The graph data could not be loaded. Try again.");
  return body;
}

export function RepositoryGraphWorkspace({ overview, dataUrl, meta, totals }: Props) {
  const [view, setView] = useState<View>({ type: "overview" });
  const [subgraph, setSubgraph] = useState<Subgraph>(EMPTY_SUBGRAPH);
  const [loading, setLoading] = useState(false);
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capNotice, setCapNotice] = useState<{ nodeId: string; label: string; wouldHave: number } | null>(null);
  const [viewSeq, setViewSeq] = useState(0); // remounts the explorer for every new view (not for expansions)

  const tree = useMemo(() => buildOverviewTree(overview.files), [overview]);
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [rowLimit, setRowLimit] = useState(TREE_ROW_STEP);
  const rows = useMemo(() => visibleTreeRows(tree, openDirs), [tree, openDirs]);
  const largestFiles = useMemo(() => [...overview.files].sort((a, b) => b.symbols - a.symbols || a.path.localeCompare(b.path)).slice(0, 8), [overview]);
  const externalTotal = tree.totals.externalRelationships;

  const piece = useCallback((params: Record<string, string>) => getJson<GraphPiece>(`${dataUrl}?${new URLSearchParams(params)}`), [dataUrl]);

  const openFile = useCallback(
    async (fileId: string, filePath: string) => {
      setView({ type: "file", fileId, filePath });
      setViewSeq((n) => n + 1);
      setSubgraph(EMPTY_SUBGRAPH);
      setCapNotice(null);
      setError(null);
      setLoading(true);
      try {
        const result = await piece({ op: "file", fileId });
        // A file view holds the whole (bounded) file, even past the expansion cap; the canvas asks to narrow if needed.
        const merged = mergePiece(EMPTY_SUBGRAPH, result, Number.POSITIVE_INFINITY);
        if (merged.ok) setSubgraph(merged.subgraph);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The file could not be loaded.");
      } finally {
        setLoading(false);
      }
    },
    [piece],
  );

  const focusOn = useCallback(
    async (symbolId: string, label: string) => {
      setView({ type: "focus", rootId: symbolId, rootLabel: label });
      setViewSeq((n) => n + 1);
      setSubgraph(EMPTY_SUBGRAPH);
      setCapNotice(null);
      setError(null);
      setLoading(true);
      try {
        const result = await piece({ op: "neighbours", symbolId });
        const merged = mergePiece(EMPTY_SUBGRAPH, result, Number.POSITIVE_INFINITY);
        if (merged.ok) setSubgraph(merged.subgraph);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The symbol could not be loaded.");
      } finally {
        setLoading(false);
      }
    },
    [piece],
  );

  const expand = useCallback(
    async (nodeId: string) => {
      setBusyNodeId(nodeId);
      setCapNotice(null);
      setError(null);
      try {
        const result = await piece({ op: "neighbours", symbolId: nodeId });
        setSubgraph((current) => {
          const merged = mergePiece(current, result, EXPLORE_NODE_CAP);
          if (merged.ok) return merged.subgraph;
          const label = current.nodes.find((node) => node.id === nodeId)?.label ?? "this symbol";
          setCapNotice({ nodeId, label, wouldHave: merged.wouldHave });
          return current;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "The neighbours could not be loaded.");
      } finally {
        setBusyNodeId(null);
      }
    },
    [piece],
  );

  const refocus = useCallback(
    (nodeId: string) => {
      const node = subgraph.nodes.find((n) => n.id === nodeId);
      void focusOn(nodeId, node?.label ?? "symbol");
    },
    [subgraph, focusOn],
  );

  const graph = useMemo(() => subgraphAsGraph(subgraph, meta), [subgraph, meta]);
  const degrees = useMemo(() => loadedDegrees(subgraph), [subgraph]);
  const status = useMemo(() => subgraphStatus(subgraph), [subgraph]);
  const fileCounts = useMemo(() => (view.type === "file" ? overview.files.find((f) => f.fileId === view.fileId) : undefined), [view, overview]);

  const showInOverview = (filePath: string) => {
    setOpenDirs((current) => new Set([...current, ...ancestorsOf(filePath)]));
    setRowLimit(Number.POSITIVE_INFINITY);
    setView({ type: "overview" });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 px-4 py-4 sm:px-5">
        <SymbolSearch dataUrl={dataUrl} onPick={(result) => void focusOn(result.id, result.label)} />
        <nav aria-label="Graph view" className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
          <ViewTab active={view.type === "overview"} onClick={() => setView({ type: "overview" })}>
            <IconLayers size={13} />
            Overview
          </ViewTab>
          {view.type === "file" && (
            <ViewTab active>
              <IconFileCode size={13} />
              <span className="max-w-72 truncate font-mono">{view.filePath}</span>
            </ViewTab>
          )}
          {view.type === "focus" && (
            <ViewTab active>
              <IconFocus size={13} />
              Around <span className="max-w-60 truncate">{view.rootLabel}</span>
            </ViewTab>
          )}
        </nav>
        <ScopeBanner view={view} status={status} fileCounts={fileCounts} totals={totals} loading={loading} />
      </Card>

      {error && (
        <Alert tone="danger" title="Could not load this part of the graph">
          {error}
        </Alert>
      )}
      {capNotice && (
        <Alert tone="warning" title="This view is full">
          Expanding {capNotice.label} would show {capNotice.wouldHave} symbols; one view draws at most {EXPLORE_NODE_CAP}. Nothing was added.{" "}
          <button type="button" className="underline underline-offset-2" onClick={() => refocus(capNotice.nodeId)}>
            Start a new view from {capNotice.label}
          </button>
        </Alert>
      )}

      {view.type === "overview" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-3">
              <p className="t-h3 text-fg">Folders and files</p>
              <p className="t-small text-fg-3 tabular-nums">
                {tree.totals.files} files · {tree.totals.symbols} symbols · {tree.totals.relationships} relationships
              </p>
            </div>
            <ul className="max-h-[560px] overflow-y-auto py-1" aria-label="Folders and files of the analysis">
              {rows.slice(0, rowLimit).map((row) => (
                <li key={`${row.type}:${row.path}`}>
                  {row.type === "dir" ? (
                    <button
                      type="button"
                      aria-expanded={openDirs.has(row.path)}
                      onClick={() =>
                        setOpenDirs((current) => {
                          const next = new Set(current);
                          if (next.has(row.path)) next.delete(row.path);
                          else next.add(row.path);
                          return next;
                        })
                      }
                      className="flex w-full min-w-0 items-center gap-2 px-5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-surface-2"
                      style={{ paddingLeft: 20 + row.depth * 16 }}
                    >
                      <IconArrowRight size={12} className={cx("shrink-0 text-fg-3 transition-transform", openDirs.has(row.path) && "rotate-90")} />
                      <span className="min-w-0 flex-1 truncate font-mono text-fg">{row.name}/</span>
                      <span className="shrink-0 tabular-nums text-fg-3">
                        {row.files} files · {row.symbols} symbols
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void openFile(row.file.fileId, row.file.path)}
                      className="flex w-full min-w-0 items-center gap-2 px-5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-surface-2"
                      style={{ paddingLeft: 38 + row.depth * 16 }}
                    >
                      <IconFileCode size={12} className="shrink-0 text-fg-3" />
                      <span className="min-w-0 flex-1 truncate font-mono text-fg-2">{row.name}</span>
                      <span className="shrink-0 tabular-nums text-fg-3">
                        {row.file.symbols} symbols · {row.file.relationships} relationships
                      </span>
                    </button>
                  )}
                </li>
              ))}
              {rows.length > rowLimit && (
                <li className="px-5 py-2">
                  <button type="button" onClick={() => setRowLimit((n) => n + TREE_ROW_STEP)} className="text-[12.5px] text-accent underline underline-offset-2">
                    Show {Math.min(TREE_ROW_STEP, rows.length - rowLimit)} more of {rows.length - rowLimit} rows
                  </button>
                </li>
              )}
            </ul>
          </Card>
          <div className="flex flex-col gap-4">
            <Card className="px-5 py-4">
              <p className="t-h3 text-fg">Files with the most symbols</p>
              <ul className="mt-2 flex flex-col gap-1">
                {largestFiles.map((file) => (
                  <li key={file.fileId} className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void openFile(file.fileId, file.path)}
                      className="min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left font-mono text-[12px] text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
                      title={file.path}
                    >
                      {file.path}
                    </button>
                    <span className="shrink-0 text-[11.5px] tabular-nums text-fg-3">{file.symbols}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card className="px-5 py-4">
              <p className="t-h3 text-fg">Relationships between files</p>
              <p className="t-small mt-1 text-fg-3">
                {externalTotal === 0
                  ? "This analysis stores no relationships between different files (imports are recorded as names inside each file and are not resolved), so the overview shows the folder structure, not file-to-file edges."
                  : `${externalTotal} stored relationships connect symbols in different files. Open a file to see them.`}
              </p>
            </Card>
          </div>
        </div>
      ) : loading && subgraph.nodes.length === 0 ? (
        <Card className="flex h-[420px] items-center justify-center gap-2 text-[13px] text-fg-3">
          <Spinner />
          Loading…
        </Card>
      ) : subgraph.nodes.length === 0 ? (
        <Card className="flex h-[240px] flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="t-h3 text-fg">{view.type === "file" ? "This file has no symbols in the analysis" : "Nothing to show"}</p>
          <button type="button" className="text-[12.5px] text-accent underline underline-offset-2" onClick={() => setView({ type: "overview" })}>
            Back to the overview
          </button>
        </Card>
      ) : (
        <>
          {view.type === "file" && (
            <p className="t-small text-fg-3">
              <button type="button" className="underline underline-offset-2 hover:text-fg" onClick={() => showInOverview(view.filePath)}>
                Show this file in the overview
              </button>
            </p>
          )}
          <RepositoryGraphExplorer
            key={viewSeq}
            graph={graph}
            degrees={degrees}
            onExpand={(id) => void expand(id)}
            onRefocus={refocus}
            busyNodeId={busyNodeId}
            searchHint="Search the symbols in this view"
          />
        </>
      )}
    </div>
  );
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      disabled={!onClick}
      className={cx(
        "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2.5 transition-colors",
        active ? "border-border-strong bg-surface-2 text-fg" : "border-border text-fg-3 hover:bg-surface-2 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function ScopeBanner({
  view,
  status,
  fileCounts,
  totals,
  loading,
}: {
  view: View;
  status: ReturnType<typeof subgraphStatus>;
  fileCounts?: { symbols: number };
  totals: { symbols: number; relationships: number };
  loading: boolean;
}) {
  const whole = `the analysis stores ${totals.symbols} symbols and ${totals.relationships} relationships`;
  if (view.type === "overview") {
    return (
      <p className="t-small text-fg-2" data-graph-mode="overview">
        <span className="font-medium text-fg">Overview.</span> Folders and files with their symbol and relationship counts; no symbols are drawn here. This
        analysis is too large to draw at once ({whole}), so open a file or search for a symbol to explore it in parts.
      </p>
    );
  }
  if (loading && status.symbols === 0) return <p className="t-small text-fg-3">Loading…</p>;
  const partial = status.truncated || status.incompleteSymbols > 0;
  return (
    <p className="t-small text-fg-2" data-graph-mode={view.type === "file" ? "file" : "focused"}>
      <span className="font-medium text-fg">{view.type === "file" ? "File view" : "Focused subgraph"}.</span>{" "}
      {status.symbols} symbols and {status.relationships} relationships of this analysis ({whole}); not the complete graph.{" "}
      {view.type === "file" && fileCounts && <>It holds all {fileCounts.symbols} symbols of this file. </>}
      {partial ? (
        <span className="text-warning">
          {status.truncated && "A request limit was reached, so some relationships are not shown. "}
          {status.incompleteSymbols > 0 &&
            `${status.incompleteSymbols} symbols have ${status.missingRelationships} more stored relationships that are not loaded (marked +n); select one and expand it.`}
        </span>
      ) : (
        <span>Every stored relationship of the symbols shown is included.</span>
      )}
    </p>
  );
}

// Server-side search over the whole analysis (bounded: the first results plus the total number of matches).
function SymbolSearch({ dataUrl, onPick }: { dataUrl: string; onPick: (result: GraphSearchResult) => void }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ query: string; results: GraphSearchResult[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const q = query.trim();

  useEffect(() => {
    if (q.length < 2) return;
    const ctl = new AbortController();
    controller.current?.abort();
    controller.current = ctl;
    const timer = setTimeout(() => {
      getJson<{ results: GraphSearchResult[]; total: number }>(`${dataUrl}?${new URLSearchParams({ op: "search", q })}`, ctl.signal)
        .then((body) => {
          setFailed(false);
          setState({ query: q, ...body });
        })
        .catch((e: unknown) => {
          if (!(e instanceof DOMException && e.name === "AbortError")) setFailed(true);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q, dataUrl]);

  const current = q.length >= 2 && state?.query === q ? state : null;
  return (
    <div className="relative min-w-0">
      <label htmlFor="graph-server-search" className="sr-only">
        Search all symbols of the analysis
      </label>
      <IconSearch size={15} className="pointer-events-none absolute top-2.5 left-3 text-fg-3" />
      <input
        id="graph-server-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search all symbols of the analysis (at least 2 characters)"
        autoComplete="off"
        maxLength={200}
        className="h-9 w-full rounded-md border border-border-strong bg-bg-subtle pr-3 pl-9 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-accent"
      />
      {q.length >= 2 && (
        <div className="mt-2 rounded-lg border border-border bg-surface-2/60 p-1" role="region" aria-label="Search results" aria-live="polite">
          {failed ? (
            <p className="t-small px-2.5 py-2 text-danger">The search failed. Try again.</p>
          ) : !current ? (
            <p className="t-small flex items-center gap-2 px-2.5 py-2 text-fg-3">
              <Spinner /> Searching…
            </p>
          ) : current.results.length === 0 ? (
            <p className="t-small px-2.5 py-2 text-fg-3">No symbol matches “{q}”.</p>
          ) : (
            <>
              <ul className="flex flex-col">
                {current.results.map((result) => (
                  <li key={result.id}>
                    <button
                      type="button"
                      onClick={() => onPick(result)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-surface-3"
                    >
                      <span className="w-20 shrink-0 text-[11px] text-fg-3">{kindMeta(result.kind).label}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{result.qualifiedName ?? result.label}</span>
                      <span className="hidden shrink-0 truncate font-mono text-[11px] text-fg-3 sm:block">
                        {result.filePath}:{result.startLine}
                      </span>
                      <IconNetwork size={12} className="shrink-0 text-fg-3" />
                    </button>
                  </li>
                ))}
              </ul>
              {current.total > current.results.length && (
                <p className="t-small px-2.5 pt-1 pb-1.5 text-fg-3">
                  Showing the first {current.results.length} of {current.total} matches (at most {SEARCH_LIMIT}). Refine the search to narrow it down.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
