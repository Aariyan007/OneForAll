// Deterministic, rule-based ranking of assignment candidates. Pure and unit-tested. It never invents workforce data:
// every input comes from task_assignment_candidates() (database), and a person without recorded skills simply matches
// no skill. The database function assign_task() re-checks eligibility and does a compare-and-set, so a ranking can
// never assign someone who is not allowed or overwrite a concurrent assignment.
//
// Rules, in order:
//   Eligibility
//     1. UNAVAILABLE people are excluded.
//     2. When the task has required skills, a candidate must have at least one of them.
//     3. For automatic assignment only: people whose load would exceed MAX_LOAD_HOURS are excluded.
//   Ranking (lexicographic; earlier rules dominate)
//     a. skill coverage (matched / required), higher first
//     b. not overloaded first
//     c. AVAILABLE before BUSY
//     d. effective load in hours, lower first: estimated hours of active tasks + DEFAULT_UNESTIMATED_HOURS for every
//        active task without an estimate (active = TODO, IN_PROGRESS, BLOCKED, IN_REVIEW; completed and cancelled tasks
//        never count)
//     e. number of active tasks, lower first
//     f. member of the task's team first
//     g. user id (stable tie-break, so the same inputs always give the same order)
// Without required skills there is no evidence of who is qualified: recommendations fall back to workload only and
// say so, and automatic assignment refuses.

export const DEFAULT_UNESTIMATED_HOURS = 4;
export const MAX_LOAD_HOURS = 40;

export type Candidate = {
  userId: string;
  name: string;
  availability: "AVAILABLE" | "BUSY" | "UNAVAILABLE" | string;
  inTaskTeam: boolean;
  matchedSkills: number;
  requiredSkills: number;
  activeTasks: number;
  activeHours: number;
  unestimatedTasks: number;
};

export type RankedCandidate = Candidate & {
  coverage: number; // 0..1, 1 when no skills are required
  loadHours: number;
  overloaded: boolean;
  reasons: string[];
};

export type Ineligible = { candidate: Candidate; reason: string };

export type Ranking = {
  ranked: RankedCandidate[];
  ineligible: Ineligible[];
  skillsKnown: boolean;
  note: string | null;
};

function fmt(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export function rankCandidates(candidates: readonly Candidate[], task: { estimatedHours: number | null; requiredSkills: number }, options: { automatic?: boolean } = {}): Ranking {
  const skillsKnown = task.requiredSkills > 0;
  const estimate = task.estimatedHours ?? DEFAULT_UNESTIMATED_HOURS;
  const ranked: RankedCandidate[] = [];
  const ineligible: Ineligible[] = [];

  for (const candidate of candidates) {
    if (candidate.availability === "UNAVAILABLE") {
      ineligible.push({ candidate, reason: "Marked unavailable." });
      continue;
    }
    if (skillsKnown && candidate.matchedSkills < 1) {
      ineligible.push({ candidate, reason: "Has none of the required skills." });
      continue;
    }
    const loadHours = candidate.activeHours + candidate.unestimatedTasks * DEFAULT_UNESTIMATED_HOURS;
    const overloaded = loadHours + estimate > MAX_LOAD_HOURS;
    if (options.automatic && overloaded) {
      ineligible.push({ candidate, reason: `Would exceed ${MAX_LOAD_HOURS} h of active work.` });
      continue;
    }
    const coverage = skillsKnown ? Math.min(1, candidate.matchedSkills / task.requiredSkills) : 1;
    const reasons: string[] = [];
    if (skillsKnown) reasons.push(`Has ${Math.min(candidate.matchedSkills, task.requiredSkills)} of ${task.requiredSkills} required skill${task.requiredSkills === 1 ? "" : "s"}.`);
    reasons.push(
      `${candidate.activeTasks} active task${candidate.activeTasks === 1 ? "" : "s"}, about ${fmt(loadHours)} h` +
        (candidate.unestimatedTasks > 0 ? ` (${candidate.unestimatedTasks} without estimate counted as ${DEFAULT_UNESTIMATED_HOURS} h)` : "") +
        ".",
    );
    if (candidate.availability === "BUSY") reasons.push("Marked busy.");
    if (overloaded) reasons.push(`Taking this task would exceed ${MAX_LOAD_HOURS} h.`);
    if (candidate.inTaskTeam) reasons.push("In the task's team.");
    ranked.push({ ...candidate, coverage, loadHours, overloaded, reasons });
  }

  ranked.sort(
    (x, y) =>
      y.coverage - x.coverage ||
      Number(x.overloaded) - Number(y.overloaded) ||
      Number(x.availability === "BUSY") - Number(y.availability === "BUSY") ||
      x.loadHours - y.loadHours ||
      x.activeTasks - y.activeTasks ||
      Number(y.inTaskTeam) - Number(x.inTaskTeam) ||
      (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0),
  );

  const note = !skillsKnown
    ? "No required skills are set on this task, so the ranking uses workload only. Add required skills for a skill-based recommendation."
    : ranked.length === 0
      ? "Nobody eligible: no available person with access to the project has any of the required skills."
      : null;
  return { ranked, ineligible, skillsKnown, note };
}

// The automatic choice, or the reason there is none. Automatic assignment needs required skills.
export function automaticChoice(ranking: Ranking): { userId: string; reasons: string[] } | { userId: null; reason: string } {
  if (!ranking.skillsKnown) return { userId: null, reason: "Automatic assignment needs required skills on the task." };
  const top = ranking.ranked[0];
  if (!top) return { userId: null, reason: ranking.note ?? "Nobody eligible." };
  return { userId: top.userId, reasons: top.reasons };
}
