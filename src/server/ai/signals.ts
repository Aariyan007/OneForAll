// A per-call abort signal: aborts when `outer` aborts or after `timeoutMs`, whichever comes first.
// Built from a plain AbortController and setTimeout on purpose: on Node 22.9 a signal from
// AbortSignal.any([outer, AbortSignal.timeout(ms)]) was observed never to fire (reproduced with a never-answering
// server), which let a hung provider call hang a whole run. Call dispose() when the call settles.
export function callSignal(outer: AbortSignal, timeoutMs: number): { signal: AbortSignal; timedOut(): boolean; dispose(): void } {
  const controller = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => controller.abort(outer.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The call timed out.", "TimeoutError"));
  }, timeoutMs);
  if (outer.aborted) onOuterAbort();
  else outer.addEventListener("abort", onOuterAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      outer.removeEventListener("abort", onOuterAbort);
    },
  };
}
