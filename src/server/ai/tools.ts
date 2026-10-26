import { z } from "zod";
import { MAX_EXCERPT_LINES, lineCount, numberedExcerpt } from "./context";
import type { LlmToolDeclaration } from "./provider/types";
import { redactSecrets } from "./redact";

// Read-only tools the model may call. Every argument comes from model output and is treated as untrusted: it is
// validated with a schema, paths are confined to the snapshot's manifest, outputs are capped and redacted. No tool
// writes anything, runs code, or reaches the network. Data access goes through a RepoReader, which in production acts
// as the signed-in user (RLS decides what is visible).

export type FileMeta = { path: string; language: string | null; sizeBytes: number; hasText: boolean };
export type SymbolHit = { name: string; kind: string; qualifiedName: string | null; path: string; line: number; signature: string | null };
export type RequirementInfo = {
  title: string;
  description: string | null;
  status: string;
  tasks: { title: string; description: string | null; status: string; acceptanceCriteria: string | null }[];
};

export interface RepoReader {
  listFiles(): Promise<FileMeta[]>;
  readText(path: string): Promise<string | null>;
  searchCode(query: string, limit: number): Promise<{ path: string; line: number; text: string }[]>;
  searchSymbols(query: string, limit: number): Promise<SymbolHit[]>;
  getRequirement(id: string): Promise<RequirementInfo | null>;
}

export type ToolContext = { reader: RepoReader; lineCounts: Map<string, number> };
export type ToolResult = { ok: boolean; output: Record<string, unknown> };

const MAX_PATH = 1024;

export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\u0000") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const pathSchema = z.string().max(MAX_PATH).refine(isSafeRepoPath, "Path must be a relative path inside the snapshot");

const MAX_LINE_TEXT = 300;
const clip = (text: string) => (text.length > MAX_LINE_TEXT ? `${text.slice(0, MAX_LINE_TEXT)}…` : text);

type ToolDef<S extends z.ZodTypeAny> = {
  description: string;
  schema: S;
  sideEffects: "none";
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
};

function tool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export const TOOLS = {
  search_code: tool({
    description: "Case-insensitive plain-text search over the snapshot's source files. Returns matching lines with file path and 1-based line number.",
    schema: z.object({ query: z.string().min(2).max(200), limit: z.number().int().min(1).max(20).optional() }).strict(),
    sideEffects: "none",
    async run(args, ctx) {
      const matches = await ctx.reader.searchCode(args.query, args.limit ?? 10);
      let redactions = 0;
      const safe = matches.map((m) => {
        const r = redactSecrets(m.text);
        redactions += r.count;
        return { path: m.path, line: m.line, text: clip(r.text) };
      });
      return { ok: true, output: { matches: safe, redactions } };
    },
  }),
  search_symbols: tool({
    description: "Find functions, classes, methods and other symbols by name (from the structure analysis). Returns file path and 1-based start line.",
    schema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).optional() }).strict(),
    sideEffects: "none",
    async run(args, ctx) {
      const symbols = await ctx.reader.searchSymbols(args.query, args.limit ?? 10);
      return {
        ok: true,
        output: { symbols: symbols.map((s) => ({ ...s, signature: s.signature ? clip(s.signature) : null })) },
      };
    },
  }),
  read_file: tool({
    description: `Read lines of one snapshot file, numbered from 1. At most ${MAX_EXCERPT_LINES} lines per call; omit the range to read from the start.`,
    schema: z
      .object({ path: pathSchema, startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() })
      .strict(),
    sideEffects: "none",
    async run(args, ctx) {
      const content = await ctx.reader.readText(args.path);
      if (content === null) return { ok: false, output: { error: `${args.path} is not in this snapshot, or its text is not stored.` } };
      ctx.lineCounts.set(args.path, lineCount(content));
      const start = args.startLine ?? 1;
      const end = args.endLine ?? start + MAX_EXCERPT_LINES - 1;
      const excerpt = numberedExcerpt(content, start, end);
      const redacted = redactSecrets(excerpt.text);
      return {
        ok: true,
        output: {
          path: args.path,
          startLine: excerpt.startLine,
          endLine: excerpt.endLine,
          totalLines: excerpt.totalLines,
          // More of the file exists after this excerpt (read again with a later startLine).
          truncated: excerpt.endLine < excerpt.totalLines,
          text: redacted.text,
          redactions: redacted.count,
        },
      };
    },
  }),
  list_files: tool({
    description: "List snapshot files (path, language, size), optionally under a path prefix such as 'src/tasks/'. At most 200 entries.",
    schema: z.object({ prefix: z.string().max(MAX_PATH).optional() }).strict(),
    sideEffects: "none",
    async run(args, ctx) {
      const all = await ctx.reader.listFiles();
      const matching = all.filter((f) => !args.prefix || f.path.startsWith(args.prefix));
      return {
        ok: true,
        output: { files: matching.slice(0, 200).map((f) => ({ path: f.path, language: f.language, sizeBytes: f.sizeBytes })), total: matching.length },
      };
    },
  }),
} as const;

export type ToolName = keyof typeof TOOLS;

export function toolDeclarations(names: readonly ToolName[]): LlmToolDeclaration[] {
  return names.map((name) => {
    const parameters = { ...(z.toJSONSchema(TOOLS[name].schema) as Record<string, unknown>) };
    delete parameters.$schema;
    return { name, description: TOOLS[name].description, parameters };
  });
}

export async function runTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!Object.hasOwn(TOOLS, name)) return { ok: false, output: { error: `Unknown tool ${name}.` } };
  const def = TOOLS[name as ToolName];
  const parsed = def.schema.safeParse(args);
  if (!parsed.success) return { ok: false, output: { error: `Invalid arguments: ${parsed.error.issues[0]?.message ?? "invalid"}` } };
  try {
    // Each tool's schema and run() match by construction; the cast only bridges the union.
    return await (def.run as (a: unknown, c: ToolContext) => Promise<ToolResult>)(parsed.data, ctx);
  } catch {
    return { ok: false, output: { error: "The tool failed. Try a different request." } };
  }
}
