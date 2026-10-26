// Regression test: Next.js 16.3 renamed the error boundary's `unstable_retry` prop to `retry` and 16.4 passes only
// `retry`, so a boundary that still called `unstable_retry` threw when the user pressed "Try again".
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReactElement, ReactNode } from "react";
import RepositoryGraphError from "./error";

type Props = { onClick?: () => void; children?: ReactNode };

function findClickHandler(node: ReactNode): (() => void) | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findClickHandler(child);
      if (found) return found;
    }
    return null;
  }
  const element = node as ReactElement<Props>;
  if (typeof element.props?.onClick === "function") return element.props.onClick;
  return findClickHandler(element.props?.children);
}

describe("RepositoryGraphError", () => {
  it("calls the retry function Next.js passes when the user presses Try again", () => {
    let retries = 0;
    const tree = RepositoryGraphError({ error: new Error("boom"), retry: () => void retries++ });
    const onClick = findClickHandler(tree);
    assert.ok(onClick, "a Try again button is rendered");
    onClick();
    assert.equal(retries, 1);
  });
});
