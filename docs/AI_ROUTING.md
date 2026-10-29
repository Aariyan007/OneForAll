# AI provider routing, failover and token metrics

All AI work (assistant, bug scans, fix plans) runs through one path: `executeRun` → `runJob` (`src/server/ai/`). Providers are
Gemini, Groq and OpenRouter. Keys are server-side environment variables only (see `.env.example`); nothing here is sent to the browser.

## Providers and models

| Provider | Key | Default models (fast / standard) | Context | API |
| --- | --- | --- | --- | --- |
| Gemini | `GEMINI_API_KEY` | `gemini-3.5-flash-lite` / `gemini-3.8-flash` | 1M | `@google/genai` |
| Groq | `GROQ_API_KEY` | `openai/gpt-oss-20b` / `openai/gpt-oss-120b` | 131k | OpenAI-compatible chat completions, `fetch` |
| OpenRouter | `OPENROUTER_API_KEY` | `openai/gpt-oss-20b` / `openai/gpt-oss-120b` | 131k | same adapter, OpenRouter base URL |

Defaults and prices were read from Groq's models page and OpenRouter's API docs on 2026-10-29. Model ids can be overridden with
`GROQ_MODEL_FAST/STANDARD`, `OPENROUTER_MODEL_FAST/STANDARD` and (Gemini) `AI_MODEL_FAST/STANDARD`; an id that is not a plausible
model id disables that provider and is reported. A provider whose key is empty is skipped, never called.

## Routing (`routing.ts`)

A job and the existing tier decision give a category. The category fixes the provider order; availability, context size and
cooldowns then remove providers. Nothing else chooses a provider.

| Category | Jobs | Order | Why |
| --- | --- | --- | --- |
| `simple_qa` | short `code_qa` | Groq, Gemini, OpenRouter | lowest latency and price |
| `repository_analysis` | longer `code_qa`, `requirement_trace`, `code_review` | Gemini, Groq, OpenRouter | largest context window |
| `bug_analysis` | `bug_scan` | Gemini, Groq, OpenRouter | many files, reliable JSON |
| `code_generation` | `generate` | Gemini, OpenRouter, Groq | reliable structured code output |
| `fix_planning` | `bug_fix_plan` | Gemini, Groq, OpenRouter | code reasoning, reliable JSON |

Gemini keeps its own cheaper-tier fallback (standard, then fast). A model is skipped when the needed context (context + prompt
overhead + reserved output + margin) exceeds its window, when it lacks tool or JSON support, or while it is cooling down.

## Failover (`orchestrator.ts`, `retry.ts`)

* Transient failures (`rate_limited`, `unavailable`, `network`) are retried up to 3 calls per candidate with exponential backoff and
  jitter, or the provider's Retry-After. With another provider still available a rate limit is not waited out.
* `quota`, `timeout`, `unsupported_model` and `bad_output` (empty or malformed response) go straight to the next candidate.
* `auth`, `invalid_request` and `context_overflow` are never retried and only another provider is tried; a context overflow also
  rules out models with no larger window.
* A candidate that fails for good is skipped for the rest of the run. Safety blocks end the run.
* Cooldowns (in memory, per process) remember a rejected key (10 min), an unsupported model (1 h), a spent quota (15 min) and a rate
  limit (Retry-After, 1-5 min) so the next run starts elsewhere. They never leave a plan empty: with one provider it is tried again.
* All failed: the run is `failed` with the last failure's category and a safe message. No answer is ever produced without a provider.
* A fallback changes nothing but the provider: same run row, same lifecycle states, same validation, and the fix workflow still ends
  in a plan that a person approves (no model applies anything).

## What is recorded and shown

Per run (`ai_runs`, migration `20261030000001`): provider, model, `usage_reported`, token counts, `cost_known`, estimated cost,
attempts and the routing trail (`route`), `baseline_tokens_estimate`, `techniques`.

* **Provider-reported** tokens come from the provider's own usage object. If it sends none, `usage_reported` is false and the UI says
  "not reported", not 0. Failed calls report no tokens, so they are in the trail but not in the totals.
* **Cost**: OpenRouter's own `usage.cost`, else the Gemini/Groq price table; an unknown price is "unavailable", not free.
* **Savings** compare an *estimate* of sending the whole stored snapshot in one request (characters / 4 of every text file) with the run's
  actual input tokens. Because the baseline is an estimate, savings are always labelled estimated; a run that used more than the
  baseline shows "No saving". No baseline, no savings figure.
* **Dashboard** ("Your AI usage"): the signed-in person's own finished runs of the last 30 days. Token totals cover completed runs with
  reported usage; unreported runs, failed-run tokens and unknown costs are stated, not added. Runs recorded before this migration have
  no baseline, so they contribute no savings.
