import type { ProviderId, Usage } from "../types";
import { type FinishReason, LlmError, type LlmProvider, type LlmRequest, type LlmResponse, type LlmToolCall, type LlmTurn } from "./types";

// Adapter for OpenAI-compatible chat-completions APIs: Groq (https://api.groq.com/openai/v1) and OpenRouter
// (https://openrouter.ai/api/v1). Plain `fetch`, no SDK. Import it through ./hosted (server-only guard) in the app; the key
// is a parameter, never read here, so it reaches the browser only if a caller sends it there.
//
// Structured output: the schema goes into the system prompt and `response_format: json_object` is set. Not every model
// behind these APIs enforces `json_schema`, and the orchestrator validates every answer against the job's schema anyway
// (with one correction turn), so one portable mechanism beats per-model branches.
//
// Provider text is matched to classify a failure but never copied into the error: it can echo request details.

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export type OpenAiCompatibleConfig = {
  name: Exclude<ProviderId, "gemini">;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  // Groq's current name for the output cap is max_completion_tokens; OpenRouter documents max_tokens.
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  fetchImpl?: FetchLike;
};

type ApiToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };
type ApiMessage = { role: string; content?: string | { type?: string; text?: string }[] | null; tool_calls?: ApiToolCall[] };
type ApiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
};

// What a model turn keeps as `raw`: the assistant message exactly as the API returned it, tagged with the provider that
// produced it. A turn tagged with another provider (or by Gemini) is replayed as plain text, see toMessages().
type NativeRaw = { provider: ProviderId; message: ApiMessage };

function isNative(raw: unknown, provider: ProviderId): raw is NativeRaw {
  return typeof raw === "object" && raw !== null && (raw as NativeRaw).provider === provider && typeof (raw as NativeRaw).message === "object";
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

// Replays a model turn produced by another provider as text: its tool calls cannot be matched to this API's call ids, so
// the exchange is described instead of re-sent as a structured call.
function describeForeignModelTurn(turn: Extract<LlmTurn, { role: "model" }>): string {
  const calls = turn.toolCalls.map((c) => `${c.name}(${clip(JSON.stringify(c.args), 300)})`);
  return [turn.text, calls.length > 0 ? `[Called tools: ${calls.join("; ")}]` : null].filter(Boolean).join("\n") || "[no reply]";
}

export function toMessages(request: LlmRequest, provider: ProviderId): Record<string, unknown>[] {
  const system = request.responseJsonSchema
    ? `${request.system}\n\nReply with ONLY a JSON object that conforms to this JSON schema, with no other text:\n${JSON.stringify(request.responseJsonSchema)}`
    : request.system;
  const messages: Record<string, unknown>[] = [{ role: "system", content: system }];
  // Whether the model turn before a tool turn can be replayed natively: its tool results then go back as `tool` messages.
  let nativeBefore = false;
  for (const turn of request.turns) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.text });
    } else if (turn.role === "model") {
      nativeBefore = isNative(turn.raw, provider);
      if (isNative(turn.raw, provider)) {
        const { content, tool_calls } = turn.raw.message;
        messages.push({ role: "assistant", content: content ?? null, ...(tool_calls?.length ? { tool_calls } : {}) });
      } else {
        messages.push({ role: "assistant", content: describeForeignModelTurn(turn) });
      }
    } else if (nativeBefore) {
      for (const r of turn.results) messages.push({ role: "tool", tool_call_id: r.id ?? r.name, content: clip(JSON.stringify(r.result), 60_000) });
    } else {
      messages.push({ role: "user", content: `Results of the tools you called:\n${turn.results.map((r) => `${r.name}: ${clip(JSON.stringify(r.result), 20_000)}`).join("\n")}` });
    }
  }
  return messages;
}

function responseText(content: ApiMessage["content"]): string | null {
  if (typeof content === "string") return content.length > 0 ? content : null;
  if (Array.isArray(content)) {
    const text = content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
    return text.length > 0 ? text : null;
  }
  return null;
}

const FINISH: Record<string, FinishReason> = { stop: "stop", tool_calls: "stop", function_call: "stop", length: "max_tokens", content_filter: "safety" };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

// Provider-reported usage. Missing or malformed usage is reported as unavailable rather than as zeros.
export function mapUsage(usage: ApiUsage | null | undefined): { usage: Usage; reported: boolean; costUsd?: number } {
  if (!usage || !finite(usage.prompt_tokens) || !finite(usage.completion_tokens)) {
    return { usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, thinkingTokens: 0 }, reported: false };
  }
  const reasoning = finite(usage.completion_tokens_details?.reasoning_tokens) ? Math.min(usage.completion_tokens_details.reasoning_tokens, usage.completion_tokens) : 0;
  const cached = finite(usage.prompt_tokens_details?.cached_tokens) ? Math.min(usage.prompt_tokens_details.cached_tokens, usage.prompt_tokens) : 0;
  return {
    // completion_tokens counts reasoning tokens in these APIs; they are split out so input + output + thinking is the total.
    usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens - reasoning, cachedInputTokens: cached, thinkingTokens: reasoning },
    reported: true,
    costUsd: finite(usage.cost) ? usage.cost : undefined,
  };
}

type ErrorBody = { error?: { message?: unknown; code?: unknown; metadata?: { raw?: unknown } } | string };

