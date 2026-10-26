// Scores one evaluation run against the task's expectations (fixtures/ai-eval/tasks.json). Deterministic checks only:
// regular expressions over the validated result, cited files, generated content and the syntax check.

export type Expectation = {
  matches?: string[];
  cites?: string[];
  syntaxValid?: boolean;
  contentMatches?: string[];
  contentNotMatches?: string[];
};

export type Score = { passed: number; total: number; failures: string[] };

function locations(job: string, result: Record<string, unknown>): string[] {
  const key = job === "requirement_trace" ? "links" : job === "code_review" ? "findings" : "citations";
  return ((result[key] as { path?: string }[] | undefined) ?? []).map((item) => item.path ?? "");
}

export function scoreResult(job: string, result: Record<string, unknown> | null, expect: Expectation, syntaxValid: boolean | null): Score {
  const total =
    (expect.matches?.length ?? 0) +
    (expect.cites?.length ?? 0) +
    (expect.syntaxValid === undefined ? 0 : 1) +
    (expect.contentMatches?.length ?? 0) +
    (expect.contentNotMatches?.length ?? 0);
  if (!result) return { passed: 0, total, failures: ["no result"] };

  const failures: string[] = [];
  const text = JSON.stringify(result);
  for (const pattern of expect.matches ?? []) if (!new RegExp(pattern, "i").test(text)) failures.push(`matches /${pattern}/`);
  const cited = locations(job, result);
  for (const path of expect.cites ?? []) if (!cited.includes(path)) failures.push(`cites ${path}`);
  if (expect.syntaxValid !== undefined && syntaxValid !== expect.syntaxValid) failures.push(`syntaxValid ${expect.syntaxValid}`);
  const content = String(result.content ?? "");
  for (const pattern of expect.contentMatches ?? []) if (!new RegExp(pattern, "i").test(content)) failures.push(`content matches /${pattern}/`);
  for (const pattern of expect.contentNotMatches ?? []) if (new RegExp(pattern, "i").test(content)) failures.push(`content does not match /${pattern}/`);
  return { passed: total - failures.length, total, failures };
}
