// Groq / OpenRouter adapter over mocked HTTP: request shape and credentials, response and usage parsing, honest handling of
// missing usage, failure classification, provider-turn replay, and that no key or provider text reaches an error.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOpenAiCompatibleProvider, mapHttpError, mapUsage, toMessages } from "./openai-compatible";
import { LlmError, type LlmRequest } from "./types";

const KEY = "sk-test-SECRET-0123456789";

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function mock(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next === undefined) throw new Error("no scripted response");
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  model: "openai/gpt-oss-20b",
  choices: [{ message: { role: "assistant", ...message }, finish_reason: "stop" }],
  usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  ...extra,
});

const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: "openai/gpt-oss-20b",
  system: "You are helpful.",
  turns: [{ role: "user", text: "Where is it?" }],
  maxOutputTokens: 512,
  signal: new AbortController().signal,
  ...over,
});

const groq = (responses: (Response | Error)[]) => {
  const m = mock(responses);
  return { ...m, provider: createOpenAiCompatibleProvider({ name: "groq", baseUrl: "https://api.groq.com/openai/v1/", apiKey: KEY, maxTokensField: "max_completion_tokens", fetchImpl: m.fetchImpl }) };
};
const openrouter = (responses: (Response | Error)[]) => {
  const m = mock(responses);
  return { ...m, provider: createOpenAiCompatibleProvider({ name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: KEY, headers: { "X-Title": "OneForAll" }, fetchImpl: m.fetchImpl }) };
};

describe("request", () => {
  it("posts to the provider's chat completions endpoint with a bearer key, the model and the output cap", async () => {
    const h = groq([ok(completion({ content: "hi" }))]);
    await h.provider.generate(request());
    assert.equal(h.calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(h.calls[0].headers.Authorization, `Bearer ${KEY}`);
    assert.equal(h.calls[0].body.model, "openai/gpt-oss-20b");
    assert.equal(h.calls[0].body.max_completion_tokens, 512, "Groq's current cap name");
    assert.equal(h.calls[0].body.max_tokens, undefined);
    assert.deepEqual(h.calls[0].body.messages, [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Where is it?" },
    ]);
  });

  it("uses max_tokens and the app title header for OpenRouter", async () => {
    const h = openrouter([ok(completion({ content: "hi" }))]);
    await h.provider.generate(request());
    assert.equal(h.calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(h.calls[0].body.max_tokens, 512);
    assert.equal(h.calls[0].headers["X-Title"], "OneForAll");
  });

  it("offers tools as functions, and asks for a JSON object with the schema in the system prompt instead of tools", async () => {
    const h = groq([ok(completion({ content: "a" })), ok(completion({ content: "{}" }))]);
    await h.provider.generate(request({ tools: [{ name: "read_file", description: "Reads", parameters: { type: "object" } }] }));
    assert.deepEqual(h.calls[0].body.tools, [{ type: "function", function: { name: "read_file", description: "Reads", parameters: { type: "object" } } }]);
    assert.equal(h.calls[0].body.tool_choice, "auto");
    await h.provider.generate(request({ responseJsonSchema: { type: "object", properties: { a: { type: "string" } } }, tools: [{ name: "x", description: "", parameters: {} }] }));
    assert.deepEqual(h.calls[1].body.response_format, { type: "json_object" });
    assert.equal(h.calls[1].body.tools, undefined, "no tools on a schema turn");
    assert.match(String((h.calls[1].body.messages as { content: string }[])[0].content), /JSON schema[\s\S]*"properties"/);
  });
});

describe("response", () => {
  it("returns the text, the finish reason and provider-reported usage", async () => {
    const h = groq([ok(completion({ content: "It is on line 2." }))]);
    const response = await h.provider.generate(request());
    assert.equal(response.text, "It is on line 2.");
    assert.equal(response.finishReason, "stop");
    assert.deepEqual(response.usage, { inputTokens: 120, outputTokens: 40, cachedInputTokens: 0, thinkingTokens: 0 });
    assert.equal(response.usageReported, true);
    assert.equal(response.modelVersion, "openai/gpt-oss-20b");
  });

  it("parses tool calls and keeps ids", async () => {
    const h = groq([ok(completion({ content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] }))]);
    const response = await h.provider.generate(request());
    assert.deepEqual(response.toolCalls, [{ id: "call_9", name: "read_file", args: { path: "a.ts" } }]);
    assert.equal(response.text, null);
  });

  it("maps length and content_filter finish reasons", async () => {
    const h = groq([ok({ ...completion({ content: "cut" }), choices: [{ message: { content: "cut" }, finish_reason: "length" }] }), ok({ ...completion({ content: "x" }), choices: [{ message: { content: "x" }, finish_reason: "content_filter" }] })]);
    assert.equal((await h.provider.generate(request())).finishReason, "max_tokens");
    assert.equal((await h.provider.generate(request())).finishReason, "safety");
  });

  it("normalizes OpenRouter usage: cached tokens, reasoning split out of the output, and the provider's own cost", async () => {
    const h = openrouter([ok(completion({ content: "ok" }, { usage: { prompt_tokens: 1000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 250 }, cost: 0.0042 } }))]);
    const response = await h.provider.generate(request());
    assert.deepEqual(response.usage, { inputTokens: 1000, outputTokens: 50, cachedInputTokens: 400, thinkingTokens: 250 });
    assert.equal(response.costUsd, 0.0042);
  });

  it("reports missing or malformed usage as unavailable, not as zero tokens", async () => {
    const h = groq([ok(completion({ content: "ok" }, { usage: undefined })), ok(completion({ content: "ok" }, { usage: { prompt_tokens: "many" } }))]);
    for (let i = 0; i < 2; i++) {
      const response = await h.provider.generate(request());
      assert.equal(response.usageReported, false);
      assert.deepEqual(response.usage, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, thinkingTokens: 0 });
    }
  });

  it("clamps cached and reasoning counts so the parts never exceed their totals", () => {
    const mapped = mapUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 99 }, completion_tokens_details: { reasoning_tokens: 99 } });
    assert.equal(mapped.usage.cachedInputTokens, 10);
    assert.equal(mapped.usage.thinkingTokens, 5);
    assert.equal(mapped.usage.outputTokens, 0);
  });
});

