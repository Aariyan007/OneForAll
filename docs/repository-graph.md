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

There is no new table, no migration, no graph database and no copy of the data. The DTOs in `src/lib/repository-graph/types.ts`
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
- **Transfer limit:** analyses with more than **5,000 symbols** or **15,000 relationships** are not sent to the browser. The page shows the real counts and says the graph is too large. It never shows a partial graph as complete. Symbols and relationships are read in pages of 1,000 rows.
- **Canvas limit:** the canvas draws at most **400 symbols** at once. A larger graph opens on one file and explains the limit. Search and summary counts still cover the whole graph. To draw a smaller set, narrow the filters or focus on a symbol.

## Authorization
The server reads everything with the signed-in user's Supabase client, so RLS applies to every step. The chain is checked
from the database, never taken from the URL:

1. organization → department → team → project → repository (`getRepositoryContext`)
2. the snapshot of **that** repository
3. its analysis, which must be `COMPLETED`
4. the symbols and relationships of **that** analysis

Malformed ids, other tenants, mismatched paths, snapshots of other repositories and projects outside the user's teams all
give the same not-found page. The feature adds no Server Actions, API routes, database functions or write paths.

## What it does not mean
- Source enters a snapshot only through an uploaded ZIP archive (see `docs/repository-ingestion.md`). It is recorded as an **unverified** upload. There is still no GitHub or GitLab download.
- The graph shows only what an analysis actually stored. A snapshot without a completed analysis shows an explanatory empty state, and a completed analysis with zero symbols is shown as exactly that.

## Tests
`src/lib/repository-graph/graph.test.ts` uses `node:test` and fixture rows only. It covers the transform, filters, search,
neighbourhood and layout. To run it, compile and run with Node:

```bash
npx tsc src/lib/repository-graph/graph.test.ts --outDir <tmp-dir> --module commonjs --target es2022 --moduleResolution node --skipLibCheck --strict --esModuleInterop --types node
```

```bash
node --test <tmp-dir>
```
