"use client";

import { useCallback, useMemo, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { IconClose, IconFocus, IconNetwork, IconSearch } from "@/components/ui/icons";
import { cx } from "@/lib/cx";
import type { GraphNode, RepositoryGraph } from "@/lib/repository-graph/types";
import { RENDER_LIMIT, filterGraph, layoutGraph, searchNodes } from "@/lib/repository-graph/view";
import { GraphCanvas, type Selection } from "./graph-canvas";
import { GraphDetails } from "./graph-details";
import { KIND_ORDER, TYPE_ORDER, byOrder, kindMeta, typeMeta } from "./graph-style";

// Interactive, read-only explorer of one completed structure analysis, or of the explored part of a large one. All
// data arrives from the server already authorized; this component only filters, lays out and inspects it.

// Optional extras for explored views of large analyses (absent for the complete graph):
//   degrees    loaded vs stored relationships per symbol, so a partial neighbourhood is never shown as complete
//   onExpand   load the neighbours of a symbol into the view
//   onRefocus  start a new view from a symbol
//   searchHint label of the search box (it always searches the symbols in `graph` only)
export type ExplorerExtras = {
  degrees?: ReadonlyMap<string, { loaded: number; stored: number | null; missing: number }>;
  onExpand?: (nodeId: string) => void;
  onRefocus?: (nodeId: string) => void;
  busyNodeId?: string | null;
  searchHint?: string;
};

type Props = { graph: RepositoryGraph } & ExplorerExtras;

function initialFile(graph: RepositoryGraph): string | null {
  // Large graphs open one file at a time (stated in the UI), so the first view never exceeds the render limit blindly.
  return graph.nodes.length > RENDER_LIMIT ? (graph.nodes[0]?.fileId ?? null) : null;
}

export function RepositoryGraphExplorer({ graph, degrees, onExpand, onRefocus, busyNodeId = null, searchHint }: Props) {
  const kinds = useMemo(() => Object.keys(graph.summary.nodesByKind).sort(byOrder(KIND_ORDER)), [graph]);
  const types = useMemo(() => Object.keys(graph.summary.edgesByType).sort(byOrder(TYPE_ORDER)), [graph]);
  const files = useMemo(() => {
    const map = new Map<string, { fileId: string; filePath: string; count: number }>();
    for (const node of graph.nodes) {
      const entry = map.get(node.fileId);
      if (entry) entry.count++;
      else map.set(node.fileId, { fileId: node.fileId, filePath: node.filePath, count: 1 });
    }
    return [...map.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
  }, [graph]);
  const nodesById = useMemo(() => new Map<string, GraphNode>(graph.nodes.map((node) => [node.id, node])), [graph]);

  // Filters store what is HIDDEN, so kinds and types that appear later (an explored view growing) are shown by default.
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(() => new Set());
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(() => new Set());
  const kindFilter = useMemo(() => new Set(kinds.filter((kind) => !hiddenKinds.has(kind))), [kinds, hiddenKinds]);
  const typeFilter = useMemo(() => new Set(types.filter((type) => !hiddenTypes.has(type))), [types, hiddenTypes]);
  const [fileId, setFileId] = useState<string | null>(() => initialFile(graph));
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [query, setQuery] = useState("");

  const visible = useMemo(
    () => filterGraph(graph, { kinds: kindFilter, types: typeFilter, fileId, focusId }),
    [graph, kindFilter, typeFilter, fileId, focusId],
  );
  const visibleIds = useMemo(() => new Set(visible.nodes.map((node) => node.id)), [visible]);
  const tooMany = visible.nodes.length > RENDER_LIMIT;
  const layout = useMemo(() => (tooMany ? null : layoutGraph(visible)), [visible, tooMany]);
  const results = useMemo(() => searchNodes(graph, query, 8), [graph, query]);

  // While a node is selected, keep it and its direct (visible) neighbours fully opaque.
  const related = useMemo(() => {
    if (selection?.type !== "node") return null;
    const keep = new Set<string>([selection.id]);
    for (const edge of visible.edges) {
      if (edge.source === selection.id) keep.add(edge.target);
      if (edge.target === selection.id) keep.add(edge.source);
    }
    return keep;
  }, [selection, visible]);

  const select = useCallback((next: Selection) => setSelection(next), []);

  const toggle = (set: ReadonlySet<string>, value: string, update: (next: ReadonlySet<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };

  const reset = () => {
    setHiddenKinds(new Set());
    setHiddenTypes(new Set());
    setFileId(initialFile(graph));
    setFocusId(null);
    setSelection(null);
    setQuery("");
  };

  const reveal = (node: GraphNode) => {
    setHiddenKinds((current) => {
      if (!current.has(node.kind)) return current;
      const next = new Set(current);
      next.delete(node.kind);
      return next;
    });
    if (fileId !== null && fileId !== node.fileId) setFileId(node.fileId);
    if (focusId !== null && focusId !== node.id) setFocusId(null);
  };

  const filtersActive = hiddenKinds.size > 0 || hiddenTypes.size > 0 || fileId !== initialFile(graph) || focusId !== null || query !== "";
  const pending = useMemo(() => {
    if (!degrees) return undefined;
    const map = new Map<string, number>();
    for (const [id, info] of degrees) if (info.missing > 0) map.set(id, info.missing);
    return map;
  }, [degrees]);
  const focusNode = focusId ? nodesById.get(focusId) : undefined;
  const selectedHidden = selection?.type === "node" && !visibleIds.has(selection.id);

  return (
    <div className="flex flex-col gap-4">
      {/* Controls */}
      <Card className="flex flex-col gap-4 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          <div className="relative min-w-0 flex-1">
            <label htmlFor="graph-search" className="sr-only">
              Search symbols by name or qualified name
            </label>
            <IconSearch size={15} className="pointer-events-none absolute top-2.5 left-3 text-fg-3" />
            <input
              id="graph-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchHint ?? "Search symbols by name or qualified name"}
              autoComplete="off"
              className="h-9 w-full rounded-md border border-border-strong bg-bg-subtle pr-3 pl-9 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-accent"
            />
            {query.trim() !== "" && (
              <div className="mt-2 rounded-lg border border-border bg-surface-2/60 p-1" role="region" aria-label="Search results">
                {results.length === 0 ? (
                  <p className="t-small px-2.5 py-2 text-fg-3">No symbol matches “{query.trim()}”.</p>
                ) : (
                  <ul className="flex flex-col">
                    {results.map((node) => (
                      <li key={node.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelection({ type: "node", id: node.id });
                          }}
                          className={cx(
                            "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-surface-3",
                            selection?.type === "node" && selection.id === node.id && "bg-surface-3",
                          )}
                        >
                          <span className="w-20 shrink-0 text-[11px] text-fg-3">{kindMeta(node.kind).label}</span>
                          <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{node.qualifiedName ?? node.label}</span>
                          <span className="hidden shrink-0 truncate font-mono text-[11px] text-fg-3 sm:block">
                            {node.filePath}:{node.startLine}
                          </span>
                          {!visibleIds.has(node.id) && <span className="shrink-0 text-[11px] text-warning">hidden</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="graph-file" className="sr-only">
              File
            </label>
            <select
              id="graph-file"
              value={fileId ?? ""}
              onChange={(event) => {
                setFileId(event.target.value === "" ? null : event.target.value);
                setFocusId(null);
              }}
              className="h-9 max-w-full rounded-md border border-border-strong bg-bg-subtle px-2.5 text-[13px] text-fg outline-none focus:border-accent sm:max-w-72"
            >
              <option value="">All files ({files.length})</option>
              {files.map((file) => (
                <option key={file.fileId} value={file.fileId}>
                  {file.filePath} ({file.count})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={reset}
              disabled={!filtersActive && selection === null}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border-strong bg-surface-2 px-3 text-[13px] font-medium text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-50"
            >
              <IconClose size={14} />
              Reset view
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:gap-6">
          <FilterGroup label="Symbol kinds">
            {kinds.map((kind) => (
              <Toggle key={kind} active={kindFilter.has(kind)} onClick={() => toggle(hiddenKinds, kind, setHiddenKinds)}>
                <span className="font-mono text-[10.5px]" style={{ color: kindMeta(kind).color }}>
                  {kindMeta(kind).glyph}
                </span>
                {kindMeta(kind).label}
                <span className="tabular-nums text-fg-3">{graph.summary.nodesByKind[kind]}</span>
              </Toggle>
            ))}
          </FilterGroup>
          <FilterGroup label="Relationships">
            {types.length === 0 ? (
              <span className="t-small text-fg-3">None stored for this analysis.</span>
            ) : (
              types.map((type) => (
                <Toggle key={type} active={typeFilter.has(type)} onClick={() => toggle(hiddenTypes, type, setHiddenTypes)}>
                  <LineSample type={type} />
                  {typeMeta(type).label}
                  <span className="tabular-nums text-fg-3">{graph.summary.edgesByType[type]}</span>
                </Toggle>
              ))
            )}
          </FilterGroup>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-3 text-[12.5px] text-fg-3" aria-live="polite">
          <span>
            {tooMany ? "Matching (not drawn)" : "Showing"} <span className="tabular-nums text-fg">{visible.nodes.length}</span> of{" "}
            <span className="tabular-nums">{graph.summary.totalNodes}</span> symbols and{" "}
            <span className="tabular-nums text-fg">{visible.edges.length}</span> of <span className="tabular-nums">{graph.summary.totalEdges}</span>{" "}
            relationships
          </span>
          {focusNode && (
            <span className="inline-flex items-center gap-1.5 text-accent">
              <IconFocus size={13} />
              Direct neighbours of {focusNode.label}
              <button type="button" onClick={() => setFocusId(null)} className="underline underline-offset-2 hover:text-fg">
                show all
              </button>
            </span>
          )}
          {graph.summary.totalNodes > RENDER_LIMIT && (
            <span className="text-warning">Large graph: views are limited to {RENDER_LIMIT} symbols at a time. Choose a file or narrow the filters.</span>
          )}
        </div>
      </Card>

      {/* Canvas + details */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="relative h-[60vh] min-h-[380px] overflow-hidden bg-bg-subtle sm:h-[560px]">
          {visible.nodes.length === 0 ? (
            <CanvasMessage title="No symbols match the current filters" body="Turn on more symbol kinds, choose another file or reset the view." onReset={reset} />
          ) : tooMany || !layout ? (
            <CanvasMessage
              title={`${visible.nodes.length} symbols are too many to draw at once`}
              body={`The canvas draws at most ${RENDER_LIMIT} symbols. Choose a single file, turn off some symbol kinds, or select a symbol and focus on its neighbours. Search and the summary still cover the whole graph.`}
              onReset={reset}
            />
          ) : (
            <GraphCanvas layout={layout} edges={visible.edges} selection={selection} related={related} pending={pending} onSelect={select} />
          )}
          {selectedHidden && (
            <div className="absolute top-3 left-3 max-w-sm">
              <Alert tone="warning">
                The selected symbol is hidden by the current filters.{" "}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => {
                    const node = nodesById.get(selection!.id);
                    if (node) reveal(node);
                  }}
                >
                  Show it
                </button>
              </Alert>
            </div>
          )}
        </Card>
        <Card className="h-fit overflow-hidden xl:max-h-[560px] xl:overflow-y-auto">
          <div className="border-b border-border px-5 py-3">
            <p className="t-h3 text-fg">Details</p>
          </div>
          <GraphDetails
            graph={graph}
            nodesById={nodesById}
            selection={selection}
            visibleIds={visibleIds}
            focused={selection?.type === "node" && focusId === selection.id}
            onSelect={select}
            onFocus={(id) => {
              if (id) {
                const node = nodesById.get(id);
                if (node) reveal(node);
              }
              setFocusId(id);
            }}
            degrees={degrees}
            onExpand={onExpand}
            onRefocus={onRefocus}
            busyNodeId={busyNodeId}
          />
        </Card>
      </div>

      <Legend types={types} />
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="t-caption mb-2 text-fg-3">{label}</legend>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  );
}

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors",
        active ? "border-border-strong bg-surface-2 text-fg" : "border-border bg-transparent text-fg-3 line-through decoration-fg-3/60",
      )}
    >
      {children}
    </button>
  );
}

function LineSample({ type }: { type: string }) {
  const meta = typeMeta(type);
  return (
    <svg width="22" height="8" aria-hidden="true" className="shrink-0">
      <line x1="1" y1="4" x2="21" y2="4" style={{ stroke: meta.color }} strokeWidth={Math.max(1.5, meta.width)} strokeDasharray={meta.dash || undefined} />
    </svg>
  );
}

function CanvasMessage({ title, body, onReset }: { title: string; body: string; onReset: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <span className="mb-3 inline-flex size-10 items-center justify-center rounded-xl border border-border-strong bg-surface-2 text-fg-2">
        <IconNetwork size={18} />
      </span>
      <p className="t-h3 text-fg">{title}</p>
      <p className="t-small mt-1 max-w-md text-fg-3">{body}</p>
      <button type="button" onClick={onReset} className="mt-4 text-[12.5px] text-accent underline underline-offset-2 hover:text-fg">
        Reset view
      </button>
    </div>
  );
}

function Legend({ types }: { types: string[] }) {
  const missing = ["CALLS", "REFERENCES"].filter((type) => !types.includes(type));
  return (
    <Card className="px-5 py-4">
      <p className="t-caption text-fg-3">Legend</p>
      <p className="t-small mt-1 text-fg-3">
        Every arrow points from the stored source to the stored target. Dashed boxes group the symbols of one file; a symbol sits under the symbol that
        contains it (or the file module that imports it).
      </p>
      {types.length > 0 && (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {types.map((type) => (
            <li key={type} className="flex items-center gap-2.5 text-[12.5px]">
              <LineSample type={type} />
              <span className="w-20 shrink-0 font-medium text-fg">{typeMeta(type).label}</span>
              <span className="min-w-0 text-fg-3">{typeMeta(type).direction}</span>
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <p className="t-small mt-3 text-fg-3">
          {missing.map((type) => typeMeta(type).label).join(" and ")} relationships are not extracted by the current analyzer, so none are drawn. Imports
          are recorded as names inside each file and are not resolved to other files.
        </p>
      )}
    </Card>
  );
}
