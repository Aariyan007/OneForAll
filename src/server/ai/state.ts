import type { RunState } from "./types";

// Allowed lifecycle transitions of an AI run. The database enforces the same table (migration 20261028000003), so a
// run cannot be moved into an impossible state from either side.
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ["validating", "failed", "cancelled"],
  validating: ["retrieving_context", "failed", "cancelled"],
  retrieving_context: ["generating", "failed", "cancelled", "timed_out"],
  generating: ["executing_tool", "validating_output", "failed", "cancelled", "timed_out"],
  executing_tool: ["generating", "failed", "cancelled", "timed_out"],
  // Back to generating = the single correction turn for output that failed validation.
  validating_output: ["completed", "generating", "failed", "cancelled", "timed_out"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export const TERMINAL_STATES: readonly RunState[] = ["completed", "failed", "cancelled", "timed_out"];

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}
