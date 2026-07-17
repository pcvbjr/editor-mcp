# MCP Server Bones TDD Plan

## Status

Proposed execution subplan for the first MCP server infrastructure slice.

This plan intentionally stops at a buildable, runnable, and testable MCP server shell. It does not define the editor product surface. Tool names, document schemas, editor operations, and persistence behavior belong to later plans.

## 1. Decisions carried forward

This subplan inherits only the infrastructure decisions already made elsewhere:

- TypeScript on the repository's supported Node.js runtime.
- The official Model Context Protocol TypeScript SDK, using its stable v1 API. The currently installed version is `@modelcontextprotocol/sdk` 1.29.0.
- `McpServer` as the high-level server API.
- stdio as the first transport.
- ESM and the repository's existing TypeScript, Vitest, ESLint, and Prettier setup.
- A thin MCP adapter that will eventually delegate product work to inward-facing application code.

This plan does **not** carry forward or introduce any decision about the eventual number, names, inputs, outputs, or semantics of tools, resources, or prompts.

## 2. Objective

Create an `apps/mcp-server` workspace package that:

1. builds as a standalone ESM package;
2. creates an MCP server without starting it as a side effect;
3. completes the MCP initialization handshake through the official SDK;
4. can accept future capability registration through one small composition seam;
5. runs over stdio without contaminating protocol output;
6. shuts down cleanly; and
7. is covered by contract and process-level tests written before the corresponding implementation.

At the end of this phase, the production server may legitimately expose no tools, resources, or prompts. The result is the executable infrastructure into which those product capabilities can later be composed.

## 3. Definition of “server bones”

The bones consist of five things:

- a workspace package and build configuration;
- a side-effect-free MCP server factory;
- a capability-registration seam;
- a stdio lifecycle runner and process entry point; and
- a test harness that exercises both an in-memory server and the built stdio process.

The registration seam will be proven with a test-only capability. No demonstration, health, echo, or placeholder tool will be shipped in the production server.

## 4. Explicit non-goals

The following work is deferred:

- editor tool, resource, or prompt design;
- document, block, mark, selection, or edit schemas;
- Zod schemas for product data;
- protocol and application-core packages created only to make the skeleton look layered;
- Tiptap, ProseMirror, Yjs, or Hocuspocus integration;
- persistence, revisioning, diffing, tracked changes, or collaboration;
- Streamable HTTP, authentication, authorization, tenancy, or deployment;
- production logging, tracing, metrics, or an observability framework;
- MCP extensions outside the stable v1 SDK surface;
- compatibility work for the pre-release v2 TypeScript SDK; and
- a public package API for third-party editor integrations.

Keeping these items out prevents the infrastructure slice from quietly deciding the product contract.

## 5. Architectural boundary

`apps/mcp-server` is a process adapter and composition root. In this phase it owns:

- MCP server metadata;
- transport construction;
- connection and shutdown lifecycle;
- process-signal and fatal-startup handling; and
- invocation of capability registrars supplied at composition time.

It does not own editor behavior or business rules.

The dependency direction for this phase is deliberately short:

```text
process entry point
        |
        v
stdio lifecycle runner
        |
        v
MCP server factory ----> capability registrar(s)
        |
        v
official MCP TypeScript SDK v1
```

Later, a registrar may adapt MCP requests to application use cases. That later dependency is not needed to construct or test the bones.

## 6. Proposed package shape

Keep the initial package small:

```text
apps/mcp-server/
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts
│   ├── server.ts
│   └── stdio.ts
└── test/
    ├── server.contract.test.ts
    ├── stdio.integration.test.ts
    └── support/
        └── register-probe-tool.ts
```

Responsibilities:

- `server.ts`: constructs and returns an unconnected `McpServer`.
- `stdio.ts`: connects a supplied server to `StdioServerTransport` and coordinates closing it.
- `main.ts`: the minimal executable edge—loads package metadata, starts stdio, handles fatal startup errors and termination signals.
- `server.contract.test.ts`: uses the official client and in-memory linked transports.
- `stdio.integration.test.ts`: spawns the compiled entry point through the official stdio client transport.
- `register-probe-tool.ts`: a test fixture proving that future registration can be composed. It is never imported by production code.

Do not add abstractions such as a logger interface, transport factory hierarchy, dependency-injection container, or generic plugin framework until a second real use case makes one necessary.

## 7. Internal construction API

The exact syntax can evolve during red-green-refactor, but the intended seam is:

```ts
type CapabilityRegistrar = (server: McpServer) => void;

interface CreateMcpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly register?: CapabilityRegistrar;
}

function createMcpServer(options: CreateMcpServerOptions): McpServer;
```

Required properties of this API:

- Construction has no I/O and does not connect a transport.
- Registration finishes synchronously before transport connection.
- Tests can inject deterministic metadata instead of depending on the root package manifest.
- Production metadata has one source of truth, preferably the server package manifest at the process edge.
- The returned server is the SDK's `McpServer`; a wrapper is not justified yet.
- The registrar is an internal composition mechanism, not a promised third-party plugin API.

