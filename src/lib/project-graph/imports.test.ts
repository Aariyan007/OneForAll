import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveImports } from "./imports";

const paths = new Set([
  "src/app.ts", "src/util/math.ts", "src/util/index.ts", "src/components/Button.tsx", "lib/helper.js", "pkg/core.py", "pkg/sub/__init__.py",
  "pkg/sub/leaf.py", "main.py", "src/main/java/com/acme/Service.java", "src/main/java/com/acme/util/Strings.java",
]);
const edges = (path: string, text: string) => resolveImports(path, text, paths).edges.map((e) => `${e.target}`).sort();

describe("resolveImports: JavaScript and TypeScript", () => {
  it("resolves relative imports, extensions and index files", () => {
    assert.deepEqual(edges("src/app.ts", `import { add } from "./util/math";\nimport u from './util';\nconst h = require("../lib/helper");`), ["lib/helper.js", "src/util/index.ts", "src/util/math.ts"]);
  });
  it("resolves the @/ alias to src/", () => {
    assert.deepEqual(edges("src/app.ts", `import { Button } from "@/components/Button";`), ["src/components/Button.tsx"]);
  });
  it("handles export-from and side-effect imports and ignores packages", () => {
    assert.deepEqual(edges("src/app.ts", `export * from "./util/math";\nimport "./util";\nimport React from "react";`), ["src/util/index.ts", "src/util/math.ts"]);
  });
  it("counts specifiers it cannot resolve to a file of the snapshot", () => {
    const r = resolveImports("src/app.ts", `import x from "./missing";\nimport y from "react";`, paths);
    assert.equal(r.edges.length, 0);
    assert.equal(r.unresolvedLocal, 1);
  });
  it("never resolves outside the repository", () => {
    assert.deepEqual(edges("src/app.ts", `import x from "../../../etc/passwd";`), []);
  });
});

describe("resolveImports: Python", () => {
  it("resolves relative and absolute imports to modules and packages", () => {
    assert.deepEqual(edges("pkg/core.py", `from .sub import leaf\nfrom .sub.leaf import thing`), ["pkg/sub/__init__.py", "pkg/sub/leaf.py"]);
    assert.deepEqual(edges("main.py", `import pkg.core\nfrom pkg.sub import leaf\nimport os`), ["pkg/core.py", "pkg/sub/__init__.py", "pkg/sub/leaf.py"]);
  });
});

describe("resolveImports: Java", () => {
  it("resolves package imports by path suffix", () => {
    assert.deepEqual(edges("src/main/java/com/acme/Service.java", `import com.acme.util.Strings;\nimport java.util.List;`), ["src/main/java/com/acme/util/Strings.java"]);
  });
});

describe("resolveImports: other files", () => {
  it("returns nothing for unsupported languages", () => {
    assert.deepEqual(edges("README.md", `import x from "./a"`), []);
  });
  it("never links a file to itself", () => {
    assert.deepEqual(edges("src/util/math.ts", `import m from "./math";`), []);
  });
});
