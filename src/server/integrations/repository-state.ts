import { type RepositoryStatus, type Visibility, isAllowedRepositoryTransition } from "../repositories/schema";

// How a GitHub check moves the project's repository record. Pure, so it is unit-tested. The status changes follow the
// existing repository lifecycle (database trigger `enforce_repository_status_transition`): each returned step is one
// allowed transition, applied in order.
//   reachable on GitHub      -> CONNECTED (from PENDING directly, from ERROR through PENDING)
//   not found / not allowed  -> ERROR     (from PENDING or CONNECTED)
// A DISCONNECTED record is never revived here, and transient failures (rate limit, timeout) change nothing.

export function gitHubVisibility(repository: { private: boolean; visibility?: string }): Visibility {
  switch (repository.visibility) {
    case "public":
      return "PUBLIC";
    case "private":
      return "PRIVATE";
    case "internal":
      return "INTERNAL";
    default:
      return repository.private ? "PRIVATE" : "PUBLIC";
  }
}

export function repositoryStatusSteps(current: RepositoryStatus, target: "CONNECTED" | "ERROR"): RepositoryStatus[] {
  if (current === target || current === "DISCONNECTED") return [];
  if (isAllowedRepositoryTransition(current, target)) return [target];
  if (target === "CONNECTED" && current === "ERROR") return ["PENDING", "CONNECTED"];
  return [];
}

// Provider error codes that say the repository itself cannot be read with the current access (as opposed to a
// temporary failure). Only a failed repository lookup is judged by this, never a missing branch or commit.
export const REPOSITORY_ACCESS_FAILURES: ReadonlySet<string> = new Set(["not_found", "unauthorized", "forbidden"]);
