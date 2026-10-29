import { FinishReason, GoogleGenAI } from "@google/genai";
import { mapGeminiError, mapUsage, toContents } from "./gemini-mapping";
import { type FinishReason as LlmFinishReason, LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from "./types";

// Google Gemini adapter (@google/genai, models.generateContent). Import it through ./gemini (server-only guard) in the
// app; only the evaluation script (scripts/ai-eval.ts) imports this file directly. The key is a parameter, never read
// here, so it reaches the browser only if a caller sends it there.
// Function calling is driven by the orchestrator (automatic function calling and automatic continuation are off), and
// each model turn is sent back exactly as received, which preserves Gemini 3 thought signatures across tool calls.

function finishReason(reason: FinishReason | undefined): LlmFinishReason {
  switch (reason) {
    case FinishReason.STOP:
      return "stop";
    case FinishReason.MAX_TOKENS:
      return "max_tokens";
    case FinishReason.SAFETY:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.BLOCKLIST:
    case FinishReason.SPII:
    case FinishReason.RECITATION:
      return "safety";
    default:
      return "other";
  }
}

export function createGeminiProvider(apiKey: string): LlmProvider {
  const client = new GoogleGenAI({ apiKey });
  return {
    name: "gemini",
    async generate(request: LlmRequest): Promise<LlmResponse> {
      let response;
      try {
        response = await client.models.generateContent({
          model: request.model,
          contents: toContents(request),
          config: {
            systemInstruction: request.system,
            maxOutputTokens: request.maxOutputTokens,
            temperature: request.temperature ?? 0.2,
            abortSignal: request.signal,
            automaticFunctionCalling: { disable: true },
            automaticContinuation: false,
            tools: request.tools
              ? [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }]
              : undefined,
            responseMimeType: request.responseJsonSchema ? "application/json" : undefined,
            responseJsonSchema: request.responseJsonSchema,
          },
        });
      } catch (error) {
        throw mapGeminiError(error as { status?: number; message?: string; name?: string });
      }

      if (response.promptFeedback?.blockReason) throw new LlmError("safety_blocked", "The prompt was blocked by the provider.");
      const candidate = response.candidates?.[0];
      if (!candidate?.content) throw new LlmError("bad_output", "The provider returned no candidate.");
      const parts = candidate.content.parts ?? [];
      const text = parts
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text)
        .join("");
      return {
        text: text.length > 0 ? text : null,
        toolCalls: parts
          .filter((p) => p.functionCall?.name)
          .map((p) => ({ id: p.functionCall!.id, name: p.functionCall!.name!, args: p.functionCall!.args ?? {} })),
        finishReason: finishReason(candidate.finishReason),
        usage: mapUsage(response.usageMetadata),
        usageReported: response.usageMetadata !== undefined,
        raw: candidate.content,
        modelVersion: response.modelVersion,
      };
    },
  };
}
