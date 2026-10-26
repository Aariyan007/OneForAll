// Mapping of Gemini API failures to the provider-neutral categories the orchestrator retries or reports.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapGeminiError, mapUsage } from "./gemini-mapping";

describe("mapGeminiError", () => {
  it("maps authentication and permission failures to auth", () => {
    assert.equal(mapGeminiError({ status: 400, message: "API key not valid. Please pass a valid API key." }).category, "auth");
    assert.equal(mapGeminiError({ status: 401, message: "unauthenticated" }).category, "auth");
    assert.equal(mapGeminiError({ status: 403, message: "PERMISSION_DENIED" }).category, "auth");
  });

  it("separates daily quota exhaustion from rate limiting, and reads the retry delay", () => {
    assert.equal(mapGeminiError({ status: 429, message: "Quota exceeded for metric generate_content_free_tier_requests, limit per day" }).category, "quota");
    const limited = mapGeminiError({ status: 429, message: 'RESOURCE_EXHAUSTED ... "retryDelay": "17s"' });
    assert.equal(limited.category, "rate_limited");
    assert.equal(limited.retryAfterSeconds, 17);
  });

  it("maps oversized requests, server errors, unknown models, aborts and network failures", () => {
    assert.equal(mapGeminiError({ status: 400, message: "The input token count (2000000) exceeds the maximum number of tokens allowed" }).category, "context_overflow");
    assert.equal(mapGeminiError({ status: 400, message: "Invalid JSON payload" }).category, "invalid_request");
    assert.equal(mapGeminiError({ status: 503, message: "overloaded" }).category, "unavailable");
    assert.equal(mapGeminiError({ status: 404, message: "models/x is not found" }).category, "unavailable");
    assert.equal(mapGeminiError({ name: "AbortError", message: "aborted" }).category, "timeout");
    assert.equal(mapGeminiError({ name: "TypeError", message: "fetch failed" }).category, "network");
  });

  it("never copies the provider message into the error text", () => {
    const error = mapGeminiError({ status: 400, message: "API key not valid: AIzaSECRET" });
    assert.ok(!error.message.includes("AIza"));
  });
});

describe("mapUsage", () => {
  it("reads token counts, counting tool-use prompt tokens as input", () => {
    assert.deepEqual(mapUsage({ promptTokenCount: 100, toolUsePromptTokenCount: 20, candidatesTokenCount: 30, cachedContentTokenCount: 40, thoughtsTokenCount: 5 }), {
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 40,
      thinkingTokens: 5,
    });
    assert.deepEqual(mapUsage(undefined), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, thinkingTokens: 0 });
  });
});
