"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconFit, IconMinus, IconPlus } from "@/components/ui/icons";
import { cx } from "@/lib/cx";
import type { GraphEdge } from "@/lib/repository-graph/types";
import { FILE_HEADER, NODE_HEIGHT, NODE_WIDTH, type GraphLayout, type PositionedNode } from "@/lib/repository-graph/view";
import { kindMeta, typeMeta } from "./graph-style";

// SVG canvas: pan (drag), zoom (wheel, pinch, buttons), fit-to-view, node and edge selection. Rendering only: it
// receives an already filtered, laid-out graph and never fetches or changes data.

export type Selection = { type: "node" | "edge"; id: string } | null;

type View = { x: number; y: number; k: number };
const MIN_K = 0.2;
const MAX_K = 2.5;
const PAD = 32;

function clamp(k: number) {
  return Math.min(MAX_K, Math.max(MIN_K, k));
}

// Cubic curve between two nodes, plus the point at `t` along it (where the type label sits; staggered per type so
// parallel relationships between the same pair stay readable).
function edgePath(a: PositionedNode, b: PositionedNode, t: number) {
  const ax = a.x + NODE_WIDTH / 2;
  const bx = b.x + NODE_WIDTH / 2;
  let p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number];
  if (b.y > a.y + 1) {
    const y1 = a.y + NODE_HEIGHT;
    const my = (y1 + b.y) / 2;
    [p0, p1, p2, p3] = [[ax, y1], [ax, my], [bx, my], [bx, b.y]];
  } else if (a.y > b.y + 1) {
    const y2 = b.y + NODE_HEIGHT;
    const my = (a.y + y2) / 2;
    [p0, p1, p2, p3] = [[ax, a.y], [ax, my], [bx, my], [bx, y2]];
  } else {
    // Same row: arc over the top.
    const lift = 28 + Math.min(60, Math.abs(bx - ax) / 6);
    [p0, p1, p2, p3] = [[ax, a.y], [ax, a.y - lift], [bx, a.y - lift], [bx, a.y]];
  }
  const u = 1 - t;
  const at = (i: 0 | 1) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i];
  return { d: `M${p0[0]},${p0[1]} C${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`, mx: at(0), my: at(1) };
}

