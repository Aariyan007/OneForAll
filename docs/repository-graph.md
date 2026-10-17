# Repository Graph

A read-only, interactive view of the structure that a **completed Phase 2H structure analysis** stored for one
repository snapshot.

Route: `/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/repository/snapshots/[snapshotId]/graph`

You can open it from two places:
- **Project → Repository Intelligence → "Open repository graph"**: the latest completed snapshot, when its analysis is COMPLETED.
- **Snapshots list → "Repository graph"**: any snapshot whose status is COMPLETED.

## What it shows

| Graph element | Source (PostgreSQL, Phase 2H) | Id |
| --- | --- | --- |
| Node | `repository_symbols` row of the analysis | symbol UUID |
| Edge | `repository_symbol_relationships` row of the analysis | relationship UUID |
| File path | `repository_files.path` (via `repository_symbols.file_id`) | — |
| Snapshot context | `repository_snapshots` (commit SHA, branch) | — |

There is no new table, no graph database and no copy of the data. Large analyses are read through bounded, read-only
`SECURITY INVOKER` functions (migration `20261020000001`, see "Large analyses"). The DTOs in `src/lib/repository-graph/types.ts`
expose only display fields. Run tokens, signatures of the persistence layer and manifest hashes are never sent to the browser.

Only rows of the selected analysis are used. `buildRepositoryGraph` (`src/lib/repository-graph/transform.ts`) applies these rules:
- **Nodes:** a row is rejected if it has an unknown kind, an empty name, a malformed line or a duplicate id.
- **Edges:** a row is rejected if it belongs to another analysis, has a missing or same-node endpoint, an unknown type or a duplicate id.

Rejected rows are counted, never repaired. The page warns if the graph differs from the counts recorded on the analysis row.

### Symbol kinds
`MODULE` (a file, or an imported name), `CLASS`, `INTERFACE`, `FUNCTION`, `METHOD`, `CONSTRUCTOR`, `ENUM`, `VARIABLE`,
`CONSTANT`, `TYPE`. These are exactly the values the parsers store. Each kind has a text label and a glyph, so meaning never
depends on colour alone.

### Relationship types and direction
Every arrow points from the **stored source** to the **stored target**. Nothing is reversed for display.

| Type | Meaning (as emitted by the current parsers) |
| --- | --- |
| `CONTAINS` | container → contained element (file module → top-level symbol, class → member) |
| `IMPORTS` | file module → imported name. The name is a `MODULE` symbol inside the same file and is **not resolved** to another file. |
| `EXTENDS` | subtype → base type, only when the base is a top-level type of the same file |
| `IMPLEMENTS` | class → interface, same rule |
| `CALLS`, `REFERENCES` | allowed by the schema but **not extracted by the current analyzer**, so they never appear |

The graph never fabricates call graphs, cross-file dependencies or reference edges. The legend says so on the page when
those types are absent.

## Views: complete graph, overview, file view, focused subgraph
Every view says which of these it is (`data-graph-mode` on the label) and never presents a partial view as complete.

| Analysis size | What the page shows |
| --- | --- |
| up to **5,000 symbols and 15,000 relationships** | **Complete graph**: every symbol and relationship is loaded once; filters and focus only change what is drawn. |
| larger | **Overview** first, then **file views** and **focused subgraphs** loaded on demand in bounded pieces. The whole graph is never sent. |

