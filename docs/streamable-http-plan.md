# Streamable HTTP MCP Transport TDD Plan

## Status

Implemented infrastructure slice. This plan adds a standards-based Streamable HTTP transport to the
existing MCP server app without selecting product tools, editor operations, deployment infrastructure,
or an identity provider.

The transport is designed for any conforming MCP client: general-purpose AI agents, custom agent
runtimes, IDEs, desktop applications, and hosted model providers. Codex, Claude, MCP Inspector, and
the official TypeScript SDK client are interoperability examples, not architectural dependencies.

This plan does not make the server safe for unauthenticated public deployment. The first implementation
is a local, loopback-bound transport shell. Public HTTPS deployment remains gated on authentication,
authorization, operational policy, and the production document runtime described in the main
implementation plan.

## Outcome

After this slice, the monorepo will contain two independently runnable transports backed by the same
side-effect-free MCP server factory:

```text
                        capability registrars
                                 |
                                 v
                    createMcpServer(options)
                         /               \
                        v                 v
               stdio lifecycle     Streamable HTTP app
               editor-mcp          editor-mcp-http
                                          |
                                          v
                                 POST/GET/DELETE /mcp
```

The HTTP transport will:

- implement the MCP Streamable HTTP protocol through the official TypeScript SDK;
- accept any conforming MCP client rather than detecting or specializing for particular agents;
- remain stateless initially, with a fresh SDK server and transport per MCP request;
- bind to `127.0.0.1` by default and validate host and optional origin headers;
- expose a small liveness endpoint separately from the MCP endpoint;
- start and stop cleanly under tests, signals, and normal process lifecycle;
- preserve the current stdio executable and its behavior; and
- advertise no product tools, resources, or prompts until later capability work supplies them.

## Standards and documentation baseline

Implementation must follow the documentation for versions actually resolved by this repository.

### MCP protocol