const LABEL_T: Record<string, number> = { EXTENDS: 0.35, IMPLEMENTS: 0.65, IMPORTS: 0.5, CALLS: 0.45, REFERENCES: 0.55 };

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function GraphCanvas({
  layout,
  edges,
  selection,
  related,
  pending,
  onSelect,
}: {
  layout: GraphLayout;
  edges: GraphEdge[];
  selection: Selection;
  related: ReadonlySet<string> | null; // nodes to keep fully visible while something is selected
  pending?: ReadonlyMap<string, number>; // explored views: stored relationships of a node that are not loaded
  onSelect: (selection: Selection) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 520 });
  const drag = useRef<{ id: number; x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; k: number } | null>(null);

  const byId = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The fitted view is derived from the layout and canvas size; user pan/zoom is kept only for that same layout and
  // size, so a new filter result or a resize always starts from a fitted view.
  const fitted = useMemo<View>(() => {
    const w = Math.max(1, layout.width);
    const h = Math.max(1, layout.height);
    const k = clamp(Math.min((size.w - PAD * 2) / w, (size.h - PAD * 2) / h, 1.2));
    return { k, x: (size.w - w * k) / 2, y: Math.max(PAD, (size.h - h * k) / 2) };
  }, [layout, size]);
  const [manual, setManual] = useState<{ layout: GraphLayout; w: number; h: number; view: View } | null>(null);
  const view = manual && manual.layout === layout && manual.w === size.w && manual.h === size.h ? manual.view : fitted;

  const setView = useCallback(
    (update: (v: View) => View) =>
      setManual((m) => ({ layout, w: size.w, h: size.h, view: update(m && m.layout === layout && m.w === size.w && m.h === size.h ? m.view : fitted) })),
    [layout, size, fitted],
  );
  const fit = useCallback(() => setManual(null), []);

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      setView((v) => {
        const k = clamp(v.k * factor);
        return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
      });
    },
    [setView],
  );

  // Wheel zoom needs a non-passive listener to keep the page from scrolling while zooming the canvas.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - rect.left, event.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(p.x - q.x, p.y - q.y), k: view.k };
      drag.current = null;
      return;
    }
    if ((event.target as Element).closest("[data-graph-item]")) return; // clicks on nodes/edges select, not pan
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()];
      const rect = event.currentTarget.getBoundingClientRect();
      const k = clamp((pinch.current.k * Math.hypot(p.x - q.x, p.y - q.y)) / pinch.current.dist);
      zoomAt(k / view.k, (p.x + q.x) / 2 - rect.left, (p.y + q.y) / 2 - rect.top);
      return;
    }
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current;
    if (d && d.id === event.pointerId) {
      drag.current = null;
      if (!d.moved) onSelect(null); // a plain click on the background clears the selection
    }
  };

  const types = useMemo(() => [...new Set(edges.map((edge) => edge.relationshipType))], [edges]);

  return (
    <div ref={box} className="relative h-full w-full touch-none select-none overflow-hidden">
      <svg
        className="block h-full w-full cursor-grab active:cursor-grabbing"
        role="group"
        aria-label={`Repository graph: ${layout.nodes.length} symbols, ${edges.length} relationships. Use Tab to move between symbols and Enter to select.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          {types.map((type) => {
            const meta = typeMeta(type);
            const hollow = type === "EXTENDS" || type === "IMPLEMENTS";
            return (
              <marker key={type} id={`ofa-arrow-${type}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M1,1 L9,5 L1,9 z" style={{ fill: hollow ? "var(--bg)" : meta.color, stroke: meta.color }} strokeWidth={1.2} />
              </marker>
            );
          })}
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {layout.files.map((file) => (
            <g key={file.fileId} aria-hidden="true">
              <rect
                x={file.x - 12}
                y={file.y - 10}
                width={file.width + 24}
                height={file.height + 22}
                rx={12}
                style={{ fill: "var(--surface-2)", fillOpacity: 0.5, stroke: "var(--border)" }}
                strokeDasharray="4 4"
              />
              <text x={file.x} y={file.y + FILE_HEADER - 18} style={{ fill: "var(--fg-3)" }} fontSize={12} fontFamily="var(--font-geist-mono), monospace">
                {truncate(file.filePath, Math.max(16, Math.floor(file.width / 7.2)))}
              </text>
            </g>
          ))}
          <EdgeLayer edges={edges} byId={byId} selection={selection} onSelect={onSelect} />
          <NodeLayer nodes={layout.nodes} selection={selection} related={related} pending={pending} onSelect={onSelect} />
        </g>
      </svg>
      <div className="absolute right-3 bottom-3 flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-2 shadow-2">
        <CanvasButton label="Zoom in" onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)}>
          <IconPlus size={15} />
        </CanvasButton>
        <CanvasButton label="Zoom out" onClick={() => zoomAt(1 / 1.25, size.w / 2, size.h / 2)}>
          <IconMinus size={15} />
        </CanvasButton>
        <CanvasButton label="Fit graph to view" onClick={fit}>
          <IconFit size={15} />
        </CanvasButton>
      </div>
      <p className="pointer-events-none absolute bottom-3 left-3 rounded bg-bg/70 px-1.5 py-0.5 text-[11px] text-fg-3 tabular-nums">
        {Math.round(view.k * 100)}%
      </p>
    </div>
  );
}

function CanvasButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border"
    >
      {children}
    </button>
  );
}

