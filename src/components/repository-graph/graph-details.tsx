"use client";

import { Badge } from "@/components/ui/badge";
import { IconArrowLeft, IconArrowRight, IconFileCode, IconFocus, IconLink, IconSymbol } from "@/components/ui/icons";
import type { GraphEdge, GraphNode, RepositoryGraph } from "@/lib/repository-graph/types";
import { neighbourhood } from "@/lib/repository-graph/view";
import type { Selection } from "./graph-canvas";
import { kindMeta, typeMeta } from "./graph-style";

// Read-only inspector for the selected symbol or relationship. Shows only stored fields; anything missing is shown as
// "Not available", never inferred.

const UNAVAILABLE = <span className="text-fg-3">Not available</span>;

export function GraphDetails({
  graph,
  nodesById,
  selection,
  visibleIds,
  focused,
  onSelect,
  onFocus,
}: {
  graph: RepositoryGraph;
  nodesById: Map<string, GraphNode>;
  selection: Selection;
  visibleIds: ReadonlySet<string>;
  focused: boolean;
  onSelect: (selection: Selection) => void;
  onFocus: (nodeId: string | null) => void;
}) {
  if (selection === null) {
    return (
      <div className="px-5 py-6 text-center">
        <span className="mx-auto mb-3 inline-flex size-9 items-center justify-center rounded-lg border border-border-strong bg-surface-2 text-fg-3">
          <IconSymbol size={16} />
        </span>
        <p className="t-h3 text-fg">Nothing selected</p>
        <p className="t-small mt-1 text-fg-3">Select a symbol or a relationship in the graph, or search for a symbol by name.</p>
      </div>
    );
  }

  if (selection.type === "edge") {
    const edge = graph.edges.find((e) => e.id === selection.id);
    if (!edge) return null;
    const meta = typeMeta(edge.relationshipType);
    const source = nodesById.get(edge.source)!;
    const target = nodesById.get(edge.target)!;
    return (
      <div className="flex flex-col gap-4 px-5 py-4">
        <div>
          <p className="t-caption text-fg-3">Relationship</p>
          <p className="t-h2 mt-1 flex items-center gap-2 text-fg">
            <IconLink size={15} className="text-fg-3" />
            {meta.label}
          </p>
          <p className="t-small mt-1 text-fg-3">Direction: {meta.direction}</p>
        </div>
        <SymbolButton label="Source" node={source} onSelect={onSelect} />
        <SymbolButton label="Target" node={target} onSelect={onSelect} />
        <p className="t-small rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-fg-2">
          <span className="text-fg">{source.label}</span> {meta.verb} <span className="text-fg">{target.label}</span>
        </p>
      </div>
    );
  }

  const node = nodesById.get(selection.id);
  if (!node) return null;
  const meta = kindMeta(node.kind);
  const { incoming, outgoing } = neighbourhood(graph, node.id);
  const hidden = !visibleIds.has(node.id);

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="accent">{meta.label}</Badge>
          {node.visibility && node.visibility !== "UNKNOWN" && <Badge tone="muted">{node.visibility.toLowerCase()}</Badge>}
        </div>
        <p className="t-h2 mt-2 break-words text-fg">{node.label}</p>
        {hidden && (
          <p className="t-small mt-1.5 text-warning">Hidden by the current filters. Reset the filters or choose its file to see it in the graph.</p>
        )}
      </div>

      <dl className="flex flex-col gap-2.5 text-[12.5px]">
        <Field label="Qualified name">{node.qualifiedName ? <span className="break-all font-mono text-fg">{node.qualifiedName}</span> : UNAVAILABLE}</Field>
        <Field label="File">
          <span className="inline-flex min-w-0 items-start gap-1.5 break-all font-mono text-fg">
            <IconFileCode size={13} className="mt-0.5 shrink-0 text-fg-3" />
            {node.filePath}
          </span>
        </Field>
        <Field label="Lines">
          <span className="tabular-nums text-fg">{node.startLine === node.endLine ? `${node.startLine}` : `${node.startLine}–${node.endLine}`}</span>
        </Field>
        <Field label="Signature">
          {node.signature ? <code className="block break-words rounded bg-bg px-2 py-1 font-mono text-[11.5px] text-fg-2">{node.signature}</code> : UNAVAILABLE}
        </Field>
        <Field label="Visibility">{node.visibility && node.visibility !== "UNKNOWN" ? <span className="text-fg">{node.visibility.toLowerCase()}</span> : UNAVAILABLE}</Field>
      </dl>

      <button
        type="button"
        onClick={() => onFocus(focused ? null : node.id)}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg"
      >
        <IconFocus size={14} />
        {focused ? "Show full graph" : "Focus on direct neighbours"}
      </button>

      <EdgeList title="Outgoing" icon={<IconArrowRight size={13} />} edges={outgoing} nodesById={nodesById} side="target" onSelect={onSelect} />
      <EdgeList title="Incoming" icon={<IconArrowLeft size={13} />} edges={incoming} nodesById={nodesById} side="source" onSelect={onSelect} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
      <dt className="text-fg-3">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function SymbolButton({ label, node, onSelect }: { label: string; node: GraphNode; onSelect: (selection: Selection) => void }) {
  const meta = kindMeta(node.kind);
  return (
    <div>
      <p className="t-caption mb-1 text-fg-3">{label}</p>
      <button
        type="button"
        onClick={() => onSelect({ type: "node", id: node.id })}
        className="flex w-full min-w-0 flex-col items-start rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-left transition-colors hover:border-border-strong hover:bg-surface-2"
      >
        <span className="w-full truncate text-[13px] font-medium text-fg">{node.label}</span>
        <span className="w-full truncate text-[11.5px] text-fg-3">
          {meta.label} · {node.filePath}:{node.startLine}
        </span>
      </button>
    </div>
  );
}

function EdgeList({
  title,
  icon,
  edges,
  nodesById,
  side,
  onSelect,
}: {
  title: string;
  icon: React.ReactNode;
  edges: GraphEdge[];
  nodesById: Map<string, GraphNode>;
  side: "source" | "target";
  onSelect: (selection: Selection) => void;
}) {
  return (
    <div>
      <p className="t-caption mb-1.5 flex items-center gap-1.5 text-fg-3">
        {icon}
        {title} <span className="tabular-nums">({edges.length})</span>
      </p>
      {edges.length === 0 ? (
        <p className="t-small text-fg-3">None stored.</p>
      ) : (
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
          {edges.map((edge) => {
            const other = nodesById.get(side === "target" ? edge.target : edge.source)!;
            const meta = typeMeta(edge.relationshipType);
            return (
              <li key={edge.id} className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onSelect({ type: "edge", id: edge.id })}
                  className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-2 transition-colors hover:border-border-strong hover:text-fg"
                  title={`Select this ${meta.verb} relationship`}
                >
                  {meta.verb}
                </button>
                <button
                  type="button"
                  onClick={() => onSelect({ type: "node", id: other.id })}
                  className="min-w-0 truncate rounded px-1.5 py-0.5 text-left text-[12.5px] text-fg transition-colors hover:bg-surface-2"
                  title={other.qualifiedName ?? other.label}
                >
                  {other.label}
                  <span className="ml-1.5 text-[11px] text-fg-3">{kindMeta(other.kind).label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
