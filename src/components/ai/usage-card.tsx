import { Alert } from "@/components/ui/alert";
import { MetricCard } from "@/components/ui/data";
import { SectionHeader } from "@/components/ui/page";
import { providerLabel } from "@/lib/ai/present";
import type { MyAiUsage } from "@/server/ai/usage";

const n = (value: number) => value.toLocaleString("en-US");

// The dashboard's AI summary: the person's own finished runs of the last 30 days, from the persisted records. Token totals
// count only runs whose provider reported usage, savings are estimates (see lib/ai/measure.ts), and what is left out is
// said so. Nothing here is a sample value; with no runs there is nothing to show.
export function AiUsageCard({ usage }: { usage: MyAiUsage }) {
  if (!usage.ok) {
    return (
      <Alert tone="warning" title="AI usage unavailable" className="mt-6">
        Your recent AI usage could not be loaded.
      </Alert>
    );
  }
  const s = usage.summary;
  if (s.runs === 0) return null;
  const providers = Object.entries(s.byProvider)
    .map(([id, count]) => `${providerLabel(id)} ${count}`)
    .join(", ");
  return (
    <section className="mt-8" aria-labelledby="ai-usage-heading">
      <SectionHeader title={<span id="ai-usage-heading">Your AI usage</span>} description={`Your finished AI runs of the last ${usage.days} days.`} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Completed runs" value={n(s.completed)} hint={s.failedOrStopped > 0 ? `${n(s.failedOrStopped)} failed or stopped` : "none failed"} />
        <MetricCard
          label="Tokens used"
          value={s.reportedRuns > 0 ? n(s.inputTokens + s.outputTokens + s.thinkingTokens) : "n/a"}
          hint={
            s.reportedRuns > 0
              ? `${n(s.inputTokens)} in / ${n(s.outputTokens)} out, provider-reported${s.unreportedRuns > 0 ? `; ${n(s.unreportedRuns)} run(s) without usage left out` : ""}`
              : "No provider-reported usage yet"
          }
        />
        <MetricCard
          label="Estimated tokens saved"
          value={s.savedRuns === 0 ? "n/a" : s.tokensSaved > 0 ? n(s.tokensSaved) : "None"}
          hint={
            s.savedRuns === 0 || s.reductionPercent === null
              ? "Not measurable yet"
              : s.tokensSaved > 0
                ? `${s.reductionPercent}% vs sending the whole snapshot, over ${n(s.savedRuns)} run(s); estimated`
                : `Over ${n(s.savedRuns)} run(s) the requests were no smaller than sending the whole snapshot (small snapshots); estimated`
          }
        />
        <MetricCard label="Fallbacks" value={n(s.fallbackRuns)} hint={providers ? `Answered by ${providers}` : undefined} />
      </div>
      <p className="t-small mt-2 text-fg-3">
        Totals cover successful runs only; tokens of failed or stopped runs ({n(s.tokensInUnfinishedRuns)}) and of failed retry calls (not reported by providers) are not included.
        {s.unknownCostRuns > 0 ? "" : s.completed > 0 ? ` Estimated cost $${s.costUsd.toFixed(4)}.` : ""}
      </p>
    </section>
  );
}
