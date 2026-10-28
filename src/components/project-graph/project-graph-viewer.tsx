"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, Spinner } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconFileCode, IconFit, IconFocus, IconMinus, IconPlus, IconSearch } from "@/components/ui/icons";
import { cx } from "@/lib/cx";
import { aggregateEdges, buildTree, layout, visibleNodeIds, type TreeNode } from "@/lib/project-graph/tree";
import type { FileSymbol, ProjectGraphData, SymbolHit } from "@/server/repository-graph/project";

// Whole-project graph: repository -> directories -> files (CONTAINS, shown by the tree), file -> file IMPORTS as arcs.
// Directories collapse; import edges between hidden files are rolled up to the directories that stand for them, so the
// picture stays readable on large repositories without dropping anything from the underlying data.

type Props = { data: ProjectGraphData; dataUrl: string; filesUrl: string; canRebuild: boolean };

const ROW = 26;
const COL = 24; // horizontal indent per depth
const NODE_W = 260;
const PAD = 16;
const EDGE_CAP = 1500;

export function ProjectGraphViewer({ data, dataUrl, filesUrl, canRebuild }: Props) {
  const filesById = useMemo(() => new Map(data.files.map((f) => [f.id, f])), [data.files]);
  const idByPath = useMemo(() => new Map(data.files.map((f) => [f.path, f.id])), [data.files]);
  const tree = useMemo(() => buildTree(data.files.map((f) => f.path), data.repository.name), [data.files, data.repository.name]);
  const pathEdges = useMemo(
    () => data.edges.flatMap((e) => (filesById.has(e.source) && filesById.has(e.target) ? [[filesById.get(e.source)!.path, filesById.get(e.target)!.path] as const] : [])),
    [data.edges, filesById],
  );

  const initialOpen = useCallback(() => new Set(tree.root.children.filter((c) => c.kind === "directory").map((c) => c.id)), [tree]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(initialOpen);
  const [selected, setSelected] = useState<string | null>(null); // node id (path)
  const [language, setLanguage] = useState("");
  const [onlyLinked, setOnlyLinked] = useState(false);
  const [showEdges, setShowEdges] = useState(true);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [view, setView] = useState({ x: 8, y: 8, k: 1 });
  const [symbols, setSymbols] = useState<Record<string, FileSymbol[] | "loading" | "error">>({});
  const [rebuilding, setRebuilding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const requested = useRef(new Set<string>());
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const linked = useMemo(() => new Set(pathEdges.flat()), [pathEdges]);
  const languages = useMemo(() => [...new Set(data.files.map((f) => f.language).filter((l): l is string => !!l))].sort(), [data.files]);

  const matches = useCallback(
    (node: TreeNode) => {
      if (node.kind !== "file") return true;
      const file = filesById.get(idByPath.get(node.id) ?? "");
      if (!file) return false;
      if (language && file.language !== language) return false;
      if (onlyLinked && !linked.has(node.id)) return false;
      return true;
    },
    [filesById, idByPath, language, onlyLinked, linked],
  );

  const filtering = language !== "" || onlyLinked;
  const visible = useMemo(() => {
    const ids = visibleNodeIds(tree, expanded);
    if (!filtering) return ids;
    // With a filter on, only matching files and the directories that lead to them remain.
    const keep = new Set<string>([""]);
    for (const id of ids) {
      const node = tree.byPath.get(id)!;
      if (node.kind === "file" && matches(node)) {
        for (let cur: string | null = id; cur !== null; cur = tree.byPath.get(cur)?.parent ?? null) keep.add(cur);
      }
    }
    return new Set([...ids].filter((id) => keep.has(id)));
  }, [tree, expanded, filtering, matches]);

  const positions = useMemo(() => layout(tree, visible), [tree, visible]);
  const edges = useMemo(() => aggregateEdges(tree, pathEdges, visible), [tree, pathEdges, visible]);
  const drawnEdges = edges.slice(0, EDGE_CAP);

  const selectedFile = selected ? filesById.get(idByPath.get(selected) ?? "") : undefined;
  const incoming = useMemo(() => (selected ? pathEdges.filter(([, t]) => t === selected).map(([s]) => s) : []), [pathEdges, selected]);
  const outgoing = useMemo(() => (selected ? pathEdges.filter(([s]) => s === selected).map(([, t]) => t) : []), [pathEdges, selected]);
  const neighbours = useMemo(() => new Set([...incoming, ...outgoing]), [incoming, outgoing]);

  function reveal(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let cur = tree.byPath.get(path)?.parent ?? null; cur; cur = tree.byPath.get(cur)?.parent ?? null) next.add(cur);
      return next;
    });
  }

  function select(path: string) {
    setSelected(path);
    reveal(path);
    const pos = positions.get(path);
    if (pos) setView((v) => ({ ...v, y: Math.max(8, 200 - (pos.y * ROW + PAD) * v.k) }));
  }

  function expandNeighbourhood() {
    if (!selected) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const path of [selected, ...neighbours]) {
        for (let cur = tree.byPath.get(path)?.parent ?? null; cur; cur = tree.byPath.get(cur)?.parent ?? null) next.add(cur);
      }
      return next;
    });
  }

  function reset() {
    setExpanded(initialOpen());
    setSelected(null);
    setLanguage("");
    setOnlyLinked(false);
    setShowEdges(true);
    setQuery("");
    setHits([]);
    setView({ x: 8, y: 8, k: 1 });
  }

  function expandAll() {
    setExpanded(new Set([...tree.byPath.values()].filter((n) => n.kind === "directory").map((n) => n.id)));
  }

  // Symbols of the selected file, loaded lazily.
  useEffect(() => {
    const id = selectedFile?.id;
    if (!id || !selectedFile.parsed || requested.current.has(id)) return;
    requested.current.add(id);
    fetch(`${dataUrl}?${new URLSearchParams({ op: "symbols", fileId: id })}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((body: { symbols: FileSymbol[] }) => setSymbols((s) => ({ ...s, [id]: body.symbols })))
      .catch(() => setSymbols((s) => ({ ...s, [id]: "error" })));
  }, [selectedFile, dataUrl]);

  // Search: file paths immediately (client side), symbols from the server after a short pause.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      fetch(`${dataUrl}?${new URLSearchParams({ op: "search", q })}`, { cache: "no-store", signal: controller.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
        .then((body: { results: SymbolHit[] }) => setHits(body.results))
        .catch(() => undefined)
        .finally(() => setSearching(false));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, dataUrl]);

  const shownHits = query.trim().length < 2 ? [] : hits;
  const pathHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q.length < 2 ? [] : data.files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 12);
  }, [query, data.files]);

  async function rebuild() {
    setRebuilding(true);
    setNotice(null);
    try {
      const response = await fetch(dataUrl, { method: "POST" });
      const body = (await response.json()) as { stored?: number; unresolvedLocal?: number; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Rebuild failed.");
      setNotice(`Rebuilt: ${body.stored} import links stored (${body.unresolvedLocal} local imports could not be resolved). Reloading…`);
      setTimeout(() => window.location.reload(), 800);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Rebuild failed.");
      setRebuilding(false);
    }
  }

  const zoom = (factor: number) => setView((v) => ({ ...v, k: Math.min(2.5, Math.max(0.3, v.k * factor)) }));
  const isAlt = (id: string) => selected !== null && id !== selected && neighbours.has(id);
  const fileHref = (path: string, from?: number, to?: number) =>
    `${filesUrl}?${new URLSearchParams({ path, ...(from ? { from: String(from), to: String(to ?? from) } : {}) })}`;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]" data-testid="project-graph">
      <Card className="flex min-w-0 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-[200px] flex-1">
            <IconSearch size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-fg-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files and symbols"
              aria-label="Search files and symbols"
              className="h-9 w-full rounded-lg border border-border bg-surface-2 pl-8 pr-2 text-[13px] text-fg outline-none focus:border-accent"
            />
          </div>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Filter by language" className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-[13px] text-fg">
            <option value="">All languages</option>
            {languages.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-[13px] text-fg-2">
            <input type="checkbox" checked={onlyLinked} onChange={(e) => setOnlyLinked(e.target.checked)} /> Files with imports
          </label>
          <label className="flex items-center gap-1.5 text-[13px] text-fg-2">
            <input type="checkbox" checked={showEdges} onChange={(e) => setShowEdges(e.target.checked)} /> Import arcs
          </label>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="secondary" size="sm" onClick={() => zoom(1.2)} aria-label="Zoom in"><IconPlus size={14} /></Button>
            <Button variant="secondary" size="sm" onClick={() => zoom(1 / 1.2)} aria-label="Zoom out"><IconMinus size={14} /></Button>
            <Button variant="secondary" size="sm" onClick={() => setView({ x: 8, y: 8, k: 1 })} aria-label="Fit view"><IconFit size={14} /></Button>
            <Button variant="secondary" size="sm" onClick={expandAll}>Expand all</Button>
            <Button variant="secondary" size="sm" onClick={() => setExpanded(new Set())}>Collapse</Button>
            <Button variant="secondary" size="sm" onClick={reset}>Reset</Button>
          </div>
        </div>

        {(pathHits.length > 0 || shownHits.length > 0 || searching) && (
          <ul className="max-h-48 divide-y divide-border overflow-auto border-b border-border bg-surface-2 text-[13px]" aria-label="Search results">
            {pathHits.map((f) => (
              <li key={f.id}>
                <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-3" onClick={() => select(f.path)}>
                  <IconFileCode size={13} /> <span className="font-mono">{f.path}</span>
                </button>
              </li>
            ))}
            {shownHits.map((h) => (
              <li key={h.id}>
                <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-3" onClick={() => select(h.path)}>
                  <span className="rounded bg-surface-3 px-1 text-[11px] text-fg-3">{h.kind}</span> <span className="font-medium">{h.name}</span>
                  <span className="truncate font-mono text-fg-3">{h.path}:{h.line}</span>
                </button>
              </li>
            ))}
            {searching && <li className="px-3 py-1.5 text-fg-3"><Spinner /> Searching symbols…</li>}
          </ul>
        )}

        <div
          className="relative h-[620px] cursor-grab touch-none overflow-hidden bg-bg-subtle active:cursor-grabbing"
          onWheel={(e) => zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1)}
          onPointerDown={(e) => {
            if ((e.target as Element).closest("[data-node]")) return;
            drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
          }}
          onPointerUp={() => (drag.current = null)}
        >
          <svg width="100%" height="100%" role="img" aria-label={`Project graph of ${data.repository.owner}/${data.repository.name}`}>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {showEdges &&
                drawnEdges.map((e) => {
                  const a = positions.get(e.from)!;
                  const b = positions.get(e.to)!;
                  const x1 = PAD + a.x * COL + NODE_W;
                  const x2 = PAD + b.x * COL + NODE_W;
                  const y1 = PAD + a.y * ROW + ROW / 2;
                  const y2 = PAD + b.y * ROW + ROW / 2;
                  const bulge = 30 + Math.min(90, Math.abs(y2 - y1) / 6);
                  const active = selected !== null && (e.from === selected || e.to === selected);
                  return (
                    <path
                      key={`${e.from}>${e.to}`}
                      d={`M${x1} ${y1} C${x1 + bulge} ${y1} ${x2 + bulge} ${y2} ${x2} ${y2}`}
                      fill="none"
                      stroke={active ? "var(--accent)" : "var(--info)"}
                      strokeOpacity={selected && !active ? 0.12 : 0.55}
                      strokeWidth={active ? 2 : 1 + Math.min(2, Math.log2(e.count))}
                      strokeDasharray="6 4"
                    >
                      <title>{`${e.from || "repository"} imports ${e.to || "repository"} (${e.count} link${e.count === 1 ? "" : "s"})`}</title>
                    </path>
                  );
                })}
              {[...positions].map(([id, pos]) => {
                const node = tree.byPath.get(id)!;
                const file = node.kind === "file" ? filesById.get(idByPath.get(id) ?? "") : undefined;
                const isDir = node.kind !== "file";
                const open = expanded.has(id);
                const x = PAD + pos.x * COL;
                const y = PAD + pos.y * ROW;
                const sel = id === selected;
                return (
                  <g
                    key={id || "root"}
                    data-node
                    transform={`translate(${x} ${y})`}
                    className="cursor-pointer"
                    onClick={() => {
                      if (isDir && node.kind === "directory") setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
                      setSelected(id);
                    }}
                  >
                    <rect width={NODE_W} height={ROW - 4} rx={6} fill={sel ? "var(--accent)" : "var(--surface-2)"} fillOpacity={sel ? 0.22 : 1} stroke={sel ? "var(--accent)" : isAlt(id) ? "var(--info)" : "var(--border)"} strokeWidth={sel || isAlt(id) ? 1.75 : 1} />
                    <text x={8} y={(ROW - 4) / 2 + 4} fontSize={12} fill="var(--fg)" className="select-none">
                      {isDir ? (node.kind === "repository" ? "◆ " : open ? "▾ " : "▸ ") : ""}
                      {(node.name.length > 30 ? `${node.name.slice(0, 29)}…` : node.name) + (isDir ? ` (${node.fileCount})` : "")}
                    </text>
                    {file && file.symbols > 0 && <text x={NODE_W - 8} y={(ROW - 4) / 2 + 4} fontSize={10} fill="var(--fg-3)" textAnchor="end">{file.symbols} sym</text>}
                    {file && file.bugs > 0 && <circle cx={NODE_W - 48} cy={(ROW - 4) / 2} r={5} fill="var(--danger)"><title>{file.bugs} open bug(s)</title></circle>}
                  </g>
                );
              })}
            </g>
          </svg>
          {edges.length > EDGE_CAP && <p className="absolute bottom-2 left-3 rounded bg-surface px-2 py-1 text-[12px] text-fg-2">Showing {EDGE_CAP} of {edges.length} import arcs. Collapse directories or select a file to see its links.</p>}
        </div>
        <p className="border-t border-border px-3 py-2 text-[12px] text-fg-3">
          Click a folder to expand or collapse it. Drag to pan, scroll to zoom. Dashed arcs are resolved imports between files; collapsed folders roll up the imports of the files inside.
        </p>
      </Card>

      <Card className="h-fit p-4" aria-live="polite">
        {!selected && <p className="text-[13px] text-fg-2">Select a file or folder to see its details, what it imports and what imports it.</p>}
        {selected !== null && !selectedFile && (
          <div className="space-y-2 text-[13px]">
            <h3 className="font-medium text-fg">{selected || data.repository.name}</h3>
            <p className="text-fg-2">{tree.byPath.get(selected)?.kind === "repository" ? "Repository" : "Directory"} · {tree.byPath.get(selected)?.fileCount} files</p>
          </div>
        )}
        {selectedFile && (
          <div className="space-y-3 text-[13px]">
            <div>
              <h3 className="break-all font-mono font-medium text-fg">{selectedFile.path}</h3>
              <p className="mt-1 text-fg-2">
                {selectedFile.language ?? "unknown language"} · {(selectedFile.sizeBytes / 1024).toFixed(1)} KB · {selectedFile.parsed ? `${selectedFile.symbols} symbols` : "not parsed (no parser for this file type)"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {selectedFile.hasText ? (
                <Link href={fileHref(selectedFile.path)} className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg">Open file</Link>
              ) : (
                <span className="text-fg-3">Source text not stored for this file.</span>
              )}
              <Button variant="secondary" size="sm" onClick={expandNeighbourhood}><IconFocus size={13} /> Show neighbourhood</Button>
            </div>
            <LinkList title={`Imports (${outgoing.length})`} paths={outgoing} onPick={select} />
            <LinkList title={`Imported by (${incoming.length})`} paths={incoming} onPick={select} />
            {selectedFile.parsed && (
              <div>
                <h4 className="mb-1 font-medium text-fg">Symbols</h4>
                {symbols[selectedFile.id] === undefined && <p className="text-fg-3"><Spinner /> Loading…</p>}
                {symbols[selectedFile.id] === "error" && <p className="text-danger">Could not load the symbols.</p>}
                {Array.isArray(symbols[selectedFile.id]) && (
                  <ul className="max-h-56 space-y-0.5 overflow-auto">
                    {(symbols[selectedFile.id] as FileSymbol[]).map((s) => (
                      <li key={s.id}>
                        <Link href={fileHref(selectedFile.path, s.startLine, s.endLine)} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-2">
                          <span className="rounded bg-surface-3 px-1 text-[11px] text-fg-3">{s.kind}</span>
                          <span className="truncate">{s.name}</span>
                          <span className="ml-auto font-mono text-fg-3">L{s.startLine}</span>
                        </Link>
                      </li>
                    ))}
                    {(symbols[selectedFile.id] as FileSymbol[]).length === 0 && <li className="text-fg-3">No symbols.</li>}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
        {canRebuild && (
          <div className="mt-4 border-t border-border pt-3">
            <Button variant="secondary" size="sm" onClick={rebuild} disabled={rebuilding}>{rebuilding ? <Spinner /> : null} Rebuild import links</Button>
            <p className="mt-1 text-[12px] text-fg-3">Recomputes file-to-file imports from the stored source. Use for snapshots imported before links existed.</p>
          </div>
        )}
        {notice && <Alert tone="info" title="Import links" className="mt-3">{notice}</Alert>}
      </Card>
    </div>
  );
}

function LinkList({ title, paths, onPick }: { title: string; paths: string[]; onPick: (p: string) => void }) {
  return (
    <div>
      <h4 className="mb-1 font-medium text-fg">{title}</h4>
      {paths.length === 0 ? (
        <p className="text-fg-3">None resolved.</p>
      ) : (
        <ul className={cx("max-h-40 space-y-0.5 overflow-auto")}>
          {paths.map((p) => (
            <li key={p}>
              <button className="w-full truncate rounded px-1 py-0.5 text-left font-mono hover:bg-surface-2" onClick={() => onPick(p)} title={p}>{p}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