The normative transport contract is the MCP
[Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
It defines one MCP endpoint supporting HTTP `POST` and `GET`, with optional `DELETE` for an established
session. A POST response may be a single JSON object or an SSE stream. The older HTTP+SSE transport is
superseded and will not be implemented unless a real client requirement appears.

The specification's security requirements are part of the transport contract, not optional deployment
polish. Servers must validate `Origin` when it is present, local servers should bind only to loopback,
and remote servers need proper authentication.

Remote authorization will follow the current MCP
[authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
which is based on OAuth 2.1 and protected-resource metadata. That work is deliberately separate because
it requires an identity and deployment decision, not merely HTTP routing.

### MCP TypeScript SDK

Keep `@modelcontextprotocol/sdk` at the repository's exact stable v1 version, `1.29.0`. The SDK's v2
branch is pre-stable; this slice must use APIs shipped by the installed version rather than copying
examples from an incompatible branch.

The relevant v1 API is `WebStandardStreamableHTTPServerTransport`. Its web-standard
`Request`/`Response` boundary fits a typed web framework and keeps Node-specific listener behavior out
of the MCP request handler. In stateless mode, the SDK requires a fresh transport for each request;
reusing one transport can collide message identifiers across independent clients.

References:

- [MCP TypeScript SDK repository](https://github.com/modelcontextprotocol/typescript-sdk)
- [SDK v1 server guide](https://ts.sdk.modelcontextprotocol.io/server)
- The SDK `v1.x` branch's `honoWebStandardStreamableHttp` example at the commit corresponding to
  version `1.29.0`, which is the version-matched implementation reference during coding. Do not use
  examples from the repository's v2 `main` branch.

### HTTP framework

Use [Hono](https://hono.dev/docs/getting-started/nodejs) with
[`@hono/node-server`](https://github.com/honojs/node-server). Hono provides a typed Web Standard
Request/Response API that matches the SDK transport. Its
[`app.request()` testing API](https://hono.dev/docs/guides/testing) supports in-memory routing and
security tests without another test framework or an open port.

The SDK already resolves Hono `4.12.30` and `@hono/node-server` `1.19.14` transitively. The MCP app must
declare both exact versions directly because it will import them directly. This corrects dependency
ownership without introducing a second framework or a new resolved package version.

Alternatives were rejected for this slice:

| Option | Decision | Reason |
| --- | --- | --- |
| Hono + Node adapter | Use | Matches the SDK's web-standard transport, has strong TypeScript support, and provides in-memory request testing. |
| Express | Do not add | The SDK supports it, but direct use would add Express ownership and TypeScript declarations while providing no advantage for this small endpoint. |
| Raw `node:http` routing | Do not use | It saves declarations but makes the application own body parsing, routing, response conversion, and more security edge cases. |
| Legacy HTTP+SSE | Do not implement | Superseded by Streamable HTTP; carrying both creates compatibility and lifecycle work without a present client need. |

### Existing infrastructure

Use the packages already present for their established responsibilities:

- Zod 4 validates environment configuration once at the process boundary and infers its TypeScript
  type. Do not duplicate a handwritten config interface.
- Vitest tests config, routing, transport contracts, lifecycle, and compiled-process behavior.
- The official SDK `Client` and `StreamableHTTPClientTransport` perform real MCP handshakes in
  integration tests.
- Node's built-in `fetch`, URL, HTTP server, signals, and connection-closing APIs are sufficient.
- Existing ESLint, Prettier, strict TypeScript, and coverage gates apply unchanged.

Do not add Express, Fastify, Supertest, CORS middleware, `dotenv`, a UUID package, an authentication
framework, or another schema library. If stateful sessions are later justified, Node's
`crypto.randomUUID()` is sufficient for session identifiers.

## Architecture and ownership

The existing monorepo boundaries remain authoritative:

- `packages/protocol` owns public editor-facing runtime schemas and inferred wire types.
- `apps/mcp-server` owns MCP transports, process lifecycle, capability registration, and transport
  configuration.
- Product capability registrars will call inward-facing application use cases when those contracts
  exist. Neither transport owns editor semantics.

HTTP-specific configuration and lifecycle types are internal to `apps/mcp-server`; they are not public
protocol DTOs. MCP SDK and Hono types must not leak into the domain or protocol packages.

The implementation should be additive so concurrent product work can keep using `src/server.ts` and
the registrar seam without touching HTTP internals:

```text
apps/mcp-server/
├── package.json
├── src/
│   ├── server.ts                  # existing shared MCP server factory
│   ├── cli.ts                     # existing stdio executable
│   ├── main.ts                    # existing stdio composition root
│   └── http/
│       ├── app.ts                 # Hono app factory and /mcp composition
│       ├── config.ts              # Zod environment schema and inferred config
│       ├── security.ts            # exact Host/Origin validation
│       ├── runtime.ts             # Node listener and bounded lifecycle
│       ├── main.ts                # importable HTTP composition root
│       └── cli.ts                 # unconditional HTTP executable
└── test/
    ├── mcp/                       # existing stdio tests, unchanged
    └── http/
        ├── config.test.ts
        ├── security.test.ts
        ├── app.contract.test.ts
        ├── runtime.test.ts
        └── streamable-http.integration.test.ts
```

Keep modules responsibility-focused. `app.ts` creates request behavior but does not listen on a port;
`runtime.ts` owns listener state but does not construct MCP capabilities; `main.ts` composes those
pieces; and `cli.ts` only invokes `main()` and reports sanitized startup failures.

## Transport mode decision

### Begin stateless

Omit `sessionIdGenerator` when constructing `WebStandardStreamableHTTPServerTransport`. For each MCP
POST request, construct a fresh `McpServer`, construct a fresh transport with
`enableJsonResponse: true`, connect them, await the complete JSON response, and close both in a
`finally` path. JSON response mode is part of Streamable HTTP and gives the initial request-scoped
implementation an unambiguous cleanup boundary.

Validate exact media types before constructing the MCP server because the SDK transport's substring
checks are intentionally permissive. Hono's `accepts()` helper chooses one preferred representation,
so it does not model MCP's requirement that a POST advertise both JSON and SSE; keep the small
MCP-specific validator at this boundary. Keep JSON-RPC batches only for the `2025-03-26` compatibility
protocol; reject empty batches, initialization batches, and batches using later protocol revisions
before dispatch.

Do not combine immediate `finally` cleanup with an SSE response body. The SDK may return that streaming
response before tool execution and body delivery have finished. If POST streaming is later required for
progress or other request-scoped events, keep the server and transport alive until the response stream
finishes or is cancelled, and test that lifecycle explicitly.

Stateless mode is the correct initial default because:

- the current shell has no server-initiated notifications or other session-bound capabilities;
- document state will belong to the document runtime, not an HTTP connection or MCP session;
- independent requests can be load-balanced later without sticky sessions;
- there is no in-memory session map to leak, expire, or lose at process restart; and
- the implementation remains useful to generic agents without inventing a proprietary session model.

Stateless MCP transport does not mean stateless documents. A `read_document` request will carry explicit
tenant and document identity, resolve the current document through the long-lived document runtime, and
return agent-readable content with its version. A later mutation request will carry that identity,
version or target preconditions, and an idempotency key. The agent host retains tool results in its own
conversation state; Hocuspocus/Yjs remains the authoritative live document state.

In this mode, the application returns `405 Method Not Allowed` for standalone GET and DELETE requests to
`/mcp` before constructing an SDK transport. Do not rely on the v1.29.0 SDK to synthesize those responses:
with session management disabled, its GET path can create an SSE stream and its DELETE path can return
success. POST uses protocol-compliant JSON responses for the initial shell.

### Criteria for stateful mode later

Reopen the decision only when a capability needs a standalone server-to-client stream, resumability, or
another protocol behavior that cannot be served by request-scoped POST responses. Request-scoped SSE
progress alone does not require a stateful MCP session. A stateful design must specify session expiry,
event replay, storage or affinity, multi-instance behavior, disconnect cleanup, and denial-of-service
limits. It must not quietly add an in-process map and call that production-ready.

## HTTP contract

### Endpoints

| Method and path | Behavior |
| --- | --- |
| `POST /mcp` | Pass the web-standard request to a new stateless SDK transport and MCP server in JSON response mode. |
| `GET /mcp` | Return `405 Method Not Allowed` without constructing an SDK transport. |
| `DELETE /mcp` | Return `405 Method Not Allowed` without constructing an SDK transport. |
| `GET /healthz` | Return a small liveness response; do not expose capabilities, configuration, or secrets. |
| Any other route | Return `404`. |

Do not add a browser-oriented CORS policy. MCP clients are not assumed to execute as arbitrary web-page
JavaScript, and CORS does not satisfy the MCP specification's origin-validation requirement. If a real
browser client is later required, give it an explicit, least-privilege policy as a separate decision.

### Configuration

Define one Zod object schema in `http/config.ts` and infer `HttpServerConfig` from it. Parse `process.env`
only in the process composition root; tests and library callers pass validated config explicitly.

| Variable | Default | Contract |
| --- | --- | --- |
| `EDITOR_MCP_HTTP_HOST` | `127.0.0.1` | Initial slice permits loopback hosts only. |
| `EDITOR_MCP_HTTP_PORT` | `3000` | Integer `0..65535`; `0` is allowed for ephemeral integration tests. |
| `EDITOR_MCP_HTTP_ALLOWED_HOSTS` | loopback host set | Comma-separated exact hostnames or host-and-port authorities; trim, normalize, reject empty entries. |
| `EDITOR_MCP_HTTP_ALLOWED_ORIGINS` | empty | Comma-separated exact origins. Missing `Origin` is accepted; a supplied origin must match. |
| `EDITOR_MCP_HTTP_SHUTDOWN_GRACE_MS` | `5000` | Positive bounded integer used before forced connection cleanup. |

Use app-specific variable names to avoid accidental collision with unrelated platform variables. Invalid
configuration must fail before the listener opens and must produce a concise error without dumping the
environment.

### Host and origin validation

Security middleware runs before body parsing or MCP server construction:

1. Require the request authority/Host to match the configured exact allowlist.
2. Accept a request without `Origin`, because native and server-to-server MCP clients commonly omit it.
3. If `Origin` is present, parse and compare its normalized origin against the explicit allowlist.
4. Reject malformed, `null`, wildcard, suffix-matched, or lookalike values with `403`.
5. Do not infer trust from `X-Forwarded-Host` or `X-Forwarded-For` in the local slice.

Proxy trust, forwarded-header handling, and a production public origin policy belong to deployment
configuration and must be designed alongside authentication.

### Error behavior

- Protocol errors are emitted by the SDK in MCP/JSON-RPC form.
- HTTP routing and security failures use small generic responses.
- Unexpected handler errors are logged internally through an injected logger and return a sanitized
  response; stack traces, environment values, document content, and credentials never cross the wire.
- Request cleanup is guaranteed even if connection, handling, or transport close fails.
- One request failure must not corrupt another request because no transport instance is shared.

## Runtime and lifecycle contract

The HTTP process uses a lifecycle appropriate to a network listener rather than reusing the stdio
lifecycle mechanically.

```text
idle --start--> starting --listen succeeds--> running --close--> closing --> closed
                  |                               |
                  +--listen fails----------------+--close while starting--> closing
```

Required behavior:

- `start()` is idempotent while starting or running and cannot reopen a closing or closed runtime.
- `close()` is idempotent from every state, including before or during start.
- the resolved start result exposes the actual bound address so port `0` tests do not scrape logs;
- `SIGINT` and `SIGTERM` share one cached graceful-shutdown path;
- shutdown first stops accepting new connections and waits for active work;
- after the configured grace deadline, remaining connections are explicitly closed and the process
  reports failure rather than hanging indefinitely;
- listeners and signal handlers are removed after shutdown; and
- the compiled process test asserts the real child exit code and signal.

The HTTP process does not treat stdin EOF as shutdown. Unlike stdio, its lifecycle is owned by the
network listener and termination signals or an embedding caller.

Use the Node server returned by `@hono/node-server`. Prefer Node's `server.close()` behavior for graceful
drain and `server.closeAllConnections()` only after the grace period. Keep the clock/timer and process
controls injectable in focused tests, as the stdio process tests already do.

## Package and command changes

The implementation PR should make these manifest changes in `apps/mcp-server`:

```json
{
  "bin": {
    "editor-mcp": "./dist/cli.js",
    "editor-mcp-http": "./dist/http/cli.js"
  },
  "dependencies": {
    "@hono/node-server": "1.19.14",
    "@modelcontextprotocol/sdk": "1.29.0",
    "hono": "4.12.30",
    "zod": "4.4.3"
  }
}
```

Add narrowly named scripts for HTTP development, start, and integration testing while preserving all
existing stdio commands. Add a root Make target such as `make mcp-http` for the compiled local server and
document the corresponding Inspector command. Do not put the live HTTP smoke test in the ordinary
format/lint/unit `make check` path if it would leave a server running; the automated ephemeral-port
integration test must be part of `make check` instead.

## TDD execution plan

Every milestone begins with a failing behavioral test and ends with the smallest implementation that
satisfies it. Do not build product capabilities as test fixtures; use the existing internal probe
registrar only where a listed tool is necessary to prove round-trip behavior.

### 1. Dependency and compile gate

1. Declare exact Hono and Node adapter dependencies in `apps/mcp-server`.
2. Add the HTTP source/test folders and strict ESM entry points.
3. Add the second compiled binary without changing `editor-mcp`.
4. Prove direct and symlinked execution resolve the intended `http/cli.js` entry point.

Exit: the package builds in NodeNext mode, both binaries resolve, and the lockfile contains one resolved
Hono/Node-adapter version.

### 2. Configuration contract

Write table-driven tests before the schema for:

- all defaults;
- explicit host, port, allowlists, and grace period;
- port `0`;
- whitespace normalization and duplicate allowlist values;
- invalid ports, malformed origins, empty entries, unsafe hosts, and non-integer grace periods; and
- sanitized failure output.

Exit: one Zod schema owns validation and one inferred type flows inward.

### 3. Secure application factory

Create a side-effect-free Hono app factory and test it with `app.request()`:

- `GET /healthz` succeeds for an allowed Host and returns only liveness data;
- unknown routes return `404`;
- allowed requests with no Origin reach the route;
- exact allowed origins reach the route;
- malformed or unlisted Host/Origin values return `403` before MCP construction;
- wildcard and suffix tricks do not pass; and
- no permissive CORS header is emitted.

Exit: routing and security can be tested without opening a socket or starting an MCP client.

### 4. Stateless MCP request contract

Add `/mcp` using `WebStandardStreamableHTTPServerTransport` and the existing server factory. Tests must
prove:

- initialization returns exact server name/version and negotiated protocol behavior;
- a test-only registered probe tool can be listed and called through Streamable HTTP;
- the production registrar still advertises no product capabilities;
- malformed JSON and invalid MCP messages return protocol-correct failures;
- GET and DELETE receive application-owned `405` responses without SDK server construction;
- separate and concurrent requests receive separate server/transport instances;
- all per-request resources close after the complete JSON response on success and failure; and
- a handler error does not leak its internal message or stack.

Use SDK-level in-memory request tests where possible. Do not assert private fields in Hono or the MCP
SDK.

Exit: the app implements the protocol endpoint without a live network listener.

### 5. Listener lifecycle

Drive `runtime.ts` through a fake or controlled Node server and cover:

- start, repeated start, close, and repeated close;
- close before start and close while start is pending;
- listen failure;
- signal-driven shutdown;
- active request drain;
- grace timeout followed by forced connection closure; and
- listener and signal-handler cleanup.

Exit: lifecycle state and observable event ordering are deterministic, with no test process exits.

### 6. Real protocol integration

Start the app on `127.0.0.1` with port `0`. Use the official SDK `Client` and
`StreamableHTTPClientTransport` to:

1. initialize and assert server metadata;
2. ping the server;
3. list or call the test-only probe capability;
4. close the client and server cleanly; and
5. assert there are no leaked listener handles.

Repeat essential isolation assertions with two clients or concurrent requests. The test should discover
the actual address from the returned listener, not from a fixed port or arbitrary delay.

Exit: a real standards-compliant SDK client completes the full HTTP handshake over a socket.

### 7. Compiled-process integration

Build and launch `dist/http/cli.js`, including through a temporary package-bin symlink. Establish a real
MCP client connection, then send `SIGTERM` and assert the child exits with `code: 0`, `signal: null`, and
no unsanitized stderr. Add a forced-timeout case only if it can remain deterministic.

The child should emit one concise readiness line to stderr containing the bound local URL for humans.
Tests should prefer a dedicated structured observation seam or a narrowly parsed line over timing sleeps.
MCP protocol traffic must never be written to stdout by the HTTP process.

Exit: packaged execution, handshake, and graceful termination work outside the Vitest process.

### 8. Generic client interoperability smoke tests

Document one vendor-neutral smoke test first:

```sh
make mcp-http
pnpm exec mcp-inspector --transport http --server-url http://127.0.0.1:3000/mcp
```

This opens the Inspector UI with the HTTP endpoint selected and initialization succeeds without invoking
an unavailable capability. The automated smoke uses the official SDK client to initialize and ping the
same endpoint. Also document minimal examples for clients that already support Streamable HTTP, such as:

```toml
[mcp_servers.editor_mcp]
url = "http://127.0.0.1:3000/mcp"
```

Provider-specific examples belong under an interoperability heading and must not change server behavior.
For hosted agent platforms, the documentation must say that localhost is not reachable from the provider
and that public HTTPS plus supported authentication are prerequisites.

Exit: Inspector and at least one independent client can initialize against the same unmodified endpoint.
Manual smokes supplement, but do not replace, the SDK integration suite.

### 9. Repository gate

Run:

```sh
pnpm --filter @editor-mcp/mcp-server build
pnpm --filter @editor-mcp/mcp-server typecheck
pnpm --filter @editor-mcp/mcp-server test
pnpm --filter @editor-mcp/mcp-server test:integration
make check
git diff --check
```

Exit: all existing stdio tests still pass, HTTP tests meet repository coverage thresholds, both compiled
binaries work, and no unrelated package or product contract changed.

## Interoperability policy

The compatibility target is the MCP specification, not a hardcoded client list. The server must not
branch on user agent, provider name, model name, or proprietary headers. Client-specific workarounds
require a reproducible protocol incompatibility, a focused regression test, and a documented removal
condition.

Compatibility evidence should be layered:

1. protocol behavior through the official SDK client;
2. independent inspection through MCP Inspector;
3. optional smokes with representative desktop, CLI, IDE, hosted, and custom agent clients; and
4. later conformance coverage as the MCP ecosystem's test tooling stabilizes.

This approach supports Codex, Claude, and people's own agents to the extent that each client implements
standard Streamable HTTP and the deployment is reachable with an authentication method it supports.

## Public deployment follow-up

Do not expose the local slice directly to the public internet. A later remote-runtime plan must decide
and test:

- HTTPS termination and canonical public endpoint URL;
- MCP OAuth 2.1 protected-resource metadata and authorization-server discovery;
- token audience, scope, expiry, revocation, and authorization context propagation;
- document- and tenant-level authorization before capability execution;
- request size, concurrency, duration, cancellation, and rate limits;
- trusted proxy and forwarded-header rules;
- structured logs, metrics, traces, audit records, and secret redaction;
- deployment health/readiness, graceful rollout, and multi-instance behavior; and
- abuse cases including DNS rebinding, token forwarding, cross-tenant access, and session exhaustion.

Static bearer-token support may be useful for explicitly private deployments, but it is not a substitute
for broad remote interoperability. OAuth should be the default target for a publicly offered MCP service.

## Deferred and non-goals

- Product tool, resource, prompt, and editor-operation contracts.
- Tiptap, ProseMirror, Yjs, collaboration, and document persistence decisions.
- Legacy SSE transport compatibility.
- Stateful MCP sessions, event stores, resumability, and standalone notification streams.
- OAuth provider selection or implementation.
- Public hosting, TLS, reverse proxy, container, and deployment manifests.
- Browser-page MCP clients and permissive CORS.
- SDK v2 migration before the stable release and a separate migration review.

## Acceptance criteria

The Streamable HTTP transport slice is complete when:

- `http://127.0.0.1:3000/mcp` accepts a conforming Streamable HTTP MCP client;
- the implementation uses the installed stable SDK v1 API and the app directly declares every runtime
  dependency it imports;
- independent requests do not share SDK server, transport, or session state;
- Host and optional Origin validation fail closed before MCP processing;
- listener shutdown is bounded, idempotent, and proven by actual child-process exit;
- the existing stdio executable and tests remain unchanged in behavior;
- no product capabilities or editor-domain decisions are introduced;
- automated contract and process tests are part of `make check`;
- manual Inspector and representative-client instructions are documented; and
- documentation clearly distinguishes local interoperability from authenticated public deployment.

## Source references

- [MCP Streamable HTTP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP TypeScript SDK v1 server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md)
- [Hono on Node.js](https://hono.dev/docs/getting-started/nodejs)
- [Hono app API](https://hono.dev/docs/api/hono)
- [Hono Accepts helper](https://hono.dev/docs/helpers/accepts)
- [Hono testing guide](https://hono.dev/docs/guides/testing)
- [Node HTTP server API](https://nodejs.org/api/http.html)
- [Node network server API](https://nodejs.org/api/net.html)
- [Zod API](https://zod.dev/api)
- [Vitest mocking and timer API](https://vitest.dev/api/vi)
- [fast-check getting started](https://fast-check.dev/docs/introduction/getting-started/)
- [pnpm continuous integration](https://pnpm.io/continuous-integration)
- [Codex MCP client configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Claude remote MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)
- [Claude custom remote MCP integrations](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers)

Provider references above validate representative client interoperability only. They are not normative
for the server; the MCP specification and the installed SDK version define implementation behavior.
