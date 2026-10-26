import { ZERO_USAGE } from "../types";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from "./types";

// Scripted provider for deterministic tests: each call takes the next step. A step is a response, an error to throw, or
// a function of the request (to assert on what the orchestrator sent). Never used outside tests and evaluation dry runs.
export type FakeStep = Partial<LlmResponse> | LlmError | ((request: LlmRequest) => Partial<LlmResponse> | LlmError);

export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly requests: LlmRequest[] = [];
  constructor(private readonly steps: FakeStep[]) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (request.signal.aborted) throw new LlmError("timeout", "aborted");
    const step = this.steps.shift();
    if (step === undefined) throw new Error("FakeProvider: no scripted step left");
    const value = typeof step === "function" ? step(request) : step;
    if (value instanceof LlmError) throw value;
    return {
      text: value.text ?? null,
      toolCalls: value.toolCalls ?? [],
      finishReason: value.finishReason ?? "stop",
      usage: value.usage ?? { ...ZERO_USAGE, inputTokens: 100, outputTokens: 50 },
      raw: value.raw ?? { fake: true },
      modelVersion: request.model,
    };
  }
}
