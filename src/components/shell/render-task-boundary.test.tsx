// Unit tests for RenderTaskBoundary (the server-render task split that prevents the deep-route stack overflow).
// Run: compile with --jsx react-jsx (see docs/repository-graph.md, "Tests") and run with node --test.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { RenderTaskBoundary } from "./render-task-boundary";

async function renderToText(element: ReactElement): Promise<{ html: string; errors: unknown[] }> {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(element, { onError: (error) => void errors.push(error) });
  await stream.allReady;
  return { html: await new Response(stream).text(), errors };
}

describe("RenderTaskBoundary on the server", () => {
  it("suspends once, then renders its children (no hang, no error, no fallback left behind)", async () => {
    let renders = 0;
    function Child() {
      renders++;
      return <p>child content</p>;
    }
    const { html, errors } = await renderToText(
      <main>
        <RenderTaskBoundary>
          <Child />
        </RenderTaskBoundary>
      </main>,
    );
    assert.deepEqual(errors, []);
    assert.match(html, /<main><p>child content<\/p><\/main>/);
    assert.equal(renders, 1, "children render once, after the boundary resumed");
  });

  it("works when nested (each boundary splits once)", async () => {
    const { html, errors } = await renderToText(
      <RenderTaskBoundary>
        <RenderTaskBoundary>
          <span>deep</span>
        </RenderTaskBoundary>
      </RenderTaskBoundary>,
    );
    assert.deepEqual(errors, []);
    assert.match(html, /<span>deep<\/span>/);
  });

  it("a deep tree with a split every 50 levels renders completely and in order", async () => {
    // (The stack effect itself is verified end to end against the Next.js dev server; see docs/repository-graph.md.)
    function Heavy({ depth }: { depth: number }): ReactElement {
      const pad = new Array(64).fill(depth);
      const child = depth === 0 ? <b>{pad.length}</b> : <Heavy depth={depth - 1} />;
      return depth % 50 === 0 ? <RenderTaskBoundary>{child}</RenderTaskBoundary> : child;
    }
    const { html, errors } = await renderToText(<Heavy depth={3000} />);
    assert.deepEqual(errors, []);
    assert.match(html, /<b>64<\/b>/);
  });
});
