import { z } from "zod";
import { TASK_STATUSES } from "@/lib/tasks/workflow";

export { workItemFieldsSchema as taskFieldsSchema } from "@/server/requirements/schema";
export type { WorkItemActionResult as TaskActionResult, WorkItemFormState as TaskFormState } from "@/server/requirements/schema";

// The lifecycle lives in src/lib/tasks/workflow.ts (shared with client components and mirrored by the database).
export { TASK_STATUSES, isAllowedTaskTransition, type TaskStatus } from "@/lib/tasks/workflow";

export const taskStatusSchema = z.enum(TASK_STATUSES, { error: "Invalid status." });
