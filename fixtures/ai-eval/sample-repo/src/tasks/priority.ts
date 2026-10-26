import type { Task } from "./store";

const WEIGHTS = { low: 1, medium: 2, high: 3 } as const;

// Higher score = shown earlier. Tasks due within 24 hours get a bonus of 10.
export function priorityScore(task: Task, now: Date = new Date()): number {
  const base = WEIGHTS[task.priority];
  if (task.dueDate === null) return base;
  const hoursLeft = (task.dueDate.getTime() - now.getTime()) / 3_600_000;
  return hoursLeft <= 24 ? base + 10 : base;
}
