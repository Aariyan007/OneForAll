// Regression tests: on Node 22.9 a signal from AbortSignal.any([outer, AbortSignal.timeout(ms)]) never fired, so a
// hung provider call hung the whole AI run (observed live: a run stuck in "generating" for over 4 minutes).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callSignal } from "./signals";

describe("callSignal", () => {
  it("aborts after the timeout even while garbage collection runs", async () => {
    const outer = new AbortController();
    const call = callSignal(outer.signal, 50);
    const gc = (globalThis as { gc?: () => void }).gc;
    const timer = setInterval(() => gc?.(), 5);
    await new Promise((r) => setTimeout(r, 120));
    clearInterval(timer);
    assert.equal(call.signal.aborted, true);
    assert.equal(call.timedOut(), true);
    call.dispose();
  });

  it("aborts at once when the outer signal aborts, and is not a timeout then", () => {
    const outer = new AbortController();
    const call = callSignal(outer.signal, 10_000);
    outer.abort();
    assert.equal(call.signal.aborted, true);
    assert.equal(call.timedOut(), false);
    call.dispose();
  });

  it("starts aborted when the outer signal already is", () => {
    const outer = new AbortController();
    outer.abort();
    assert.equal(callSignal(outer.signal, 10_000).signal.aborted, true);
  });

  it("stops its timer on dispose", async () => {
    const call = callSignal(new AbortController().signal, 30);
    call.dispose();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(call.signal.aborted, false);
  });
});
