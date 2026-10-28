import type { BugCategory, BugSeverity } from "./model";

// Ranks eligible people for a bug. Deterministic and explainable: every point comes from a stated fact (skills in the
// workforce directory, the project's team, current workload, availability) and is returned as a reason the admin can
// read. The database re-checks eligibility when the assignment is made, so this never decides WHO MAY be assigned,
// only who is the best of those who may.

export type Candidate = {
  userId: string;
  name: string;
  role: string; // OWNER | ADMIN | MEMBER
  jobTitle: string | null;
  availability: string; // AVAILABLE | BUSY | UNAVAILABLE
  onProjectTeam: boolean;
  skills: string[];
  openBugs: number;
  openTasks: number;
};

export type BugFacts = { category: BugCategory | string; severity: BugSeverity | string; filePath: string };

export type Ranked = { candidate: Candidate; score: number; reasons: string[] };

const CATEGORY_SKILLS: Record<string, string[]> = {
  frontend: ["react", "frontend", "front-end", "ui", "ux", "css", "html", "next", "next.js", "vue", "angular", "typescript", "javascript"],
  backend: ["backend", "back-end", "node", "node.js", "api", "server", "java", "python", "go", "typescript"],
  api: ["api", "rest", "graphql", "backend", "node", "node.js"],
  database: ["sql", "postgres", "postgresql", "database", "db", "supabase", "mysql", "data"],
  auth_security: ["security", "auth", "authentication", "appsec", "oauth", "backend"],
  repo_processing: ["parsing", "parser", "tree-sitter", "backend", "node", "python", "java"],
  llm_orchestration: ["ai", "llm", "ml", "machine learning", "prompt", "gemini", "python"],
  token_usage: ["ai", "llm", "ml", "machine learning", "prompt"],
  testing: ["qa", "testing", "test", "tester", "automation", "jest", "playwright", "cypress"],
  configuration: ["devops", "ci", "ci/cd", "docker", "config", "infrastructure", "cloud"],
  performance: ["performance", "profiling", "backend", "database", "sql"],
  other: [],
};

const LANGUAGE_BY_EXTENSION: [RegExp, string[]][] = [
  [/\.[cm]?tsx?$/i, ["typescript", "javascript", "node", "node.js", "react"]],
  [/\.[cm]?jsx?$/i, ["javascript", "node", "node.js", "react"]],
  [/\.py$/i, ["python"]],
  [/\.java$/i, ["java"]],
  [/\.sql$/i, ["sql", "postgres", "database"]],
];

const norm = (s: string) => s.trim().toLowerCase();

export function rankCandidates(candidates: readonly Candidate[], bug: BugFacts): Ranked[] {
  const wanted = new Set((CATEGORY_SKILLS[bug.category] ?? []).map(norm));
  const languageSkills = new Set((LANGUAGE_BY_EXTENSION.find(([re]) => re.test(bug.filePath))?.[1] ?? []).map(norm));
  const employees = candidates.filter((c) => c.role === "MEMBER");
  // Owners and admins take bugs only when nobody else is eligible.
  const pool = employees.length > 0 ? employees : candidates;

  const ranked = pool
    .filter((c) => c.availability !== "UNAVAILABLE")
    .map((c): Ranked => {
      const reasons: string[] = [];
      let score = 0;
      const categoryHits = c.skills.filter((s) => wanted.has(norm(s)));
      if (categoryHits.length > 0) {
        score += Math.min(6, categoryHits.length * 3);
        reasons.push(`skills for ${bug.category.replace(/_/g, " ")}: ${categoryHits.slice(0, 3).join(", ")}`);
      }
      const languageHits = c.skills.filter((s) => languageSkills.has(norm(s)) && !categoryHits.includes(s));
      if (languageHits.length > 0) {
        score += 2;
        reasons.push(`knows the file's language: ${languageHits.slice(0, 2).join(", ")}`);
      }
      if (c.jobTitle && [...wanted].some((w) => w.length > 2 && norm(c.jobTitle ?? "").includes(w))) {
        score += 1;
        reasons.push(`job title: ${c.jobTitle}`);
      }
      if (c.onProjectTeam) {
        score += 3;
        reasons.push("on this project's team");
      }
      if (c.openBugs > 0) {
        score -= c.openBugs;
        reasons.push(`${c.openBugs} open bug${c.openBugs === 1 ? "" : "s"} already`);
      } else reasons.push("no open bugs");
      if (c.openTasks > 3) {
        score -= (c.openTasks - 3) * 0.5;
        reasons.push(`${c.openTasks} open tasks`);
      }
      if (c.availability === "BUSY") {
        score -= 3;
        reasons.push("marked busy");
      }
      return { candidate: c, score, reasons };
    });

  return ranked.sort((a, b) => b.score - a.score || a.candidate.openBugs - b.candidate.openBugs || a.candidate.userId.localeCompare(b.candidate.userId));
}

// Assigns the given bugs one after another, most severe first, counting each assignment against the person's workload
// so a batch of bugs spreads over the team instead of landing on one person.
const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

export type AutoAssignment = { bugId: string; userId: string; reason: string } | { bugId: string; userId: null; reason: string };

// A bug that already has an assignee is being REassigned: the current assignee is left out, otherwise "auto-assign" could
// pick the same person and change nothing.
export function planAutoAssignment(bugs: readonly (BugFacts & { id: string; assignedTo?: string | null })[], candidates: readonly Candidate[]): AutoAssignment[] {
  const load = new Map(candidates.map((c) => [c.userId, c.openBugs]));
  const ordered = [...bugs].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.id.localeCompare(b.id));
  const result: AutoAssignment[] = [];
  for (const bug of ordered) {
    const current = candidates.filter((c) => c.userId !== bug.assignedTo).map((c) => ({ ...c, openBugs: load.get(c.userId) ?? c.openBugs }));
    const best = rankCandidates(current, bug)[0];
    if (!best) {
      result.push({
        bugId: bug.id,
        userId: null,
        reason: bug.assignedTo ? "No other eligible person to give this bug to." : "No eligible person (everyone is unavailable or cannot see this project).",
      });
      continue;
    }
    load.set(best.candidate.userId, (load.get(best.candidate.userId) ?? 0) + 1);
    result.push({ bugId: bug.id, userId: best.candidate.userId, reason: `Auto-assigned (score ${best.score.toFixed(1)}): ${best.reasons.join("; ")}.` });
  }
  return result;
}
