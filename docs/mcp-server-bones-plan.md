# MCP Server Bones TDD Plan

## Status

Approved infrastructure slice. The executable lives in `apps/mcp-server`; product capabilities,
editor transactions, and protocol-domain schemas remain deferred to the later MCP workstream.

This is intentionally a buildable, runnable, and testable server shell. It does not decide the
names, inputs, outputs, or semantics of editor tools.

## Boundary and ownership

The monorepo has two relevant boundaries:

- `packages/protocol` owns public, versioned Zod schemas, inferred wire types, errors, and JSON
  Schema generation.
- `apps/mcp-server` owns the MCP SDK dependency, stdio transport, process lifecycle, entry point,
  and capability registration composition.

The app does not import editor behavior or ProseMirror transactions. Future registrars may adapt
MCP requests to inward-facing application use cases, but the bones do not create those contracts.
No collaboration behavior is required in this phase.

The dependency direction is deliberately short:

```text
cli.ts -> main.ts -> process lifecycle -> McpServer -> official MCP TypeScript SDK v1
                                      \-> internal capability registrar seam
```

## Scope

The first slice provides:

1. a standalone ESM workspace app;
2. a side-effect-free `McpServer` factory;
3. a narrow internal capability-registration seam;
4. a stdio process runner with bounded, idempotent shutdown; and
5. contract, lifecycle, process, and compiled-child integration tests.

The production server advertises no product tools, resources, or prompts. Capability listing is
therefore absent or unavailable rather than a promise that every list is an empty array.

Deferred: editor operations, document/block/mark schemas, ProseMirror/Tiptap integration,
diffing, persistence, collaboration, HTTP, auth, deployment, observability, SDK v2, and a public
third-party plugin API.

## Package layout

```text
apps/mcp-server/
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts              # unconditional executable edge
│   ├── main.ts             # importable composition root
│   ├── server.ts           # SDK server factory and registrar seam
│   ├── lifecycle.ts        # idle/starting/running/closing/closed state machine
│   └── process.ts          # signals, stdin EOF, deadlines, and exit semantics
├── test/
│   ├── mcp/
│   │   ├── server.contract.test.ts
│   │   ├── lifecycle.test.ts
│   │   ├── process.test.ts
│   │   ├── main.test.ts
│   │   └── stdio.integration.test.ts
│   └── support/
│       ├── register-probe-tool.ts
│       └── observed-stdio-transport.ts
```

`packages/protocol` remains unchanged by this infrastructure slice and has no MCP SDK or process
dependency.

## Construction API

The internal seam stays intentionally small:

```ts
type CapabilityRegistrar = (server: McpServer) => void;

interface CreateMcpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly register?: CapabilityRegistrar;
}

function createMcpServer(options: CreateMcpServerOptions): McpServer;
```

Construction performs no I/O and does not connect a transport. Registration completes before
connection. The registrar is an internal composition seam, proven only with a test fixture; it is
not a public plugin API. Package metadata is supplied at the process edge from the app manifest.

## Lifecycle contract

Lifecycle is an explicit state machine:

```text
idle --start--> starting --connect succeeds--> running --close--> closing --> closed
                  |                              |
                  +--connect fails--------------+--close during start--> closing
```

Rules:

- `start()` is valid only from `idle`, is idempotent while `starting`/`running`, and is rejected
  after `closing` or `closed`.
- `close()` is idempotent from every state, including `idle`; it transitions to `closed` without
  connecting.
- Closing during an in-flight start waits for the connection attempt, then closes exactly once.
- A failed start cannot be followed by a later successful start.
- Tests assert state transitions and event ordering, not merely that promises settle.

## Process contract

`main.ts` is importable and has no process-start side effect. `cli.ts` is a tiny unconditional
launcher that invokes `main()`; it does not compare `import.meta.url` with `argv[1]`. The package
binary points to `./dist/cli.js`, so direct execution and package-manager bin symlinks behave the
same way.

The process runner:

- starts the lifecycle once;
- routes `SIGINT` and `SIGTERM` through one cached shutdown promise;
- routes stdin `end` and `close` through that same shutdown path;
- removes listeners after shutdown;
- sets exit code 1 and reports sanitized errors for startup, stop, or grace-timeout failures;
- gives shutdown a bounded grace period, then force-exits with code 1; and
- treats a second termination signal as an explicit force exit (`130` for `SIGINT`, `143` for
  `SIGTERM`).

The normal client-disconnect path is stdin EOF/close, not a signal. This keeps the process from
remaining alive when the SDK transport does not itself translate EOF into server closure.

## TDD sequence and acceptance

### 1. Scaffold and compile gate

Add the app manifest, strict NodeNext TypeScript project, source/test folders, and recursive root
scripts. `bin` must resolve to `dist/cli.js`; emitted imports must be valid ESM. No editor-domain
package is needed.

### 2. Server contract

Use the official SDK `Client` and `InMemoryTransport.createLinkedPair()` to verify initialization,
exact metadata, clean close, and factory side-effect freedom. A test-only probe registrar proves
registration works; it is never shipped as a production capability. Invalid tool input is asserted
as the SDK's MCP error result (`isError: true`) and the handler is not called.

### 3. Lifecycle and process behavior

Write focused tests for close-before-start, close-during-start, repeated start/close, failed start,
stdin EOF, signal escalation, startup failure, and grace-timeout handling. Use fake process
controls so no test exits the Vitest process.

### 4. Compiled process integration

Build the app, launch the compiled `cli.js` through a temporary bin symlink, and complete an
official MCP client handshake over stdio. Close the client and assert the child actually exits with
`code: 0` and `signal: null`, with no stderr errors. A cleared SDK pid alone is insufficient proof
of graceful shutdown.

### 5. Repository gate

Run formatting, ESLint, strict typechecking, build, unit/contract tests, coverage thresholds, the
compiled integration test, and `git diff --check`. Keep the SDK at stable v1 (`1.29.0`) and do not
add another runtime library for these lifecycle fixes.

## Commands

```sh
pnpm --filter @editor-mcp/mcp-server build
pnpm --filter @editor-mcp/mcp-server typecheck
pnpm --filter @editor-mcp/mcp-server test
pnpm --filter @editor-mcp/mcp-server test:integration
pnpm --filter @editor-mcp/mcp-server start
```

Manual inspection uses the compiled app entry point:

```sh
npx @modelcontextprotocol/inspector node apps/mcp-server/dist/cli.js
```

## Related documents

- [`docs/architecture.md`](architecture.md) — normative package ownership and boundaries
- [`docs/implementation-plan.md`](implementation-plan.md) — active delivery workstreams
- [`docs/scratch/plan.md`](scratch/plan.md) — historical, non-normative product context
- [`docs/mcp-deep-dive.md`](mcp-deep-dive.md) — MCP protocol research
