// Token budgeting. Estimates are labelled as estimates: the provider's usage metadata is the authoritative count and
// is what gets recorded on the run.

const CHARS_PER_TOKEN = 4; // documented approximation for English text and code; not a tokenizer
export const SAFETY_MARGIN_TOKENS = 1500;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// available_input = min(job budget, context limit - reserved output - safety margin), never negative.
export function inputBudget(input: { contextLimit: number; reservedOutput: number; jobBudget: number }): number {
  const room = input.contextLimit - input.reservedOutput - SAFETY_MARGIN_TOKENS;
  return Math.max(0, Math.min(input.jobBudget, room));
}
