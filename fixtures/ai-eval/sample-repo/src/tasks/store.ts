import { priorityScore } from "./priority";

export type Task = {
  id: number;
  title: string;
  dueDate: Date | null;
  done: boolean;
  priority: "low" | "medium" | "high";
};

export class TaskStore {
  private tasks: Task[] = [];
  private nextId = 1;

  add(title: string, dueDate: Date | null, priority: Task["priority"] = "medium"): Task {
    if (title.trim().length === 0) throw new Error("A task needs a title");
    const task: Task = { id: this.nextId++, title: title.trim(), dueDate, done: false, priority };
    this.tasks.push(task);
    return task;
  }

  complete(id: number): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`Task ${id} not found`);
    task.done = true;
  }

  // Open tasks, highest priority first.
  list(): Task[] {
    return this.tasks.filter((t) => !t.done).sort((a, b) => priorityScore(b) - priorityScore(a));
  }

  // Open tasks whose due date has passed.
  findOverdue(now: Date): Task[] {
    return this.tasks.filter((t) => !t.done && t.dueDate !== null && t.dueDate.getTime() > now.getTime());
  }
}
