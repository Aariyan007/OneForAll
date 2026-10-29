import type { Content, Part } from "@google/genai";
import type { Usage } from "../types";
import { LlmError, type LlmRequest } from "./types";

// Pure mapping from Gemini API failures and usage metadata to the provider-neutral shapes. Kept free of the SDK so it
// is unit-tested without network. The provider's own message is matched but never copied into the error: it can echo
// request details.

type ErrorLike = { status?: number; message?: string; name?: string };

export function mapGeminiError(error: ErrorLike): LlmError {
  const message = error.message ?? "";
  const status = error.status;
  if (error.name === "AbortError" || error.name === "TimeoutError" || (/aborted/i.test(message) && status === undefined)) {
    return new LlmError("timeout", "The provider call was aborted or timed out.");
  }
  if (status === undefined) return new LlmError("network", "Could not reach the provider.");
  if (status === 401 || status === 403 || /api key not valid|api_key_invalid|permission_denied/i.test(message)) {
    return new LlmError("auth", "The provider rejected the credentials.");
  }
  if (status === 429) {
    if (/per day|daily|quota exceeded for metric[^]*per_?day/i.test(message)) return new LlmError("quota", "The provider quota is exhausted.");
    const delay = message.match(/retry(?:_?delay)?"?\s*[:=]?\s*"?(\d+(?:\.\d+)?)s/i);
    return new LlmError("rate_limited", "The provider is rate limiting.", delay ? Math.ceil(Number(delay[1])) : undefined);
  }
  if (status === 400 && /token count|exceeds the maximum|too long|context length/i.test(message)) {
    return new LlmError("context_overflow", "The request exceeds the model's context window.");
  }
  if (status === 404 || status >= 500) return new LlmError("unavailable", "The model is unavailable.");
  return new LlmError("invalid_request", "The provider refused the request.");
}

type UsageLike = {
  promptTokenCount?: number;
  toolUsePromptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
};

export function mapUsage(usage: UsageLike | undefined): Usage {
  return {
    inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
    thinkingTokens: usage?.thoughtsTokenCount ?? 0,
  };
}

// A model turn from this adapter keeps Gemini's own Content as `raw`. A turn from another provider (after a failover) is
// replayed as text: Gemini 3 requires the thought signatures of its own function calls, which a foreign call cannot carry.
export function isGeminiContent(raw: unknown): raw is Content {
  return typeof raw === "object" && raw !== null && (raw as Content).role === "model" && Array.isArray((raw as Content).parts);
}

export function toContents(request: LlmRequest): Content[] {
  let nativeBefore = false;
  return request.turns.map((turn): Content => {
    if (turn.role === "user") return { role: "user", parts: [{ text: turn.text }] };
    if (turn.role === "model") {
      nativeBefore = isGeminiContent(turn.raw);
      if (isGeminiContent(turn.raw)) return turn.raw;
      const calls = turn.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 300)})`);
      const text = [turn.text, calls.length > 0 ? `[Called tools: ${calls.join("; ")}]` : null].filter(Boolean).join("\n");
      return { role: "model", parts: [{ text: text || "[no reply]" }] };
    }
    if (!nativeBefore) {
      const results = turn.results.map((r) => `${r.name}: ${JSON.stringify(r.result).slice(0, 20_000)}`).join("\n");
      return { role: "user", parts: [{ text: `Results of the tools you called:\n${results}` }] };
    }
    return {
      role: "user",
      parts: turn.results.map((r): Part => ({ functionResponse: { id: r.id, name: r.name, response: r.result } })),
    };
  });
}