describe("invalid responses", () => {
  const cases: [string, () => Response][] = [
    ["no choices", () => ok({ choices: [] })],
    ["an empty answer", () => ok(completion({ content: "" }))],
    ["a body that is not JSON", () => new Response("<html>bad gateway</html>", { status: 200 })],
    ["a tool call without a name", () => ok(completion({ content: null, tool_calls: [{ id: "1", function: { arguments: "{}" } }] }))],
    ["malformed tool arguments", () => ok(completion({ content: null, tool_calls: [{ id: "1", function: { name: "read_file", arguments: "{not json" } }] }))],
    ["tool arguments that are not an object", () => ok(completion({ content: null, tool_calls: [{ id: "1", function: { name: "read_file", arguments: "[1]" } }] }))],
  ];
  for (const [name, make] of cases) {
    it(`fails with bad_output for ${name}`, async () => {
      const h = groq([make()]);
      await assert.rejects(h.provider.generate(request()), (e: unknown) => e instanceof LlmError && e.category === "bad_output");
    });
  }

  it("treats a 200 response that carries only an error object as a failure of that error's kind", async () => {
    const h = openrouter([ok({ error: { code: 503, message: "upstream down" } })]);
    await assert.rejects(h.provider.generate(request()), (e: unknown) => e instanceof LlmError && e.category === "unavailable");
  });
});

