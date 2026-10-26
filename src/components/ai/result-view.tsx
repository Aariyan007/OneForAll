"use client";

import { Fragment, type ReactNode, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";

// Renders a validated AI result. Text from the model is shown as React text nodes only (a tiny markdown subset:
// paragraphs, fenced code, `inline code`, **bold**); nothing is ever injected as HTML.

type Location = { path: string; startLine: number; endLine: number };

export type ResultProps = {
  job: string;
  output: Record<string, unknown>;
  viewerHref: (location: Location) => string;
};

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="rounded bg-bg-subtle px-1 py-0.5 font-mono text-[12px] text-fg">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function RichText({ text }: { text: string }) {
  const blocks = text.split(/```[\w-]*\n?/);
  return (
    <div className="flex flex-col gap-2 text-[13.5px] leading-relaxed text-fg">
      {blocks.map((block, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="overflow-x-auto rounded-md border border-border bg-bg-subtle p-3 font-mono text-[12px]">
            {block.replace(/\n$/, "")}
          </pre>
        ) : (
          block
            .split(/\n{2,}/)
            .filter((p) => p.trim().length > 0)
            .map((paragraph, j) => (
              <p key={`${i}-${j}`} className="whitespace-pre-wrap">
                {inline(paragraph)}
              </p>
            ))
        ),
      )}
    </div>
  );
}

function LocationLink({ location, viewerHref }: { location: Location; viewerHref: ResultProps["viewerHref"] }) {
  const range = location.startLine === location.endLine ? `${location.startLine}` : `${location.startLine}-${location.endLine}`;
  return (
    <a href={viewerHref(location)} target="_blank" rel="noopener" className="font-mono text-[12px] text-accent hover:underline">
      {location.path}:{range}
    </a>
  );
}

const SEVERITY_TONE: Record<string, "danger" | "warning" | "neutral" | "info"> = {
  critical: "danger",
  high: "danger",
  medium: "warning",
  low: "neutral",
  info: "info",
};

function Meta({ output }: { output: Record<string, unknown> }) {
  const missing = (output.missingContext as string[] | undefined) ?? [];
  return (
    <div className="flex flex-col gap-2">
      {typeof output.confidence === "string" && (
        <div className="text-[12.5px] text-fg-3">
          Confidence: <Badge tone={output.confidence === "high" ? "success" : output.confidence === "medium" ? "warning" : "neutral"}>{output.confidence}</Badge>
        </div>
      )}
      {missing.length > 0 && (
        <div className="text-[12.5px] text-fg-3">
          <span className="font-medium text-fg-2">Not found in the snapshot:</span>
          <ul className="ml-4 list-disc">
            {missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Citations({ items, viewerHref }: { items: Location[]; viewerHref: ResultProps["viewerHref"] }) {
  if (items.length === 0) return <p className="text-[12.5px] text-fg-3">No verified source references.</p>;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {items.map((c, i) => (
        <LocationLink key={i} location={c} viewerHref={viewerHref} />
      ))}
    </div>
  );
}

function GeneratedFile({ output }: { output: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);
  const content = String(output.content ?? "");
  const filename = String(output.filename ?? "generated.txt");
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.split("/").pop() || "generated.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[12.5px] text-fg">{filename}</span>
        <span className="flex gap-2">
          <button
            type="button"
            className={buttonClass("secondary", "sm")}
            onClick={() => navigator.clipboard?.writeText(content).then(() => setCopied(true)).catch(() => setCopied(false))}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className={buttonClass("secondary", "sm")} onClick={download}>
            Download
          </button>
        </span>
      </div>
      <pre className="max-h-[480px] overflow-auto rounded-md border border-border bg-bg-subtle p-3 font-mono text-[12px] text-fg">{content}</pre>
    </div>
  );
}

export function ResultView({ job, output, viewerHref }: ResultProps) {
  if (job === "code_qa") {
    return (
      <div className="flex flex-col gap-4">
        <RichText text={String(output.answer ?? "")} />
        <Citations items={(output.citations as Location[]) ?? []} viewerHref={viewerHref} />
        <Meta output={output} />
      </div>
    );
  }
  if (job === "requirement_trace") {
    const links = (output.links as (Location & { role: string; symbol?: string; evidence: string })[]) ?? [];
    const gaps = (output.gaps as { description: string; severity: string }[]) ?? [];
    return (
      <div className="flex flex-col gap-4">
        <RichText text={String(output.summary ?? "")} />
        <div>
          <h3 className="mb-2 text-[13px] font-medium text-fg">Implementing code ({links.length})</h3>
          {links.length === 0 ? (
            <p className="text-[12.5px] text-fg-3">No verified links.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {links.map((l, i) => (
                <li key={i} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={l.role === "implements" ? "success" : l.role === "tests" ? "info" : "neutral"}>{l.role.replace("_", " ")}</Badge>
                    <LocationLink location={l} viewerHref={viewerHref} />
                    {l.symbol && <span className="font-mono text-[12px] text-fg-3">{l.symbol}</span>}
                  </div>
                  <p className="mt-1 text-[13px] text-fg-2">{l.evidence}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-[13px] font-medium text-fg">Gaps ({gaps.length})</h3>
          {gaps.length === 0 ? (
            <p className="text-[12.5px] text-fg-3">No gaps reported.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {gaps.map((g, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px] text-fg-2">
                  <Badge tone={SEVERITY_TONE[g.severity] ?? "neutral"}>{g.severity}</Badge>
                  <span>{g.description}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Meta output={output} />
      </div>
    );
  }
  if (job === "code_review") {
    const findings = (output.findings as (Location & { title: string; severity: string; explanation: string; suggestion: string })[]) ?? [];
    return (
      <div className="flex flex-col gap-4">
        <RichText text={String(output.summary ?? "")} />
        {findings.length === 0 ? (
          <p className="text-[12.5px] text-fg-3">No verified findings.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {findings.map((f, i) => (
              <li key={i} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEVERITY_TONE[f.severity] ?? "neutral"}>{f.severity}</Badge>
                  <span className="text-[13.5px] font-medium text-fg">{f.title}</span>
                  <LocationLink location={f} viewerHref={viewerHref} />
                </div>
                <div className="mt-2 text-[13px] text-fg-2">
                  <RichText text={f.explanation} />
                </div>
                {f.suggestion && (
                  <div className="mt-2 border-l-2 border-accent/40 pl-3 text-[13px] text-fg-2">
                    <span className="text-[12px] font-medium uppercase tracking-wide text-fg-3">Suggestion (not applied)</span>
                    <RichText text={f.suggestion} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <Meta output={output} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {typeof output.notes === "string" && output.notes.length > 0 && <RichText text={output.notes} />}
      <GeneratedFile output={output} />
      <Citations items={(output.citations as Location[]) ?? []} viewerHref={viewerHref} />
      <Meta output={output} />
    </div>
  );
}
