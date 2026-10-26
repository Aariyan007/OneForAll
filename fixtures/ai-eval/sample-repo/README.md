# Taskly (evaluation fixture)

A tiny task tracker used to evaluate the OneForAll AI assistant. It is not a real product.

- `src/tasks/store.ts`: in-memory task store (add, complete, list, overdue tasks).
- `src/tasks/priority.ts`: priority scoring used to sort the task list.
- `src/auth/session.ts`: session expiry check.
- `src/notify/email.ts`: reminder email formatting.
- `scripts/report.py`: weekly completion report.
