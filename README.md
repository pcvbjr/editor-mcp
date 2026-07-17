# editor-mcp

Editor MCP is a production-oriented, collaboration-first document mutation service for AI agents and Tiptap/ProseMirror applications.

## Design documents

- [System architecture](docs/architecture.md) — normative architecture and delivery direction
- [Implementation plan](docs/implementation-plan.md) — active TDD delivery sequence and exit criteria
- [MVP schema](docs/mvp-schema.md) — normative nodes, marks, attributes, and semantic operations
- [In-document diffing](docs/diffing-plan.md) — tracked-change semantics and implementation plan
- [MCP deep dive](docs/mcp-deep-dive.md) — protocol research and reference
- [MCP server bones](docs/mcp-server-bones-plan.md) — TDD plan and acceptance criteria for the
  stdio server shell
- [Streamable HTTP transport](docs/streamable-http-plan.md) — standards-based transport architecture,
  dependency decisions, security boundary, and TDD execution plan
- [Remote production-alpha runbook](docs/remote-mcp-production-alpha.md) — WorkOS, Railway,
  deployment verification, and operating procedures
- [Remote authorization ADR](docs/adr/0001-remote-mcp-production-auth.md) — accepted WorkOS,
  Express, stateless transport, and identity-boundary decisions
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

## MCP server shell

The local stdio server is built from the `apps/mcp-server` app. It intentionally advertises no
product tools, resources, or prompts yet.

```sh
pnpm --filter @editor-mcp/mcp-server build
pnpm --filter @editor-mcp/mcp-server test
pnpm --filter @editor-mcp/mcp-server test:integration
pnpm --filter @editor-mcp/mcp-server test:package
pnpm --filter @editor-mcp/mcp-server start

# authenticated Streamable HTTP transport (after configuring WorkOS staging variables)
make mcp-http
```

To inspect the compiled server manually:

```sh
make mcp-inspect
```

Inspector should complete initialization and report the MCP app name and version. Product
capabilities are not registered until the first product-capability slice is integrated.

The Streamable HTTP process is authenticated in every environment; there is no environment switch that
disables OAuth. For local development, use a WorkOS staging environment and set a loopback resource such
as `http://127.0.0.1:3000/mcp`, the staging issuer and introspection credential, and explicit loopback
allowed hosts. See the production-alpha runbook for the complete variable contract. The stdio binary
remains the simplest local integration when remote OAuth is not under test.

### Claude Desktop on macOS

Build the server, then open Claude Desktop's **Settings → Developer → Edit Config** (or edit
`~/Library/Application Support/Claude/claude_desktop_config.json` directly) and merge this server
entry into the configuration:

```json
{
  "mcpServers": {
    "editor-mcp": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/editor-mcp/apps/mcp-server/dist/cli.js"]
    }
  }
}
```

Use `command -v node` to find the Node.js path, replace both placeholders with absolute paths, and
restart Claude Desktop. The server must reserve stdout for MCP messages; process diagnostics go to
stderr.
