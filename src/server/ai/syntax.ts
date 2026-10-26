// Relative import (not "@/"): keeps this module runnable by the plain-Node tests.
import { getParserAdapter } from "../repository-structure/parser-registry";

// Syntax check of generated code with the tree-sitter grammars structure analysis already uses. true = parses
// cleanly, false = syntax error, null = language not supported or the parser could not run (no claim either way).

const LANGUAGE_ALIASES: Record<string, { language: string; path: string }> = {
  typescript: { language: "TypeScript", path: "generated.ts" },
  ts: { language: "TypeScript", path: "generated.ts" },
  tsx: { language: "TypeScript", path: "generated.tsx" },
  javascript: { language: "JavaScript", path: "generated.js" },
  js: { language: "JavaScript", path: "generated.js" },
  jsx: { language: "JavaScript", path: "generated.jsx" },
  python: { language: "Python", path: "generated.py" },
  py: { language: "Python", path: "generated.py" },
  java: { language: "Java", path: "Generated.java" },
};

export async function checkSyntax(language: string, code: string): Promise<boolean | null> {
  const target = LANGUAGE_ALIASES[language.trim().toLowerCase()];
  const adapter = target ? getParserAdapter(target.language) : null;
  if (!target || !adapter) return null;
  const result = await adapter.parse({ path: target.path, source: code });
  if (result.ok) return true;
  return result.error.startsWith("Syntax error") ? false : null;
}