const EdgeLayer = memo(function EdgeLayer({
  edges,
  byId,
  selection,
  onSelect,
}: {
  edges: GraphEdge[];
  byId: Map<string, PositionedNode>;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}) {
  return (
    <g>
      {edges.map((edge) => {
        const a = byId.get(edge.source);
        const b = byId.get(edge.target);
        if (!a || !b) return null; // both endpoints are always visible; defensive only
        const meta = typeMeta(edge.relationshipType);
        const { d, mx, my } = edgePath(a, b, LABEL_T[edge.relationshipType] ?? 0.5);
        const selected = selection?.type === "edge" && selection.id === edge.id;
        const touches = selection?.type === "node" && (edge.source === selection.id || edge.target === selection.id);
        const dim = selection !== null && !selected && !touches;
        const labelled = edge.relationshipType !== "CONTAINS";
        return (
          <g key={edge.id} data-graph-item="" opacity={dim ? 0.18 : 1}>
            <path
              d={d}
              fill="none"
              style={{ stroke: selected ? "var(--fg)" : meta.color }}
              strokeWidth={selected || touches ? meta.width + 0.75 : meta.width}
              strokeDasharray={meta.dash || undefined}
              markerEnd={`url(#ofa-arrow-${edge.relationshipType})`}
            />
            {labelled && (
              <text
                x={mx}
                y={my - 4}
                textAnchor="middle"
                fontSize={10.5}
                style={{ fill: meta.color, paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}
              >
                {meta.verb}
              </text>
            )}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={12}
              className="cursor-pointer"
              onClick={() => onSelect({ type: "edge", id: edge.id })}
            >
              <title>{`${a.label} ${meta.verb} ${b.label}`}</title>
            </path>
          </g>
        );
      })}
    </g>
  );
});

const NodeLayer = memo(function NodeLayer({
  nodes,
  selection,
  related,
  pending,
  onSelect,
}: {
  nodes: PositionedNode[];
  selection: Selection;
  related: ReadonlySet<string> | null;
  pending?: ReadonlyMap<string, number>;
  onSelect: (selection: Selection) => void;
}) {
  return (
    <g>
      {nodes.map((node) => {
        const meta = kindMeta(node.kind);
        const selected = selection?.type === "node" && selection.id === node.id;
        const dim = related !== null && !related.has(node.id);
        const glyphWidth = Math.max(22, meta.glyph.length * 7 + 10);
        const notLoaded = pending?.get(node.id) ?? 0;
        return (
          <g
            key={node.id}
            data-graph-item=""
            transform={`translate(${node.x},${node.y})`}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={`${meta.label} ${node.label}${node.qualifiedName ? `, ${node.qualifiedName}` : ""}, ${node.filePath} line ${node.startLine}${notLoaded > 0 ? `, ${notLoaded} relationships not loaded` : ""}`}
            className="group cursor-pointer outline-none"
            opacity={dim ? 0.3 : 1}
            onClick={() => onSelect({ type: "node", id: node.id })}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect({ type: "node", id: node.id });
              }
            }}
          >
            <title>{node.qualifiedName ?? node.label}</title>
            <rect
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              rx={9}
              className={cx("transition-[stroke] group-hover:[stroke:var(--fg-3)] group-focus-visible:[stroke:var(--accent)] group-focus-visible:[stroke-width:2.5]")}
              style={{ fill: selected ? "var(--surface-3)" : "var(--surface-2)", stroke: selected ? "var(--accent)" : "var(--border-strong)" }}
              strokeWidth={selected ? 2 : 1}
            />
            <rect x={8} y={11} width={glyphWidth} height={22} rx={5} style={{ fill: "var(--bg)", stroke: meta.color }} strokeWidth={1} />
            <text
              x={8 + glyphWidth / 2}
              y={26}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fontFamily="var(--font-geist-mono), monospace"
              style={{ fill: meta.color }}
            >
              {meta.glyph}
            </text>
            <text x={glyphWidth + 16} y={20} fontSize={12.5} fontWeight={500} style={{ fill: "var(--fg)" }}>
              {truncate(node.label, Math.floor((NODE_WIDTH - glyphWidth - 24) / 7))}
            </text>
            <text x={glyphWidth + 16} y={35} fontSize={10.5} style={{ fill: "var(--fg-3)" }}>
              {`${meta.label} · L${node.startLine}`}
            </text>
            {notLoaded > 0 && (
              <g transform={`translate(${NODE_WIDTH - 30},-8)`} aria-hidden="true">
                <rect width={34} height={16} rx={8} style={{ fill: "var(--bg)", stroke: "var(--warning)" }} strokeWidth={1} />
                <text x={17} y={11.5} textAnchor="middle" fontSize={10} fontWeight={600} style={{ fill: "var(--warning)" }}>
                  {`+${notLoaded > 99 ? "99" : notLoaded}`}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
});
