// Live evaluation of the AI jobs against the fixture repository (fixtures/ai-eval). Calls the real Gemini API with the
// key in .env.local, so it costs quota; it never touches the database. Each task runs in two context modes:
//   retrieval  the production path: deterministic retrieval within a token budget, plus read-only tools
//   naive      baseline: the whole repository in context, no tools
// Usage:  npm run ai:eval [-- --only=qa-overdue,trace-reminders] [--modes=retrieval,naive]
// Writes docs/testing/ai-eval-results.json and prints a summary. Numbers are whatever the provider reported.
import fs from "node:fs";
import path from "node:path";
import { scoreResult, type Expectation } from "../src/server/ai/eval-score";
import { modelRegistry } from "../src/server/ai/models";
import { type RunOutcome, runJob } from "../src/server/ai/orchestrator";
import { createGeminiProvider } from "../src/server/ai/provider/gemini-client";
import { checkSyntax } from "../src/server/ai/syntax";
import { memoryReader } from "../src/server/ai/test-support";
import type { RequirementInfo, SymbolHit } from "../src/server/ai/tools";
import type { JobType } from "../src/server/ai/types";
import { detectLanguage } from "../src/server/repository-files/manifest";
import { getParserAdapter } from "../src/server/repository-structure/parser-registry";

const ROOT = path.resolve(__dirname, "..");
const REPO = path.join(ROOT, "fixtures/ai-eval/sample-repo");

type Task = { id: string; job: JobType; input: Record<string, unknown>; expect: Expectation };
type Mode = "retrieval" | "naive";

function readEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const file = path.join(ROOT, ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && env[match[1]] === undefined) env[match[1]] = match[2].trim();
    }
  }
  return env;
}

function walk(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, walk(path.join(dir, entry.name), rel));
    else files[rel] = fs.readFileSync(path.join(dir, entry.name), "utf8");
  }
  return files;
}

async function symbolsOf(files: Record<string, string>): Promise<SymbolHit[]> {
  const symbols: SymbolHit[] = [];
  for (const [file, source] of Object.entries(files)) {
    const adapter = getParserAdapter(detectLanguage(file));
    if (!adapter) continue;
    const parsed = await adapter.parse({ path: file, source });
    if (!parsed.ok) continue;
    for (const s of parsed.structure.symbols) {
      symbols.push({ name: s.name, kind: s.kind, qualifiedName: s.qualifiedName, path: file, line: s.range.startLine + 1, signature: s.signature });
    }
  }
  return symbols;
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const env = readEnv();
  const registry = modelRegistry(env);
  if (!registry.configured) throw new Error("GEMINI_API_KEY is not set in .env.local");
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures/ai-eval/tasks.json"), "utf8")) as { requirement: RequirementInfo & { id: string }; tasks: Task[] };
  const only = arg("only")?.split(",");
  const modes = (arg("modes")?.split(",") ?? ["retrieval", "naive"]) as Mode[];
  const tasks = spec.tasks.filter((t) => !only || only.includes(t.id));
  const files = walk(REPO);
  const symbols = await symbolsOf(files);
  const provider = createGeminiProvider(registry.apiKey!);

  const runs: Record<string, unknown>[] = [];
  for (const task of tasks) {
    for (const mode of modes) {
      const reader = memoryReader(files, { symbols, requirements: { [spec.requirement.id]: spec.requirement } });
      const started = Date.now();
      let outcome: RunOutcome;
      try {
        outcome = await runJob(
          {
            provider,
            registry,
            reader,
            store: { transition: async () => {}, cancelRequested: async () => false },
            now: Date.now,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            syntaxCheck: checkSyntax,
          },
          task.job,
          task.input,
          { signal: new AbortController().signal, contextMode: mode },
        );
      } catch (error) {
        console.error(`${task.id} ${mode}: harness error`, error);
        continue;
      }
      const score = scoreResult(task.job, outcome.result ?? null, task.expect, outcome.syntaxValid ?? null);
      const row = {
        task: task.id,
        job: task.job,
        mode,
        status: outcome.status,
        error: outcome.error?.category ?? null,
        checksPassed: score.passed,
        checksTotal: score.total,
        failures: score.failures,
        tier: outcome.tier ?? null,
        model: outcome.model ?? null,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        cachedInputTokens: outcome.usage.cachedInputTokens,
        thinkingTokens: outcome.usage.thinkingTokens,
        contextTokensEstimate: outcome.contextTokensEstimate,
        modelCalls: outcome.turns,
        toolCalls: outcome.toolCalls,
        attempts: outcome.attempts,
        fallback: outcome.fallback,
        citationsDropped: outcome.citationsDropped,
        syntaxValid: outcome.syntaxValid ?? null,
        costUsd: outcome.costUsd,
        latencyMs: Date.now() - started,
      };
      runs.push(row);
      console.log(
        `${task.id.padEnd(24)} ${mode.padEnd(9)} ${outcome.status.padEnd(9)} checks ${score.passed}/${score.total} in ${row.inputTokens} out ${row.outputTokens} calls ${row.modelCalls} tools ${row.toolCalls} ${row.model} ${(row.latencyMs / 1000).toFixed(1)}s${score.failures.length ? `  [${score.failures.join("; ")}]` : ""}`,
      );
      await new Promise((r) => setTimeout(r, 4000)); // spread requests for the free-tier rate limit
    }
  }

  const output = { ranAt: new Date().toISOString(), models: { fast: registry.models.fast.id, standard: registry.models.standard.id }, runs };
  const target = path.join(ROOT, "docs/testing/ai-eval-results.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(ROOT, target)} (${runs.length} runs)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