describe("failures", () => {
  const category = (status: number, body: unknown, headers: Record<string, string> = {}) => mapHttpError(status, body as never, headers["retry-after"] ?? null).category;

  it("classifies authentication, credit and rate-limit failures", () => {
    assert.equal(category(401, { error: { message: "Invalid API Key" } }), "auth");
    assert.equal(category(403, {}), "auth");
    assert.equal(category(402, { error: { message: "Insufficient credits" } }), "quota");
    assert.equal(category(429, { error: { message: "Rate limit reached for model x on tokens per minute (TPM)" } }), "rate_limited");
    assert.equal(category(429, { error: { message: "Rate limit reached ... on tokens per day (TPD)" } }), "quota");
  });

  it("reads Retry-After on a rate limit", () => {
    const error = mapHttpError(429, {}, "7");
    assert.equal(error.category, "rate_limited");
    assert.equal(error.retryAfterSeconds, 7);
    assert.equal(mapHttpError(429, {}, "Wed, 21 Oct 2026 07:28:00 GMT").retryAfterSeconds, undefined);
  });

  it("classifies unknown models, context overflow, server errors and refusals", () => {
    assert.equal(category(404, { error: { message: "The model `x` does not exist" } }), "unsupported_model");
    assert.equal(category(400, { error: { message: "The model `old-model` has been decommissioned" } }), "unsupported_model");
    assert.equal(category(400, { error: { message: "This model's maximum context length is 131072 tokens" } }), "context_overflow");
    assert.equal(category(413, {}), "context_overflow");
    assert.equal(category(502, {}), "unavailable");
    assert.equal(category(503, {}), "unavailable");
    assert.equal(category(408, {}), "timeout");
    assert.equal(category(400, { error: { message: "messages must not be empty" } }), "invalid_request");
    assert.equal(category(422, {}), "invalid_request");
  });

  it("maps a network failure and an aborted call", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const h = groq([new Error("ECONNRESET"), abort]);
    await assert.rejects(h.provider.generate(request()), (e: unknown) => e instanceof LlmError && e.category === "network");
    await assert.rejects(h.provider.generate(request()), (e: unknown) => e instanceof LlmError && e.category === "timeout");
  });

  it("passes the caller's abort signal to the request", async () => {
    let seen: AbortSignal | undefined;
    const provider = createOpenAiCompatibleProvider({
      name: "groq",
      baseUrl: "https://x.test/v1",
      apiKey: KEY,
      fetchImpl: async (_url, init) => {
        seen = init.signal;
        return ok(completion({ content: "ok" }));
      },
    });
    const controller = new AbortController();
    await provider.generate(request({ signal: controller.signal }));
    assert.equal(seen, controller.signal);
  });

  it("never puts the API key, the request or the provider's own message into the error", async () => {
    const h = groq([ok({ error: { message: `Invalid API key ${KEY} for request "Where is it?"` } }, 401)]);
    await assert.rejects(h.provider.generate(request()), (e: unknown) => {
      assert.ok(e instanceof LlmError);
      assert.ok(!e.message.includes(KEY) && !e.message.includes("Where is it") && !String(e.stack).includes(KEY));
      return true;
    });
  });
});

describe("turn replay across providers", () => {
  const toolCall = { id: "call_1", name: "read_file", args: { path: "a.ts" } };

  it("replays the provider's own model turn and sends tool results as tool messages", () => {
    const raw = { provider: "groq", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] } };
    const messages = toMessages(
      request({ turns: [{ role: "user", text: "q" }, { role: "model", text: null, toolCalls: [toolCall], raw }, { role: "tool", results: [{ id: "call_1", name: "read_file", result: { text: "x" } }] }] }),
      "groq",
    );
    assert.equal(messages[2].role, "assistant");
    assert.deepEqual(messages[2].tool_calls, raw.message.tool_calls);
    assert.deepEqual(messages[3], { role: "tool", tool_call_id: "call_1", content: '{"text":"x"}' });
  });

  it("replays a turn from another provider as plain text, with no tool-call ids that this API never issued", () => {
    const messages = toMessages(
      request({ turns: [{ role: "user", text: "q" }, { role: "model", text: "Let me look", toolCalls: [toolCall], raw: { geminiContent: true } }, { role: "tool", results: [{ id: "call_1", name: "read_file", result: { text: "x" } }] }] }),
      "openrouter",
    );
    assert.equal(messages[2].role, "assistant");
    assert.equal(messages[2].tool_calls, undefined);
    assert.match(String(messages[2].content), /Let me look[\s\S]*read_file/);
    assert.equal(messages[3].role, "user");
    assert.match(String(messages[3].content), /read_file: \{"text":"x"\}/);
    assert.ok(!messages.some((m) => m.role === "tool"));
  });

  it("does not treat another API-compatible provider's turn as its own", () => {
    const raw = { provider: "groq", message: { role: "assistant", content: "hi" } };
    const messages = toMessages(request({ turns: [{ role: "user", text: "q" }, { role: "model", text: "hi", toolCalls: [], raw }] }), "openrouter");
    assert.deepEqual(messages[2], { role: "assistant", content: "hi" });
  });
});
