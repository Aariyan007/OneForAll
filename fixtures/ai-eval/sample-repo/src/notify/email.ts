import type { Task } from "../tasks/store";

// Plain-text reminder for overdue tasks. Returns null when there is nothing to remind about.
export function formatReminder(userName: string, overdue: Task[]): string | null {
  if (overdue.length === 0) return null;
  const lines = overdue.map((t) => `- ${t.title}${t.dueDate ? ` (due ${t.dueDate.toISOString().slice(0, 10)})` : ""}`);
  return [`Hi ${userName},`, "", `You have ${overdue.length} overdue task(s):`, ...lines].join("\n");
}
