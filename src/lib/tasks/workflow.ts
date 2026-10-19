// Task lifecycle and who may take which step. Pure; mirrors the database (enforce_task_status_transition() and
// transition_task(), migrations 20261024000001 and 20261027000001), which stays the authority. Used to offer only the
// actions that the database will accept and to explain why others are unavailable.

export const TASK_STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "IN_QA", "COMPLETED", "CANCELLED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  IN_REVIEW: "In review",
  IN_QA: "In QA",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const ACTIVE_STATUSES: readonly TaskStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "IN_QA"];

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  TODO: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "IN_REVIEW", "COMPLETED", "TODO", "CANCELLED"],
  BLOCKED: ["IN_PROGRESS", "CANCELLED"],
  IN_REVIEW: ["IN_QA", "COMPLETED", "IN_PROGRESS", "CANCELLED"],
  IN_QA: ["COMPLETED", "IN_PROGRESS", "CANCELLED"],
  COMPLETED: ["IN_PROGRESS"],
  CANCELLED: ["TODO"],
};

// Steps the assignee may take without being a manager.
const ASSIGNEE_STEPS: readonly [TaskStatus, TaskStatus][] = [
  ["TODO", "IN_PROGRESS"],
  ["IN_PROGRESS", "BLOCKED"],
  ["IN_PROGRESS", "IN_REVIEW"],
  ["IN_PROGRESS", "TODO"],
  ["BLOCKED", "IN_PROGRESS"],
];

// Steps a tester (a member of the responsible team other than the assignee) may take.
const TESTER_STEPS: readonly [TaskStatus, TaskStatus][] = [
  ["IN_QA", "COMPLETED"],
  ["IN_QA", "IN_PROGRESS"],
];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isAllowedTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function reasonRequired(from: TaskStatus, to: TaskStatus): boolean {
  return to === "BLOCKED" || to === "CANCELLED" || ((from === "IN_REVIEW" || from === "IN_QA") && to === "IN_PROGRESS");
}

const ACTION_LABELS: Record<string, string> = {
  "TODO>IN_PROGRESS": "Start work",
  "IN_PROGRESS>BLOCKED": "Report blocker",
  "IN_PROGRESS>IN_REVIEW": "Submit for review",
  "IN_PROGRESS>COMPLETED": "Mark completed",
  "IN_PROGRESS>TODO": "Stop work",
  "BLOCKED>IN_PROGRESS": "Resume",
  "IN_REVIEW>IN_QA": "Send to QA",
  "IN_REVIEW>COMPLETED": "Approve",
  "IN_REVIEW>IN_PROGRESS": "Request changes",
  "IN_QA>COMPLETED": "Pass QA",
  "IN_QA>IN_PROGRESS": "Fail QA",
  "COMPLETED>IN_PROGRESS": "Reopen",
  "CANCELLED>TODO": "Restore",
};

export type TaskAction = { to: TaskStatus; label: string; needsReason: boolean; blockedBy: string | null };

export type ActionActor = { manager: boolean; assignee: boolean; tester?: boolean };
export type ActionContext = { assigned: boolean; openDependencies: number; openDefects?: number; qaRequired?: boolean };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Actions the actor may take from `status`. `blockedBy` explains why an otherwise permitted step would be refused
// right now (unassigned, unfinished dependencies, open defects, QA required).
export function availableActions(status: TaskStatus, actor: ActionActor, context: ActionContext): TaskAction[] {
  const openDefects = context.openDefects ?? 0;
  return TRANSITIONS[status]
    .filter(
      (to) =>
        actor.manager ||
        (actor.assignee && ASSIGNEE_STEPS.some(([f, t]) => f === status && t === to)) ||
        (actor.tester === true && TESTER_STEPS.some(([f, t]) => f === status && t === to)),
    )
    // With QA required, the review leads to QA, never straight to completion.
    .filter((to) => !(context.qaRequired && to === "COMPLETED" && status !== "IN_QA"))
    .map((to) => {
      let blockedBy: string | null = null;
      const fromWork = status === "TODO" || status === "BLOCKED" || status === "IN_PROGRESS" || status === "IN_REVIEW";
      if (status === "TODO" && to === "IN_PROGRESS" && !context.assigned) blockedBy = "Assign the task first.";
      else if (fromWork && (to === "IN_PROGRESS" || to === "IN_REVIEW" || to === "IN_QA" || to === "COMPLETED") && context.openDependencies > 0) {
        blockedBy = `Waiting for ${plural(context.openDependencies, "unfinished dependency", "unfinished dependencies")}.`;
      } else if ((to === "IN_QA" || to === "COMPLETED") && openDefects > 0) {
        blockedBy = `Resolve ${plural(openDefects, "open defect", "open defects")} first.`;
      }
      return { to, label: ACTION_LABELS[`${status}>${to}`] ?? (to === "CANCELLED" ? "Cancel task" : TASK_STATUS_LABELS[to]), needsReason: reasonRequired(status, to), blockedBy };
    });
}

export const DEFECT_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];