### Large analyses
- **Overview** (sent with the page): folders and files that have symbols, with symbol and relationship counts per file and folder. Folders start collapsed and the list renders in steps of 300 rows. No symbols are drawn. When the analysis stores no relationships between files (today's analyzer records imports as names inside each file), the page says so instead of drawing invented file-to-file edges.
- **Search** (server): plain-text, case-insensitive match on name and qualified name over the whole analysis; the first 20 results plus the total number of matches. Picking a result opens a focused subgraph.
- **File view**: all symbols of one file (at most 999), every relationship touching them (at most 1,999) and the symbols at the other end of those relationships. The label states the file's symbol count; if a limit is hit it says so.
- **Focused subgraph**: one symbol and its immediate neighbours (at most 200 relationships). **Expand neighbours** adds the neighbours of another symbol; **New view from here** starts over from a symbol. A view holds at most 400 symbols (what the canvas can draw); an expansion that would exceed this is refused with a message, never silently cut.
- **Completeness**: every loaded symbol carries its stored relationship count. A symbol with stored relationships that are not in the view shows a **+n** badge and "x of y relationships are in this view"; the view label counts them. Filters (kinds, relationship types, file, focus) work on the loaded view.
- **Data route** (read-only): `GET …/snapshots/[snapshotId]/graph/data?op=search&q=…`, `?op=file&fileId=…`, `?op=neighbours&symbolId=…`. Each request re-verifies the session and the whole chain (below); malformed, missing and not-permitted targets all give 404; responses are `private, no-store`; errors are logged on the server and never expose details.
- **Database functions** (`20261020000001`, all `SECURITY INVOKER`, empty `search_path`, EXECUTE for `authenticated` only): `repository_graph_overview`, `repository_graph_summary`, `repository_graph_search`, `repository_graph_symbols`, `repository_graph_edges`. RLS of the caller applies, so another tenant's or another team's analysis yields no rows. Every result is limited inside the function (search 50 rows, ids 1,000 per call, symbols 1,000, relationships 2,000).

## Interaction
- **Search:** case-insensitive substring match on the name and qualified name, as plain text (never a pattern). It covers the whole graph. A result hidden by filters is marked, and **Show it** reveals it.
- **Filters:** symbol kinds, relationship types and a single file. An edge is drawn only when its type is enabled and both endpoints are visible, so a filter never leaves a dangling edge.
- **Selection:**
  - A **node** shows its stored metadata (missing optional fields read "Not available") and its direct incoming and outgoing relationships.
  - An **edge** shows its type, direction, source and target.
- **Focus on direct neighbours:** shows only the selected node and the nodes one relationship away, through the enabled types. There is no recursive traversal.
- **Reset view:** restores all filters and clears the search, focus and selection.
- **Canvas:** drag to pan, use the wheel or a pinch to zoom, or use the buttons for zoom in, zoom out and fit. Nodes are focusable (Tab) and selectable (Enter or Space).

## Layout
The layout is deterministic and needs no layout library (`layoutGraph` in `src/lib/repository-graph/view.ts`):
- Each file is a group.
- A symbol sits below its `CONTAINS` parent, or below the module that `IMPORTS` it.
- Childless children form a compact grid; children with their own children sit side by side.
- File groups wrap into rows.

## Limits
All limits live in `src/lib/repository-graph/explore.ts` (shared by server and UI) and are repeated inside the database functions.
- **Complete graph:** up to **5,000 symbols** and **15,000 relationships**, read in pages of 1,000 rows. Larger analyses are explored (above), not refused.
- **Canvas:** at most **400 symbols** drawn at once. A larger complete graph opens on one file; a larger file view asks to narrow the filters.
- **Explored views:** file view 999 symbols / 1,999 relationships; neighbours 200 relationships; one view 400 symbols; search 20 results.
- **No recursion over data:** the layout (`layoutGraph`), the overview tree and all merging are iterative, so containment depth or file count can never exhaust the call stack.

## Development server: deep routes and the call stack
The snapshot and graph routes nest 13-14 route segments, and Next.js wraps every segment in about a dozen router components.
In development React runs each component render inside `console.createTask().run()` (owner stacks), which costs about 2 KB of
native stack per level, so these routes exhausted Node's default stack during server rendering (`RangeError: Maximum call
stack size exceeded`, then "Switched to client rendering"). React normally recovers from such an overflow, but not when it
happens while the RSC client initialises a client-module chunk: that error is stored in the chunk and re-thrown.
`projects/[projectId]/layout.tsx` renders everything below a project inside `RenderTaskBoundary`
(`src/components/shell/render-task-boundary.tsx`), which suspends once on the server so React continues the subtree as a new
task on a fresh stack. It is independent of graph size (it also happened for an empty snapshot) and does nothing in the browser.

**Stale dev routes (404 for a route that exists).** Turbopack keeps a filesystem cache for `next dev` in
`.next/dev/cache/turbopack` (on by default in Next.js 16). After route files are added or moved, a dev server started on that
cache can answer an existing route with the not-found page, while `next build` / `next start` serve it correctly. This was
reproduced again on 2026-10-17 for the graph route. Stop the dev server and start it with `npm run dev:clean`, which deletes only
that cache folder and then runs `next dev`. The production build is not affected.

## Authorization
The server reads everything with the signed-in user's Supabase client, so RLS applies to every step. The chain is checked
from the database, never taken from the URL:

1. organization → department → team → project → repository (`getRepositoryContext`)
2. the snapshot of **that** repository
3. its analysis, which must be `COMPLETED`
4. the symbols and relationships of **that** analysis

Malformed ids, other tenants, mismatched paths, snapshots of other repositories and projects outside the user's teams all
give the same not-found page (and 404 from the data route). The feature adds no Server Actions and no write paths; its data
route and database functions are read-only.

## What it does not mean
- Source enters a snapshot through an uploaded ZIP archive (recorded as **unverified**) or a GitHub import of an exact commit (recorded as **provider-fetched**); see `docs/repository-ingestion.md`. There is no GitLab or Bitbucket download.
- The graph shows only what an analysis actually stored. A snapshot without a completed analysis shows an explanatory empty state, and a completed analysis with zero symbols is shown as exactly that.

## Tests
- `src/lib/repository-graph/graph.test.ts`: transform, filters, search, neighbourhood and layout.
- `src/lib/repository-graph/explore.test.ts`: mode choice (including analyses over 5,000 symbols), merging pieces and expansion, the node cap, completeness accounting (isolated symbols, symbols with many neighbours, truncated requests), relationship filtering on a merged view, the overview tree, and the iterative layout on a 50,000-deep containment chain and 150,000 files.
- `src/components/shell/render-task-boundary.test.tsx` (compile with `--jsx react-jsx`): the boundary suspends once and renders its children, nested and deep.
- `supabase/tests/repository_graph_read_rls.sql`: privileges of the read functions, visibility for owner / team member / other team / other tenant, bounds and plain-text search.

The unit tests use `node:test` and fixture rows only. To run one, compile it and run it with Node:

```bash
npx tsc src/lib/repository-graph/graph.test.ts --outDir <tmp-dir> --module commonjs --target es2022 --moduleResolution node --skipLibCheck --strict --esModuleInterop --types node
```

```bash
node --test <tmp-dir>
```