function errorText(body: ErrorBody | null): string {
  if (!body) return "";
  if (typeof body.error === "string") return body.error.slice(0, 1000);
  const parts = [body.error?.message, body.error?.metadata?.raw].filter((p): p is string => typeof p === "string");
  return parts.join(" ").slice(0, 1000);
}

// Pure mapping from an HTTP failure to the provider-neutral error. `retryAfter` is the Retry-After header, in seconds.
export function mapHttpError(status: number, body: ErrorBody | null, retryAfter: string | null): LlmError {
  const text = errorText(body);
  if (status === 401 || status === 403) return new LlmError("auth", "The provider rejected the credentials.");
  if (status === 402) return new LlmError("quota", "The provider account has no credits left.");
  if (status === 408) return new LlmError("timeout", "The provider timed out.");
  if (status === 413) return new LlmError("context_overflow", "The request is too large for the model.");
  if (status === 429) {
    if (/per day|\(tpd\)|\(rpd\)|\bdaily\b|insufficient (credits|quota)|quota exceeded/i.test(text)) return new LlmError("quota", "The provider quota is exhausted.");
    const seconds = retryAfter !== null && /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Math.ceil(Number(retryAfter)) : undefined;
    return new LlmError("rate_limited", "The provider is rate limiting.", seconds);
  }
  if (status === 404 || (status === 400 && /model[^.]{0,60}(not found|does not exist|decommission|deprecated|not supported|unavailable)|invalid model|unknown model/i.test(text))) {
    return new LlmError("unsupported_model", "The provider does not support this model.");
  }
  if (status === 400 && /context|too long|too many tokens|reduce the length|maximum.{0,20}tokens|exceeds/i.test(text)) {
    return new LlmError("context_overflow", "The request exceeds the model's context window.");
  }
  if (status >= 500) return new LlmError("unavailable", "The provider is unavailable.");
  return new LlmError("invalid_request", "The provider refused the request.");
}

export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): LlmProvider {
  const doFetch: FetchLike = config.fetchImpl ?? ((url, init) => fetch(url, init));
  const maxField = config.maxTokensField ?? "max_tokens";
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    name: config.name,
    async generate(request: LlmRequest): Promise<LlmResponse> {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: toMessages(request, config.name),
        [maxField]: request.maxOutputTokens,
        temperature: request.temperature ?? 0.2,
      };
      if (request.responseJsonSchema) body.response_format = { type: "json_object" };
      else if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
        body.tool_choice = "auto";
      }

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { ...config.headers, Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name === "AbortError" || name === "TimeoutError") throw new LlmError("timeout", "The provider call was aborted or timed out.");
        throw new LlmError("network", "Could not reach the provider.");
      }

      let raw: string;
      try {
        raw = await response.text();
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        throw new LlmError(name === "AbortError" || name === "TimeoutError" ? "timeout" : "network", "The provider response could not be read.");
      }
      let json: ({ choices?: { message?: ApiMessage; finish_reason?: string | null; error?: unknown }[]; usage?: ApiUsage; model?: string } & ErrorBody) | null = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
      if (!response.ok) throw mapHttpError(response.status, json, response.headers.get("retry-after"));
      if (!json || typeof json !== "object") throw new LlmError("bad_output", "The provider returned an unreadable response.");
      // OpenRouter can answer 200 with an error object instead of choices (an upstream provider failed mid-request).
      if (json.error && !json.choices) throw mapHttpError(typeof (json.error as { code?: unknown }).code === "number" ? (json.error as { code: number }).code : 502, json, null);

      const choice = json.choices?.[0];
      const message = choice?.message;
      if (!message) throw new LlmError("bad_output", "The provider returned no message.");

      const toolCalls: LlmToolCall[] = [];
      const nativeCalls: ApiToolCall[] = [];
      for (const [index, call] of (message.tool_calls ?? []).entries()) {
        const name = call.function?.name;
        if (!name) throw new LlmError("bad_output", "The provider returned a tool call without a name.");
        let args: Record<string, unknown> = {};
        const rawArgs = call.function?.arguments;
        if (typeof rawArgs === "string" && rawArgs.trim() !== "") {
          try {
            const parsed: unknown = JSON.parse(rawArgs);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
            args = parsed as Record<string, unknown>;
          } catch {
            throw new LlmError("bad_output", "The provider returned malformed tool-call arguments.");
          }
        }
        const id = call.id && call.id.length > 0 ? call.id : `call_${index}`;
        toolCalls.push({ id, name, args });
        nativeCalls.push({ ...call, id, type: "function" });
      }
      const text = responseText(message.content);
      if (text === null && toolCalls.length === 0 && choice?.finish_reason !== "content_filter") throw new LlmError("bad_output", "The provider returned an empty answer.");

      const mapped = mapUsage(json.usage);
      const nativeMessage: ApiMessage = { role: "assistant", content: text, ...(nativeCalls.length > 0 ? { tool_calls: nativeCalls } : {}) };
      return {
        text,
        toolCalls,
        finishReason: FINISH[choice?.finish_reason ?? ""] ?? "other",
        usage: mapped.usage,
        usageReported: mapped.reported,
        costUsd: mapped.costUsd,
        raw: { provider: config.name, message: nativeMessage } satisfies NativeRaw,
        modelVersion: typeof json.model === "string" ? json.model : undefined,
      };
    },
  };
}
