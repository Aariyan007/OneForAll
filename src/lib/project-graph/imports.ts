// Resolves the imports of one source file to other files of the SAME snapshot. Pure and deterministic: it reads the
// import statements with conservative patterns and only reports an edge when the target is a file that exists in the
// snapshot. Package imports (react, os, java.util.List) and anything that cannot be matched are not edges; local-looking
// imports that do not resolve are counted so the UI can say how many were left unresolved.

export type ImportEdge = { target: string; specifier: string };
export type ImportResolution = { edges: ImportEdge[]; unresolvedLocal: number };

const JS_EXT = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs"];
const JS_IMPORT =
  /(?:\bimport|\bexport)\s[^'"`]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+([^\n#]+)/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm;
const JAVA_IMPORT = /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+?)(?:\.\*)?[ \t]*;/gm;

function join(dir: string, spec: string): string | null {
  const parts = dir === "" ? [] : dir.split("/");
  for (const segment of spec.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null; // would leave the repository
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function resolveJs(path: string, text: string, all: ReadonlySet<string>): ImportResolution {
  const found = new Map<string, string>();
  let unresolved = 0;
  for (const match of text.matchAll(JS_IMPORT)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!spec) continue;
    let base: string | null = null;
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") base = join(dirOf(path), spec);
    else if (spec.startsWith("@/")) base = join("src", spec.slice(2));
    else if (spec.startsWith("~/")) base = join("src", spec.slice(2));
    else continue; // a package
    if (base === null) {
      unresolved++;
      continue;
    }
    const hit = JS_EXT.map((ext) => `${base}${ext}`).find((candidate) => all.has(candidate));
    if (hit && hit !== path) found.set(hit, spec);
    else if (!hit) unresolved++;
  }
  return { edges: [...found].map(([target, specifier]) => ({ target, specifier })), unresolvedLocal: unresolved };
}

function pyCandidates(modulePath: string): string[] {
  return [`${modulePath}.py`, `${modulePath}/__init__.py`];
}

function resolvePython(path: string, text: string, all: ReadonlySet<string>): ImportResolution {
  const found = new Map<string, string>();
  let unresolved = 0;
  const add = (target: string | undefined, spec: string) => {
    if (target && target !== path) found.set(target, spec);
  };
  // Absolute module names are matched as a path suffix, so a "src/" layout or any package root still resolves.
  const byAbsolute = (modName: string): string | undefined => {
    const wanted = pyCandidates(modName.replace(/\./g, "/"));
    return [...all].find((p) => wanted.some((w) => p === w || p.endsWith(`/${w}`)));
  };
  for (const match of text.matchAll(PY_FROM)) {
    const dots = match[1].length;
    const modName = match[2];
    const names = match[3].replace(/[()]/g, "").split(",").map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    if (dots > 0) {
      let base: string | null = dirOf(path);
      for (let i = 1; i < dots && base !== null; i++) base = join(base, "..");
      if (base === null) {
        unresolved++;
        continue;
      }
      const moduleDir = modName ? join(base, modName.replace(/\./g, "/")) : base;
      let any = false;
      for (const target of pyCandidates(moduleDir ?? "").filter((c) => all.has(c))) {
        add(target, `${".".repeat(dots)}${modName}`);
        any = true;
      }
      // "from . import leaf" or "from .sub import leaf": the imported name may itself be a modName.
      for (const name of names) {
        const sub = pyCandidates(join(moduleDir ?? "", name) ?? "").find((c) => all.has(c));
        if (sub) {
          add(sub, `${".".repeat(dots)}${modName}.${name}`);
          any = true;
        }
      }
      if (!any) unresolved++;
    } else {
      const direct = byAbsolute(modName);
      if (direct) add(direct, modName);
      for (const name of names) {
        const sub = byAbsolute(`${modName}.${name}`);
        if (sub) add(sub, `${modName}.${name}`);
      }
    }
  }
  for (const match of text.matchAll(PY_IMPORT)) {
    for (const part of match[1].split(",")) {
      const modName = part.trim().split(/\s+as\s+/)[0];
      add(byAbsolute(modName), modName);
    }
  }
  return { edges: [...found].map(([target, specifier]) => ({ target, specifier })), unresolvedLocal: unresolved };
}

function resolveJava(path: string, text: string, all: ReadonlySet<string>): ImportResolution {
  const found = new Map<string, string>();
  for (const match of text.matchAll(JAVA_IMPORT)) {
    const wanted = `${match[1].replace(/\./g, "/")}.java`;
    const target = [...all].find((p) => p === wanted || p.endsWith(`/${wanted}`));
    if (target && target !== path) found.set(target, match[1]);
  }
  return { edges: [...found].map(([target, specifier]) => ({ target, specifier })), unresolvedLocal: 0 };
}

export function resolveImports(path: string, text: string, all: ReadonlySet<string>): ImportResolution {
  if (/\.(?:[cm]?[jt]sx?)$/.test(path)) return resolveJs(path, text, all);
  if (/\.py$/.test(path)) return resolvePython(path, text, all);
  if (/\.java$/.test(path)) return resolveJava(path, text, all);
  return { edges: [], unresolvedLocal: 0 };
}
