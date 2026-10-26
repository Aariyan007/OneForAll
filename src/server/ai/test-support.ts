// In-memory RepoReader for unit tests and evaluation dry runs: a fixed snapshot as path -> content, with the same
// search semantics as the database functions (case-insensitive, 1-based lines).
import type { FileMeta, RepoReader, RequirementInfo, SymbolHit } from "./tools";

export function memoryReader(
  files: Readonly<Record<string, string>>,
  options: { symbols?: SymbolHit[]; requirements?: Record<string, RequirementInfo> } = {},
): RepoReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async listFiles(): Promise<FileMeta[]> {
      return Object.keys(files)
        .sort()
        .map((path) => ({ path, language: path.endsWith(".ts") ? "TypeScript" : path.endsWith(".py") ? "Python" : null, sizeBytes: files[path].length, hasText: true }));
    },
    async readText(path) {
      reads.push(path);
      return Object.hasOwn(files, path) ? files[path] : null;
    },
    async searchCode(query, limit) {
      const hits: { path: string; line: number; text: string }[] = [];
      for (const path of Object.keys(files).sort()) {
        files[path].split("\n").forEach((text, i) => {
          if (text.toLowerCase().includes(query.toLowerCase())) hits.push({ path, line: i + 1, text: text.replace(/\r$/, "") });
        });
      }
      return hits.slice(0, limit);
    },
    async searchSymbols(query, limit) {
      return (options.symbols ?? []).filter((s) => s.name.toLowerCase().includes(query.toLowerCase())).slice(0, limit);
    },
    async getRequirement(id) {
      return options.requirements?.[id] ?? null;
    },
  };
}
