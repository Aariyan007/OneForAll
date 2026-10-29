import assert from "node:assert/strict";
import { test } from "node:test";
import { THEME_SCRIPT } from "./theme-script";

function run(storage: { getItem(key: string): string | null }) {
  const documentElement = { dataset: {} as Record<string, string> };
  new Function("localStorage", "document", THEME_SCRIPT)(storage, { documentElement });
  return documentElement.dataset.theme;
}

test("the saved light theme is applied before paint", () => {
  assert.equal(run({ getItem: () => "light" }), "light");
});

test("dark is the default, for a missing or unknown value", () => {
  assert.equal(run({ getItem: () => null }), "dark");
  assert.equal(run({ getItem: () => "purple" }), "dark");
});

test("blocked storage (private mode) falls back to dark instead of throwing", () => {
  assert.equal(run({ getItem: () => { throw new Error("denied"); } }), "dark");
});
