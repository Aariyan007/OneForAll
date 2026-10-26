import type { ProviderErrorCategory } from "./types";

// Bounded retries for transient provider failures only. Authentication, quota, invalid requests, context overflow,
// safety blocks and bad output are never retried: repeating them cannot change the outcome.
const RETRYABLE: readonly ProviderErrorCategory[] = ["rate_limited", "unavailable", "network"];

export const RETRY_POLICY = {
  maxAttempts: 3, // first call + 2 retries
  baseDelayMs: 1000,
  maxDelayMs: 20_000,
} as const;

export function isRetryable(category: ProviderErrorCategory): boolean {
  return RETRYABLE.includes(category);
}

// Delay before retry number `attempt` (0-based): exponential with up to 50% jitter, or the provider's Retry-After when
// it sent one. Always capped, so one slow provider cannot hold a request for long.
export function backoffMillis(attempt: number, retryAfterSeconds: number | undefined, random: () => number = Math.random): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) return Math.min(retryAfterSeconds * 1000, RETRY_POLICY.maxDelayMs);
  const exponential = RETRY_POLICY.baseDelayMs * 2 ** attempt;
  return Math.min(Math.floor(exponential * (1 + 0.5 * random())), RETRY_POLICY.maxDelayMs);
}
