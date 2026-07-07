# Causet DSL — VS Code / Cursor Extension

**Write the rules. Trust the runtime.**

First-class language support for [Causet](https://www.causet.io) `.causet` files in VS Code and Cursor — syntax highlighting, semantic tokens, go-to-definition, find references, rename, diagnostics, completions, CodeLens, and more.

---

## Features

### Syntax Highlighting
Full TextMate grammar with 30+ repository sections covering every construct in the Causet DSL: top-level sections, operations, SQL types, namespace prefixes, built-in functions, slash paths, expressions, and operator tokens.

Includes two built-in themes:
- **Causet Dark** — deep blue/purple base, inspired by Catppuccin
- **Causet Light** — high-contrast light theme

### Semantic Highlighting
Fine-grained semantic tokens that distinguish:
- Event names (`SCREAMING_SNAKE_CASE`) vs. action names vs. projection names
- Entity state access (`entity.field`) vs. event payload (`event.field`) vs. resource lookup (`resources.catalog[key].value`)
- Built-in functions vs. user-defined symbols
- Forbidden (non-deterministic) functions flagged as errors

### Completions
Context-aware completions for:
- Top-level section keywords (`state:`, `events:`, `actions:`, etc.)
- All operation types (`set`, `add`, `sub`, `push`, `filter`, `find`, `emit`, `emit_each`, `lock`, `unlock`, `lookup`, `relationship_create`, …)
- Event names, action names, projection names, entity names from the workspace
- SQL column types (`TEXT`, `INT`, `BIGINT`, `DOUBLE`, `TIMESTAMP`, …)
- DSL scalar types (`string`, `int`, `boolean`, `array`, `object`, …)
- Partition strategies (`range`, `hash`, `list`)
- Causal ordering modes (`per_entity`, `per_aggregate`, `global`)
- Aggregate functions (`sum`, `count`, `avg`)
- Namespace members (`event.`, `entity.`, `intent.`, `input.`, `resources.`, `envelope.`, …)

### Hover Documentation
Hover any keyword, operation, namespace, or built-in function to see structured documentation:
- What the construct does
- Which rule phase it belongs to
- Cross-references (e.g. which projection consumes a given event)
- Code examples

### Diagnostics
30+ real-time semantic checks:
- Unknown event references in `source_events:` or `event_type:`
- Missing `primary_key` in projection target
- Reserved field names shadowing envelope fields (`type`, `ts`, `entity_id`)
- Non-deterministic functions (`now()`, `random()`, `uuid()`) flagged as errors
- Duplicate field names
- Unknown entity/projection/query references

### Go to Definition
Navigate to the definition of any:
- Event (`SHOW_PUBLISHED` → `show.events.causet`)
- Action (`PUBLISH_SHOW` → `show.actions.causet`)
- Projection / query / entity / relationship
- Commit envelope

Works across files in the workspace.

### Find References
Find every place an event, action, projection, or entity is used — in `emit`, `source_events`, `from:`, `relationship_create`, etc.

### Rename Symbol
Rename any event, action, projection, entity, query, or relationship. All references across the workspace update atomically. Naming-convention validation included (`SCREAMING_SNAKE_CASE` for events/actions, `snake_case` for projections/entities).

### CodeLens
Inline annotations above definitions:
- `N source events` — above each projection
- `Consumed by N projections` — above each event
- `N actions produce this` — above each event
- `Produced by: ACTION_NAME` — contextual links

### Document Symbols & Outline
Full Outline panel support — expand any `.causet` file to see all entities, events, actions, projections, queries, relationships, listeners, sagas, and commit envelopes as a tree.

### Workspace Symbol Search
`⌘T` / `Ctrl+T` — search for any symbol by name across all `.causet` files in the workspace.

### Snippets
44+ snippets covering every file type and major construct:

| Prefix | Description |
|--------|-------------|
| `app` | Root `app.causet` manifest (full include paths) |
| `state` | Entity state definition with fields |
| `events` | Full `.events.causet` file |
| `actions` | Full `.actions.causet` file |
| `projections` | Full `.projections.causet` file |
| `queries` | Full `.queries.causet` file |
| `relationships` | Relationship definition |
| `saga` | Multi-step saga state machine |
| `resources` | Static lookup table |
| `commit_envelope` / `2pc` | Full 2-phase commit envelope definition |
| `projection-range` | Projection with PostgreSQL RANGE partitioning |
| `projection-hash` | Projection with HASH partitioning |
| `projection-list` | Projection with LIST partitioning |
| `query-sum` | Query with GROUP BY and SUM aggregate |
| `op-lock` / `lock` | Lock/unlock operation pair |
| `op-lookup` / `lookup` | Cross-stream snapshot lookup |
| `emit_each` / `fan-out` | Fan-out emit over array |
| `clock-tick` | System clock event for commit envelope timeouts |

### File Icons
Custom icons for all `.causet` file subtypes:

| File | Icon |
|------|------|
| `app.causet` | Causet logo |
| `*.state.causet` | State / entity icon |
| `*.events.causet` | Events icon |
| `*.actions.causet` | Actions icon |
| `*.projections.causet` | Projections icon |
| `*.queries.causet` | Queries icon |
| `*.relationships.causet` | Relationships icon |
| `*.causet` (generic) | Generic Causet file icon |

### Folding
- Fold any top-level section, entity, event, action, projection, or query block
- `#region` / `#endregion` markers for manual folding

### Formatting
- Trailing whitespace removal
- Tab → 2-space conversion
- Normalize consecutive blank lines
- Trim trailing newlines

---

## DSL Coverage

The extension is derived directly from the [causet-dsl-showcase](docs/examples/causet-dsl-showcase/) — every construct visible in the showcase is represented:

| Section | Highlighted | Hover | Completions | Diagnostics |
|---------|:-----------:|:-----:|:-----------:|:-----------:|
| `state` | ✓ | ✓ | ✓ | ✓ |
| `events` | ✓ | ✓ | ✓ | ✓ |
| `actions` (all ops) | ✓ | ✓ | ✓ | ✓ |
| `projections` | ✓ | ✓ | ✓ | ✓ |
| `projections` — `partition:` | ✓ | ✓ | ✓ | — |
| `queries` — joins, sum, window | ✓ | ✓ | ✓ | ✓ |
| `relationships` | ✓ | ✓ | ✓ | ✓ |
| `listeners` | ✓ | ✓ | ✓ | — |
| `sagas` | ✓ | ✓ | ✓ | — |
| `resources` | ✓ | ✓ | ✓ | — |
| `commit_envelopes` | ✓ | ✓ | ✓ | — |

### Operations covered

`set` · `add` · `sub` · `unset` · `merge` · `push` · `remove` · `filter` · `find` · `map` · `sort` · `clone` · `if` · `for_each` · `emit` · `emit_each` · `submit` · `reject` · `schedule` · `lock` · `unlock` · `lookup` · `relationship_create` · `relationship_remove` · `increment`

### Namespaces covered

`event.*` · `event.payload.*` · `entity.*` · `intent.*` · `input.*` · `state.*` · `resources.*[key].*` · `it.*` · `item.*` · `envelope.*` · `derived.*` · `global.*`

### Built-in functions

`max` · `min` · `floor` · `size` · `sum` · `contains` · `map` · `concat` · `join` · `shard` · `coalesce` · `isnull` · `format_date` · `is_prev_day` · `hash` · `LOOKUP_FIELD`

---

## Getting started

### Install

Search **Causet DSL** in the VS Code / Cursor extension marketplace, or install the VSIX directly:

```bash
code --install-extension causet-language-support-0.2.0.vsix
```

### Activate the theme

Open the Command Palette (`⌘⇧P`) → **Preferences: Color Theme** → select **Causet Dark** or **Causet Light**.

### Activate file icons

Command Palette → **Preferences: File Icon Theme** → select **Causet File Icons**.

### Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| Causet: Validate Workspace | `⌘⇧V` | Run diagnostics on all `.causet` files |
| Causet: Restart Language Server | — | Restart the LSP process |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `causet.diagnostics.enabled` | `true` | Enable/disable real-time diagnostics |
| `causet.diagnostics.delay` | `500` | Debounce delay (ms) after typing before diagnostics run |
| `causet.completion.workspaceSymbols` | `true` | Include workspace event/action/projection names in completions |
| `causet.server.trace` | `"off"` | LSP trace level (`"off"` / `"messages"` / `"verbose"`) |

---

## Architecture

The extension uses the **Language Server Protocol** with a dedicated out-of-process Node.js language server:

```
VS Code / Cursor
    └── causet-language-support (extension)
            ├── TextMate grammar    (syntaxes/causet.tmLanguage.json)
            ├── Snippets            (snippets/causet.code-snippets)
            ├── Themes              (themes/causet-dark.json, causet-light.json)
            └── LSP client          (src/extension.ts)
                    └── causet-language-server (Node.js child process)
                            ├── Parser           (yaml → AST)
                            ├── WorkspaceIndex   (cross-file symbol table)
                            └── Providers
                                    ├── diagnostics.ts
                                    ├── hover.ts
                                    ├── completion.ts
                                    ├── definition.ts
                                    ├── references.ts
                                    ├── rename.ts
                                    ├── symbols.ts
                                    ├── codelens.ts
                                    ├── folding.ts
                                    ├── semantic-tokens.ts
                                    ├── workspace-symbols.ts
                                    └── formatting.ts
```

---

## Building from source

```bash
cd packages
npm install
npm run build      # shared → language-server → extension
npm test           # unit tests (parser, diagnostics, workspace index)
npm run package    # produces causet-language-support.vsix
```

Requires Node.js 18+.

---
Bug reports and feature requests: [GitHub Issues](https://github.com/causet/causet/issues)

---

## License

[Apache License 2.0](../../LICENSE)
