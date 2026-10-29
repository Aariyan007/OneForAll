// Gemini adapter turn conversion (the SDK-free part): its own turns are replayed verbatim, turns produced by another provider
// after a failover are replayed as text.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGeminiContent, toContents } from "./gemini-mapping";
import type { LlmRequest } from "./types";

const request = (turns: LlmRequest["turns"]): LlmRequest => ({ model: "m", system: "s", turns, maxOutputTokens: 10, signal: new AbortController().signal });
const toolCall = { id: "1", name: "read_file", args: { path: "a.ts" } };

describe("toContents", () => {
  it("sends Gemini's own model turn back exactly as received, and tool results as function responses", () => {
    const raw = { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" } }, thoughtSignature: "sig" }] };
    const contents = toContents(request([{ role: "user", text: "q" }, { role: "model", text: null, toolCalls: [toolCall], raw }, { role: "tool", results: [{ id: "1", name: "read_file", result: { ok: true } }] }]));
    assert.equal(contents[1], raw);
    assert.deepEqual(contents[2], { role: "user", parts: [{ functionResponse: { id: "1", name: "read_file", response: { ok: true } } }] });
  });

  it("replays a turn from another provider as text, and its tool results as a user message", () => {
    const contents = toContents(request([{ role: "user", text: "q" }, { role: "model", text: "Checking", toolCalls: [toolCall], raw: { provider: "groq", message: {} } }, { role: "tool", results: [{ id: "1", name: "read_file", result: { ok: true } }] }]));
    assert.equal(contents[1].role, "model");
    assert.match(String(contents[1].parts?.[0].text), /Checking\n\[Called tools: read_file\(\{"path":"a\.ts"\}\)\]/);
    assert.equal(contents[2].role, "user");
    assert.ok(contents[2].parts?.[0].text, "plain text, not a functionResponse that Gemini would match to a call it never made");
    assert.equal(contents[2].parts?.[0].functionResponse, undefined);
  });

  it("recognizes Gemini content and nothing else", () => {
    assert.equal(isGeminiContent({ role: "model", parts: [] }), true);
    assert.equal(isGeminiContent({ provider: "groq", message: {} }), false);
    assert.equal(isGeminiContent(null), false);
    assert.equal(isGeminiContent({ fake: true }), false);
  });
});
