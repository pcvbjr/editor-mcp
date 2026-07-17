# editor-mcp

Editor MCP is a production-oriented, collaboration-first document mutation service for AI agents and Tiptap/ProseMirror applications.

## Design documents

- [System architecture](docs/architecture.md) — normative architecture and delivery direction
- [Implementation plan](docs/implementation-plan.md) — active TDD delivery sequence and exit criteria
- [MVP schema](docs/mvp-schema.md) — normative nodes, marks, attributes, and semantic operations
- [In-document diffing](docs/diffing-plan.md) — tracked-change semantics and implementation plan
- [MCP deep dive](docs/mcp-deep-dive.md) — protocol research and reference
- [Original design narrative](docs/scratch/plan.md) — historical, non-normative context

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
