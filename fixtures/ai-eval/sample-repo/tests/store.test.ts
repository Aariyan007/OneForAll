import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskStore } from "../src/tasks/store";

test("add trims the title and starts open", () => {
  const store = new TaskStore();
  const task = store.add("  Write report ", null);
  assert.equal(task.title, "Write report");
  assert.equal(task.done, false);
});

test("complete marks a task done and hides it from the list", () => {
  const store = new TaskStore();
  const task = store.add("Ship", null);
  store.complete(task.id);
  assert.equal(store.list().length, 0);
});
