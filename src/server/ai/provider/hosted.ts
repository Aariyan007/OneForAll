import "server-only";
import { createOpenAiCompatibleProvider } from "./openai-compatible";
import type { LlmProvider } from "./types";

// Server-only entry points for the Groq and OpenRouter adapters, like ./gemini for Gemini: the app imports them from
// here so a provider key can never be bundled into browser code.

export function createGroqProvider(apiKey: string): LlmProvider {
  return createOpenAiCompatibleProvider({ name: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey, maxTokensField: "max_completion_tokens" });
}

export function createOpenRouterProvider(apiKey: string): LlmProvider {
  return createOpenAiCompatibleProvider({ name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey, headers: { "X-Title": "OneForAll" } });
}
