import type { JobType, Tier } from "./types";

// Deterministic routing. It only chooses HOW to answer (which job prompt, which model tier); it never decides WHO may
// ask. Authorization is enforced before the router runs, in code and in the database.

export type AskIntent = "question" | "explain_error" | "generate_tests" | "generate_docs";

const ERROR_PATTERNS = [
  /^\s*at\s+\S+.*\(.*:\d+:\d+\)\s*$/m, // JS stack frame
  /^Traceback \(most recent call last\):/m, // Python
  /^\s*File ".+", line \d+/m, // Python frame
  /^\s*at\s+[\w.$]+\([\w.]+\.java:\d+\)/m, // Java frame
  /^(?:\w+\.)*\w*(?:Error|Exception)(?::|\s*$)/m, // "TypeError: ..." on its own line
];

export function classifyAsk(text: string): AskIntent {
  if (ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "explain_error";
  const lower = text.toLowerCase();
  if (/\b(write|generate|create|add)\b[^.?!]{0,40}\b(unit )?tests?\b/.test(lower)) return "generate_tests";
  if (/\b(write|generate|create|add)\b[^.?!]{0,40}\b(docs|documentation|docstrings?|jsdoc|readme)\b/.test(lower)) return "generate_docs";
  return "question";
}

const FAST_MAX_PROMPT_CHARS = 200;
const FAST_MAX_CONTEXT_TOKENS = 6000;

// Short questions over a small context go to the fast tier; everything else to standard. The paid deep tier is never
// chosen automatically.
export function chooseTier(input: { job: JobType; promptChars: number; contextTokens: number }): Tier {
  if (input.job === "code_qa" && input.promptChars <= FAST_MAX_PROMPT_CHARS && input.contextTokens <= FAST_MAX_CONTEXT_TOKENS) return "fast";
  return "standard";
}
