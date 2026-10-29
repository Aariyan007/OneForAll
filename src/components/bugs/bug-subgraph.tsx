import Link from "next/link";
import type { BugSubgraph, SubgraphEdge, SubgraphNode } from "@/server/bugs/detail";

// The task-specific graph of one bug. Deterministic three-column layout: files that import the bug's file on the left,
// the bug, its file and the symbols around the bug in the middle, the files it imports and the applied fix on the right.
// Server-rendered SVG with links: file nodes open the stored file at the right line. Only stored relations are drawn.

const W = 168;
const H = 38;
const COLS = { left: 12, mid: 262, right: 512 };
const EDGE_STYLE: Record<SubgraphEdge["type"], { color: string; dash: string; label: string }> = {
  ASSOCIATED_WITH: { color: "var(--danger)", dash: "", label: "associated with" },
  CONTAINS: { color: "var(--border-strong)", dash: "", label: "contains" },
  IMPORTS: { color: "var(--info)", dash: "6 4", label: "imports" },
  FIXED_BY: { color: "var(--success)", dash: "2 3", label: "fixed by" },
};
const KIND_FILL: Record<SubgraphNode["kind"], string> = { bug: "var(--danger)", file: "var(--surface-2)", symbol: "var(--surface-3)", fix: "var(--success)" };

export function BugSubgraphView({ graph, filesUrl, centerPath }: { graph: BugSubgraph; filesUrl: string; centerPath: string }) {
  const center = `f:${centerPath}`;
  const importers = graph.edges.filter((e) => e.type === "IMPORTS" && e.to === center).map((e) => e.from);
  const imported = graph.edges.filter((e) => e.type === "IMPORTS" && e.from === center).map((e) => e.to);
  const symbols = graph.nodes.filter((n) => n.kind === "symbol").map((n) => n.id);
  const pos = new Map<string, { x: number; y: number }>();
  pos.set("bug", { x: COLS.mid, y: 14 });
  pos.set(center, { x: COLS.mid, y: 90 });
  symbols.forEach((id, i) => pos.set(id, { x: COLS.mid, y: 166 + i * 52 }));
  importers.forEach((id, i) => pos.set(id, { x: COLS.left, y: 40 + i * 52 }));
  imported.forEach((id, i) => pos.set(id, { x: COLS.right, y: 40 + i * 52 }));
  if (graph.nodes.some((n) => n.id === "fix")) pos.set("fix", { x: COLS.right, y: 14 });
  const rows = Math.max(...[...pos.values()].map((p) => p.y)) + H + 16;
  const drawn = graph.nodes.filter((n) => pos.has(n.id));

  return (
    <div>
      <svg viewBox={`0 0 ${COLS.right + W + 12} ${rows}`} className="w-full" role="img" aria-label="Subgraph of this bug">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" fill="var(--fg-3)" />
          </marker>
        </defs>
        {graph.edges.map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const style = EDGE_STYLE[e.type];
          const sameColumn = a.x === b.x;
          const x1 = sameColumn ? a.x + W / 2 : a.x < b.x ? a.x + W : a.x;
          const x2 = sameColumn ? b.x + W / 2 : a.x < b.x ? b.x : b.x + W;
          const y1 = sameColumn ? (a.y < b.y ? a.y + H : a.y) : a.y + H / 2;
          const y2 = sameColumn ? (a.y < b.y ? b.y : b.y + H) : b.y + H / 2;
          return (
            <g key={`${e.from}>${e.to}>${e.type}`}>
              <path d={`M${x1} ${y1} C${sameColumn ? x1 : (x1 + x2) / 2} ${sameColumn ? (y1 + y2) / 2 : y1} ${sameColumn ? x2 : (x1 + x2) / 2} ${sameColumn ? (y1 + y2) / 2 : y2} ${x2} ${y2}`} fill="none" stroke={style.color} strokeWidth={1.5} strokeDasharray={style.dash} markerEnd="url(#arrow)" />
              <title>{`${e.from} ${style.label} ${e.to}`}</title>
            </g>
          );
        })}
        {drawn.map((n) => {
          const p = pos.get(n.id)!;
          const inner = (
            <g transform={`translate(${p.x} ${p.y})`}>
              <rect width={W} height={H} rx={8} fill={KIND_FILL[n.kind]} fillOpacity={n.kind === "bug" || n.kind === "fix" ? 0.22 : 1} stroke={n.kind === "bug" ? "var(--danger)" : n.kind === "fix" ? "var(--success)" : "var(--border-strong)"} strokeWidth={n.id === center ? 2 : 1} />
              <text x={9} y={15} fontSize={11.5} fontWeight={600} fill="var(--fg)">
                {(n.kind === "bug" ? "BUG: " : n.kind === "symbol" ? "ƒ " : "") + (n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label)}
              </text>
              <text x={9} y={29} fontSize={10} fill="var(--fg-3)">
                {(n.detail ?? "").length > 28 ? `…${(n.detail ?? "").slice(-27)}` : (n.detail ?? "")}
              </text>
              {n.bugs ? (
                <g>
                  <circle cx={W - 12} cy={12} r={8} fill="var(--danger)" />
                  <text x={W - 12} y={15.5} fontSize={10} fill="#fff" textAnchor="middle">
                    {n.bugs}
                  </text>
                </g>
              ) : null}
              <title>{`${n.label}${n.detail ? ` — ${n.detail}` : ""}${n.bugs ? ` — ${n.bugs} other open bug(s)` : ""}`}</title>
            </g>
          );
          return n.path ? (
            <Link key={n.id} href={`${filesUrl}?${new URLSearchParams({ path: n.path, ...(n.line ? { from: String(n.line), to: String(n.line) } : {}) })}`}>
              {inner}
            </Link>
          ) : (
            <g key={n.id}>{inner}</g>
          );
        })}
        <text x={COLS.left} y={14} fontSize={10.5} fill="var(--fg-3)">
          imported by
        </text>
        <text x={COLS.right} y={rows - 4} fontSize={10.5} fill="var(--fg-3)">
          imports
        </text>
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-fg-3">
        {(Object.keys(EDGE_STYLE) as SubgraphEdge["type"][]).map((t) => (
          <li key={t} className="flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="22" y2="3" stroke={EDGE_STYLE[t].color} strokeWidth="2" strokeDasharray={EDGE_STYLE[t].dash} />
            </svg>
            {t.replace(/_/g, " ").toLowerCase()}
          </li>
        ))}
      </ul>
      {graph.note && <p className="mt-1 text-[12px] text-fg-3">{graph.note}</p>}
    </div>
  );
}
