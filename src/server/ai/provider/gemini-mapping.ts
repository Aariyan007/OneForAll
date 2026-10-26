import type { Usage } from "../types";
import { LlmError } from "./types";

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