The lifecycle API should likewise stay narrow. It may accept a server and transport so tests can control both, but it should not expose process globals throughout the package. Only `main.ts` should read signals, write fatal errors, or set `process.exitCode`.

## 8. TDD execution sequence

Each milestone should be completed red-green-refactor before starting the next. A milestone is complete only when its focused test passes and the repository's complete quality check still passes.

### Milestone 0 — Package scaffold and compile gate

Create the package manifest, TypeScript project, source/test folders, and root workspace references.

Planned package scripts:

- `build`: compile the package to its distribution directory;
- `typecheck`: check without emitting;
- `test`: run fast contract tests;
- `test:integration`: build and run the stdio process test;
- `start`: run the compiled entry point; and
- `dev`: run the TypeScript entry point for local development.

The root scripts and Makefile should delegate to package scripts rather than duplicate commands.

Compile-gate acceptance:

- the package participates in the root build and typecheck;
- emitted imports are valid Node ESM imports;
- package exports and the executable entry resolve to built files; and
- an empty source skeleton does not require editor-domain packages.

This is configuration work, so the initial red signal is the root build/typecheck failing because the package or entry point does not yet exist.

### Milestone 1 — Side-effect-free server factory

**Red**

Write an in-memory contract test that:

1. constructs a server with deterministic name and version;
2. creates an official MCP `Client`;
3. connects client and server with `InMemoryTransport.createLinkedPair()`;
4. completes initialization; and
5. asserts the negotiated server metadata.

Add a separate assertion that merely calling the factory does not connect or perform I/O.

**Green**

Implement the smallest `createMcpServer` using `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`.

**Refactor**

- centralize construction metadata without hiding it behind unrelated configuration machinery;
- keep SDK-specific construction in `server.ts`; and
- ensure every created client, server, and transport closes in test cleanup.

Milestone acceptance:

- initialization succeeds through official client APIs;
- name and version are exact;
- factory construction is side-effect free; and
- connection and close do not leave open handles.

### Milestone 2 — Capability-registration seam

This milestone tests composition without making a product decision.

**Red**

Create a test-only registrar that calls the current `registerTool` API to add a probe tool with a tiny strict Zod input and structured output. Through the official client, assert that:

- the probe appears after initialization;
- a valid call returns the expected structured result;
- invalid arguments are rejected before the handler runs; and
- the registrar runs exactly once for a server instance.

**Green**

Add the optional registrar invocation to the server factory before connection.

**Refactor**

- keep the probe under `test/support`;
- do not export the probe from the package;
- do not use the SDK's deprecated `.tool()` convenience API; and
- avoid inventing a registry abstraction around the one callback.

Milestone acceptance:

- the production server still declares no product capabilities;
- future capabilities have a tested composition point; and
- SDK input validation behavior is exercised without duplicating validation in the factory.

### Milestone 3 — Stdio lifecycle runner

**Red**

Test the lifecycle logic with injected server and transport doubles or narrowly typed fakes. Cover:

- connection happens once;
- close happens once even if shutdown is requested repeatedly;
- a connection failure is returned to the process edge;
- shutdown after partial startup is safe; and
- library code never calls `process.exit()`.

**Green**

Implement the smallest stdio runner around `StdioServerTransport` and `McpServer.connect()`/`close()`.

**Refactor**

- use a single idempotent close path;
- keep signal registration out of reusable lifecycle logic where practical; and
- keep all non-protocol diagnostics away from stdout.

Milestone acceptance:

- lifecycle behavior is deterministic and testable without spawning a child process;
- repeated shutdown does not throw or double-close; and
- failures reach `main.ts` rather than being swallowed.

### Milestone 4 — Executable process edge

**Red**

Add focused tests for `main.ts` behavior through injected lifecycle functions or a small exported `main` function:

- startup failure writes a concise diagnostic to stderr;
- startup failure sets a nonzero `process.exitCode`;
- normal startup does not write human-readable text to stdout; and
- SIGINT and SIGTERM both request the same idempotent shutdown path.

**Green**

Implement the executable edge. It should create the server, construct the stdio transport, connect them, and install shutdown handlers.

**Refactor**

- keep top-level execution separate from importable functions so tests do not start a server by importing a module;
- use stderr only for process diagnostics; and
- avoid calling `process.exit()` while cleanup is pending.

Milestone acceptance:

- importing server modules has no process side effects;
- startup failures produce a nonzero exit status; and
- signals converge on one shutdown implementation.

### Milestone 5 — Built-process stdio integration

**Red**

Build the package, then use the official `StdioClientTransport` and `Client` to launch the compiled server entry. Assert that:

- the initialization handshake completes;
- server name and version are returned;
- the connection can be closed by the client;
- the child process exits within a bounded timeout; and
- no malformed stdout causes the SDK client to fail parsing.

The test must fail with a useful timeout and always terminate its child process during cleanup.

**Green**

Make only the entry-point, package-export, or lifecycle changes required for the compiled process to pass.

**Refactor**

- share deterministic timeout and cleanup helpers within the test suite only;
- keep platform-specific signal assertions out of the process smoke test if they are already covered at the lifecycle boundary; and
- retain at least one real compiled-process handshake as the final integration proof.

