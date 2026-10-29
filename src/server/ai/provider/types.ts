import type { ProviderErrorCategory, Usage } from "../types";

// Provider-neutral model interface. The orchestrator only talks to this; provider SDK details (and their opaque turn
// data such as Gemini's thought signatures) stay inside the adapter, which receives its own `raw` turns back verbatim.

export type LlmToolCall = { id?: string; name: string; args: Record<string, unknown> };

export type LlmTurn =
  | { role: "user"; text: string }
  | { role: "model"; text: string | null; toolCalls: LlmToolCall[]; raw: unknown }
  | { role: "tool"; results: { id?: string; name: string; result: Record<string, unknown> }[] };

export type LlmToolDeclaration = { name: string; description: string; parameters: Record<string, unknown> };

export type LlmRequest = {
  model: string;
  system: string;
  turns: LlmTurn[];
  tools?: LlmToolDeclaration[];
  // When set, the provider is asked for JSON matching this schema (and tools are not offered).
  responseJsonSchema?: Record<string, unknown>;
  maxOutputTokens: number;
  temperature?: number;
  signal: AbortSignal;
};

export type FinishReason = "stop" | "max_tokens" | "safety" | "other";

export type LlmResponse = {
  text: string | null;
  toolCalls: LlmToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  // False when the provider sent no usage metadata: `usage` is then zeros and must not be read as a measurement.
  // Absent means reported (adapters that always report, and the scripted fake).
  usageReported?: boolean;
  // Cost in USD when the provider itself reports it (OpenRouter's usage.cost); otherwise absent.
  costUsd?: number;
  raw: unknown;
  modelVersion?: string;
};

export class LlmError extends Error {
  constructor(
    readonly category: ProviderErrorCategory,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface LlmProvider {
  readonly name: string;
  generate(request: LlmRequest): Promise<LlmResponse>;
}
