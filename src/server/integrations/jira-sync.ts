import type { JiraIssue } from "./jira";
import { ProviderError } from "./provider-http";

// One-way Jira -> OneForAll synchronization loop. Pure: fetching, storing and marking are injected, so pagination,
// partial failures and limits are unit-tested without Jira or a database.
//
// Policy:
//   * every page is stored as soon as it arrives (idempotent upsert keyed by the Jira issue id);
//   * issues are marked "missing in Jira" ONLY after a complete sync (every page fetched and stored), so a rate limit
//     or an interruption can never make existing issues look deleted;
//   * at most `maxIssues` issues per sync; past that the sync stops and reports PARTIAL.

export const MAX_SYNC_ISSUES = 5000;

export type SyncDeps = {
  fetchPage: (nextPageToken?: string) => Promise<{ issues: JiraIssue[]; rejected: number; nextPageToken: string | null }>;
  storePage: (issues: JiraIssue[]) => Promise<{ inserted: number; updated: number }>;
  markMissing: () => Promise<number>;
  maxIssues?: number;
};

export type SyncOutcome = {
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  inserted: number;
  updated: number;
  rejected: number;
  missing: number;
  pages: number;
  message: string;
  retryAfterSeconds?: number;
};

function reason(error: unknown): { text: string; retry?: number } {
  if (error instanceof ProviderError) return { text: error.message, retry: error.retryAfterSeconds };
  return { text: "The imported issues could not be stored." };
}

export async function runJiraSync(deps: SyncDeps): Promise<SyncOutcome> {
  const maxIssues = deps.maxIssues ?? MAX_SYNC_ISSUES;
  const totals = { inserted: 0, updated: 0, rejected: 0, missing: 0, pages: 0 };
  let token: string | undefined;
  for (;;) {
    let page: Awaited<ReturnType<SyncDeps["fetchPage"]>>;
    try {
      page = await deps.fetchPage(token);
      const stored = page.issues.length > 0 ? await deps.storePage(page.issues) : { inserted: 0, updated: 0 };
      totals.inserted += stored.inserted;
      totals.updated += stored.updated;
      totals.rejected += page.rejected;
      totals.pages++;
    } catch (error) {
      const { text, retry } = reason(error);
      const done = totals.inserted + totals.updated;
      return {
        status: totals.pages === 0 ? "FAILED" : "PARTIAL",
        ...totals,
        message: totals.pages === 0 ? text : `Stopped after ${done} issues: ${text} Already imported issues are kept; nothing was marked missing.`,
        retryAfterSeconds: retry,
      };
    }
    const seen = totals.inserted + totals.updated;
    if (page.nextPageToken === null) break;
    if (seen >= maxIssues) {
      return { status: "PARTIAL", ...totals, message: `Stopped at the limit of ${maxIssues} issues per sync. Nothing was marked missing.` };
    }
    token = page.nextPageToken;
  }

  try {
    totals.missing = await deps.markMissing();
  } catch (error) {
    return { status: "PARTIAL", ...totals, message: `All issues were imported, but marking removed issues failed: ${reason(error).text}` };
  }
  const parts = [`${totals.inserted} new`, `${totals.updated} updated`];
  if (totals.missing > 0) parts.push(`${totals.missing} no longer in Jira (kept, marked missing)`);
  if (totals.rejected > 0) parts.push(`${totals.rejected} malformed records skipped`);
  return { status: "SUCCEEDED", ...totals, message: `Synchronized from Jira: ${parts.join(", ")}.` };
}