Milestone acceptance:

- the built artifact, not a TypeScript development runner, works over stdio;
- the official SDK is used on both ends of the integration test; and
- the process exits cleanly without leaked child processes or open handles.

### Milestone 6 — Developer verification and handoff

Document the commands to:

- build the server;
- run its focused tests;
- run the full repository check; and
- connect MCP Inspector to the compiled stdio command.

Inspector verification in this phase proves initialization, metadata, and a stable connection. It is acceptable for the production capability lists to be empty.

## 9. Test matrix

| Layer | What it proves | Required cases |
| --- | --- | --- |
| Compile gate | Workspace and ESM wiring | package references, exports, executable path |
| Factory contract | SDK construction and handshake | metadata, no construction side effects, cleanup |
| Registration contract | Future composition seam | list, valid call, invalid input, registrar called once |
| Lifecycle unit | Transport ownership | connect once, idempotent close, partial failure |
| Process-edge unit | Node process behavior | stderr, exit code, signal routing, no stdout logging |
| Stdio integration | Real built executable | initialize, metadata, close, bounded exit |
| Manual Inspector smoke | Developer usability | launch command, initialize, stable session |

Tests should assert public behavior through official SDK clients where possible. They should not snapshot SDK internals or manually reproduce JSON-RPC messages unless an SDK-level assertion is impossible.

## 10. Stdio and process rules

The stdio transport makes stdout part of the wire protocol. Therefore:

- production code must not use `console.log`;
- startup, shutdown, and fatal diagnostics go to stderr;
- library modules return or throw errors instead of terminating the process;
- only the executable edge may set `process.exitCode`;
- shutdown is idempotent;
- test cleanup closes clients, servers, transports, and child processes; and
- integration tests use bounded timeouts so a broken lifecycle cannot hang the suite.

These are correctness requirements, not optional logging preferences.

## 11. Quality gates

Every milestone must preserve:

- formatting;
- linting;
- TypeScript typechecking;
- unit and contract tests;
- the compiled-process integration test once introduced; and
- a clean production dependency boundary with no editor implementation pulled into the server package.

The final repository-level verification is `make check`. The process integration test should be included in the normal check if it remains fast and deterministic; otherwise it must still be a required CI job, not an optional manual test.

## 12. Final acceptance criteria

The bones phase is complete when all of the following are true:

- `apps/mcp-server` builds under the repository's Node and TypeScript settings.
- The factory creates an unconnected `McpServer` with injected metadata.
- An official in-memory client completes initialization and observes that metadata.
- A test-only registrar proves future capabilities can be registered and SDK validation works.
- No test-only or placeholder capability is reachable from the production entry point.
- The compiled production entry completes a stdio handshake through the official client transport.
- Production stdout contains MCP protocol traffic only.
- Startup failure and signal shutdown follow the documented exit and cleanup behavior.
- Tests leave no open handles or child processes.
- The full repository quality check passes.
- MCP Inspector can initialize a session with the compiled command.

## 13. Ordered implementation checklist

1. Add the workspace package, TypeScript reference, scripts, and empty entry modules.
2. Write the failing in-memory handshake test; implement the server factory.
3. Write the failing test-only registration contract; add the registrar seam.
4. Write lifecycle failure and idempotency tests; implement the stdio runner.
5. Write process-edge tests; implement the executable entry and signal handling.
6. Write the failing compiled-process test; complete package exports and stdio wiring.
7. Add focused developer commands and Inspector instructions.
8. Run the complete quality gate and review the package for accidental product decisions.

Each item is small enough to be reviewed independently. The implementation should stop after item 8; designing editor capabilities is the next plan, not an opportunistic addition to this one.

## 14. Risks and guardrails

| Risk | Guardrail |
| --- | --- |
| Mixing SDK v1 and pre-release v2 examples | Import only APIs present in the installed v1 package and covered by compile tests. |
| Polluting the product surface with a demo tool | Keep the probe registrar under tests and assert the production entry does not import it. |
| Hiding behavior behind premature abstractions | Start with one factory, one registrar callback, and one lifecycle runner. |
| Breaking stdio with ordinary logs | Test through the official stdio client and reserve stdout for protocol traffic. |
| Tests that pass while the built package is broken | Keep one integration test against compiled JavaScript. |
| Hanging test processes | Use idempotent cleanup, bounded timeouts, and child termination in `finally`/test cleanup. |
| Letting infrastructure decide product contracts | Do not add document schemas, tool names, or editor handlers in this phase. |

## 15. Deferred next plan

After these bones are accepted, a separate TDD plan can define the first real MCP capability slice. That plan may introduce protocol schemas, application use cases, and editor adapters based on explicit product decisions. Nothing in this bones phase requires those decisions to be made early.

## References

- [Repository architecture](./architecture.md)
- [MCP deep dive](./mcp-deep-dive.md)
- [Official MCP TypeScript SDK v1 documentation](https://ts.sdk.modelcontextprotocol.io/)
- [Official MCP TypeScript SDK repository](https://github.com/modelcontextprotocol/typescript-sdk)
