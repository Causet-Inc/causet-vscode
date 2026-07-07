# causet-vscode

Language support for the [Causet](https://www.causet.io) DSL in VS Code and Cursor — syntax highlighting, diagnostics, completions, go-to-definition, rename, CodeLens, and more.

This repository is an npm workspace monorepo. The published artifact is the VS Code extension under `extension/`.

## Quick start

```bash
npm install
npm run build      # shared → language-server → extension
npm test           # parser, diagnostics, workspace index
npm run package    # extension/causet-language-support.vsix
```

Requires Node.js 18+ (CI uses Node 20).

### Install locally

```bash
code --install-extension extension/causet-language-support.vsix
```

Or run from VS Code: open `extension/`, press F5 to launch an Extension Development Host.

## Repository layout

| Package | Purpose |
|---------|---------|
| `extension/` | VS Code / Cursor extension (grammar, themes, snippets, LSP client) |
| `language-server/` | Node.js LSP server (bundled into `extension/dist/server`) |
| `shared/` | Parser, AST, and workspace symbol index |
| `tests/` | Unit tests |

Build order matters: `shared` → `language-server` → `extension`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build all packages |
| `npm run watch` | Watch mode across packages |
| `npm test` | Run unit tests |
| `npm run test:coverage` | Tests with coverage report |
| `npm run package` | Build and produce a `.vsix` |
| `npm run clean` | Remove build artifacts |

## Architecture

```
VS Code / Cursor
    └── extension/          (LSP client, TextMate grammar, themes)
            └── language-server/   (child process)
                    └── shared/      (parser + workspace index)
```

See [extension/README.md](extension/README.md) for the full feature list, settings, and DSL coverage.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on pushes and PRs to `main` and `develop`:

- Build all packages
- Unit tests with coverage
- Grammar, snippet, and theme JSON validation
- TypeScript type-check (`shared`, `language-server`)
- VSIX packaging on `main` (artifact upload)

## Related repos

- [causet/causet](https://github.com/causet/causet) — Causet platform (runtime, compiler, examples)

## Contributing

Bug reports and feature requests: [GitHub Issues](https://github.com/causet/causet-vscode/issues)

## License

[Apache License 2.0](LICENSE)
