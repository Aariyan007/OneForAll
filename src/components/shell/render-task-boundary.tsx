"use client";

import { use } from "react";

// Starts `children` as a separate server-rendering task, on a fresh call stack.
//
// Why: the deepest routes (a snapshot and its graph) nest 13-14 route segments, and Next.js wraps every segment in
// about a dozen router components. In development React runs each component render inside console.createTask().run()
// (owner stacks), which costs about 2 KB of native stack per level, so those routes exhausted Node's default stack
// (RangeError: Maximum call stack size exceeded). React normally recovers from such an overflow by re-rendering the
// subtree as a new task, but not when the overflow happens while the RSC client is initialising a client-module
// chunk: that error is stored in the chunk, every retry re-throws it, and the page falls back to client rendering.
//
// Suspending here once makes React's streaming renderer continue `children` from a new task, scheduled on its own
// macrotask, so each task's stack only holds the levels below its own starting point. Server only: in the browser
// this renders `children` directly, so hydration and client navigation are unchanged. The cost is one macrotask per
// server render.
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function RenderTaskBoundary({ children }: { children: React.ReactNode }) {
  // React replays the settled promise when it retries this component, so it suspends exactly once per render.
  if (typeof window === "undefined") use(nextMacrotask());
  return children;
}
