# editor-mcp

Infrastructure and design work for a reusable MCP interface over Tiptap documents.

## Development setup

Use Node.js 24 when developing locally. The supported runtime floor is Node.js 22.13.
The package manager is pinned through the `packageManager` field in `package.json`.

```sh
make setup
make check
```

`make help` lists the available build, lint, formatting, type-checking, testing, and
coverage commands. The Makefile delegates to the corresponding pnpm scripts so there is
only one source of command behavior.

## Tooling choices

- pnpm workspaces for dependency management and the planned monorepo layout
- TypeScript in strict ESM/NodeNext mode, targeting the Node.js 22 type surface
- Zod 4 for runtime validation, inferred TypeScript types, and JSON Schema generation
- Vitest with V8 coverage, jsdom for future DOM-specific tests, and fast-check for future
  property-based tests
- typed ESLint plus Prettier for code quality and formatting
- tsx for running TypeScript during development without adding a production bundler
- stable MCP TypeScript SDK v1
- Tiptap 3 core, ProseMirror bridge, server-side HTML conversion, stable IDs, and the
  initial document-schema extensions

Bundling, browser end-to-end tests, release automation, and collaboration dependencies are
deferred until the corresponding implementation phases.
