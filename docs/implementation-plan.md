# Editor MCP Production Implementation Plan

**Status:** Active
**Approach:** Test-driven delivery through a production vertical slice, followed by parallel domain, runtime, UI, and transport workstreams.
**Normative design:** [architecture.md](architecture.md), [mvp-schema.md](mvp-schema.md), and [diffing-plan.md](diffing-plan.md)

This plan is organized around integration gates rather than a strictly serial list of features. Every gate must produce working, tested production code. Workstreams may proceed in parallel after their stated contracts are stable.

## Current baseline

Complete:

- Gates 0–2: versioned contracts, certified Tiptap adapter, deterministic fixture catalog, semantic
  mutation surface, review resolution, and authoritative Hocuspocus/Yjs persistence.
- REST plus local and authenticated remote MCP transport infrastructure.
- MCP create, read, and atomic edit tools with server-owned document identities and editor URLs.
- A bring-your-own-agent product demo with named multi-edit suggestion groups, previews, document
  navigation, group and individual review controls, and a live collaborative Tiptap editor.
- Strict lint, formatting, type-checking, build, Vitest, package-install, and coverage gates.

The current baseline passes `pnpm run check`.

## Delivery principles

- Write a failing test before implementing each behavior.
- Keep the semantic mutation core independent of MCP, HTTP, and Tiptap UI concerns.
- Treat the authoritative Y.Doc as the source of collaborative state from the first production vertical slice.
- Keep resolution-critical change metadata collaborative and durable.
- Let clients decide how tracked changes look; the service exposes synchronized semantic state and resolution commands.
- Use deterministic fixtures across unit, REST, collaboration, persistence, and browser tests.
- Do not broaden the MVP schema without a capability, fixture, and migration decision.
- A phase or workstream is complete only when its exit criteria pass in a clean checkout.
- Replayed operations return the original generated IDs and result. ID generation itself remains server-owned and opaque.

## Dependency graph

```text
Gate 0: contracts and package boundaries
              |
              v
Gate 1: certified adapter + executable fixture kernel
              |
              v
Gate 2: replace_block production vertical slice
              |
       +------+-------+--------+---------+
       |              |        |         |
       v              v        v         v
   Domain         Review    Runtime   Browser
   surface       semantics  hardening harness
       |              |        |         |
       +--------------+--------+---------+
              |
              v
       Transport integration
       REST + local MCP in parallel
       remote MCP after auth/runtime contracts
              |
              v
       Gate 3: release hardening
```

## Gate 0 — Contract freeze and package boundaries

Define the seams that allow the implementation workstreams to proceed independently.

Deliverables:

- Document identity: tenant, document, incarnation, collaboration field, schema ID, and schema version.
- Adapter ports for schema construction, canonical projections, stable IDs, transactions, and Yjs metadata.
- Versioned operation, result, conflict, audit, and persistence-acknowledgement contracts.
- Idempotency scope and replay rules.
- Change metadata lifecycle: proposed, pending, accepted, rejected, grouped, and resolved.
- Authorization context and operation policy hooks.
- Shared fixture type, seed, expected-state, and invariant contracts.
- Package boundaries for protocol, domain, adapter, runtime, fixture catalog, browser harness, REST, and MCP.

Verification:

- Contract tests cover valid, invalid, stale, duplicate, mismatched, and unsupported requests.
- Domain packages do not import MCP, HTTP, browser, or UI packages.
- Every contract has an explicit version and compatibility policy.

Exit criteria:

- The first vertical slice can be implemented without inventing transport-specific behavior.
- The fixture format can be consumed by unit tests and browser tests without adapters to test code.

## Gate 1 — Certified adapter and executable fixture kernel

Build the schema and the smallest shared fixture runner.

Adapter scope:

- `doc`, paragraphs, headings, blockquotes, lists, list items, code blocks, horizontal rules, hard breaks, and tables.
- Bold, italic, strike, code, link, and `diffChange` marks.
- Server-owned block IDs and tracking attributes.
- Replacement identity semantics: `replace_block` retires the target ID and assigns fresh IDs to
  the entire replacement subtree, while localized text and formatting edits retain block identity.
- Strict HTML allowlist and canonical HTML/ProseMirror conversion.
- Duplicate-ID, unsupported-content, invalid-nesting, and resource-limit rejection.
- Yjs-backed `diffChanges` metadata through the adapter port.

Fixture kernel scope:

- Initial canonical document.
- One semantic operation or batch.
- Expected proposed document and tracking state.
- Expected accepted and rejected documents.
- Expected conflicts and invariants.
- Deterministic seed and schema version.
- Independent materialization of accepted and rejected states from proposed state.

Initial certified fixture:

- One `replace_block` operation with a target digest, suggested-change mode, inline or block tracking as appropriate, and expected accept/reject projections.

Verification:

1. Schema construction and capability manifest tests.
2. Canonical ProseMirror JSON fixtures.
3. HTML round-trip and lossy-parse rejection tests.
4. Stable-ID lifecycle tests proving that localized edits and moves retain identity, while insert,
   replace, copy, and type-change operations receive new server-owned IDs.
5. Tracking mark, attribute, and metadata invariant tests.
6. Fixture runner tests proving that accepted and rejected states are sibling derivations.

Exit criteria:

- Supported fixtures round-trip losslessly at the semantic level.
- Unsupported input fails without mutation.
- Newly generated IDs are unique, server-owned, and stable across operation replay.
- Every `replace_block`, including a same-type replacement, retires the target identity and reports
  fresh IDs for its complete replacement subtree.
- The `replace_block` fixture runs through the shared fixture kernel.

## Gate 2 — First production vertical slice

Implement one complete operation against authoritative collaborative state before expanding the operation surface.

Scope:

- Read document and bounded block projections.
- `replace_block` with target digest preconditions.
- Suggested mutation mode for agent calls; direct mode is reserved for human/service-controlled internal paths.
- Proposal metadata and minimal accept/reject resolution.
- Atomic transaction behavior.
- Durable idempotency ledger interface and replay behavior.
- A real Hocuspocus/Yjs document lifecycle for the slice.
- Two synchronized clients, one agent mutation, persistence, unload, and reload.

Verification:

- Unit tests against immutable fixtures.
- Schema-valid transaction tests.
- Stale-target, missing-target, schema-mismatch, and unsupported-content tests.
- Atomicity tests proving no partial mutation.
- Duplicate, concurrent, and mismatched idempotency tests.
- Two-client convergence and persistence/reload tests.
- One browser route showing before, proposed, accepted, and rejected states.

Exit criteria:

- Acknowledged `replace_block` changes survive unload and reload.
- All clients converge to identical semantic state.
- Rejected operations leave the document unchanged.
- Replays return the original result and have one semantic effect.
- Persistence failure cannot produce a false success.
- The first fixture passes schema, tracking, canonicalization, collaboration, and visual-state assertions.

## Parallel workstreams after Gate 2

The following workstreams may proceed concurrently. Each must use the contracts and fixture catalog established by Gates 0–2.

### Workstream A — Complete semantic mutation surface

Implement framework-neutral mutation use cases:

- `insert_before`, `insert_after`, and `delete_block`.
- Localized text insert, delete, replace, and format operations.
- Structured table row and column operations.
- Atomic multi-operation batches.
- Target digest preconditions and structured conflict recovery metadata.
- Operation provenance and audit envelopes.

Verification:

- Every accepted operation changes only intended targets and required ancestors.
- Every rejected operation leaves the document unchanged.
- Generated documents and property-based cases remain schema-valid.
- Batch failures prove no partial mutation.
- Each operation and edge case has a shared executable fixture.

Exit criteria:

- All MVP operations in [mvp-schema.md](mvp-schema.md) have unit, integration, conflict, idempotency, and fixture coverage.
- Direct mutation-core results are deterministic and transport-independent.

### Workstream B — Complete review and resolution semantics

Expand the minimal review behavior:

- Create and group change segments.
- Preserve proposed deletions until resolution.
- Accept and reject inline, block, grouped, and table changes.
- Resolve changes atomically and idempotently.
- Serialize conflicting accept/reject commands.
- Keep resolution-critical metadata synchronized in Yjs.
- Return semantic change state for clients to render.
- Defer standalone formatting-only suggestions until text, block, and table resolution is stable.

Verification:

- Independent proposed copies produce the expected clean documents on accept and reject.
- Conflicting resolution commands have deterministic outcomes.
- Pending metadata survives persistence and reload.
- No client decoration is required for correctness or resolution.

Exit criteria:

- Every supported change kind has proposal, accept, reject, replay, conflict, and persistence fixtures.
- Concurrent proposal and resolution tests converge across clients.

### Workstream C — Runtime, durability, and collaboration hardening

Harden the production Hocuspocus/Yjs integration introduced in Gate 2:

- Long-lived Hocuspocus service and direct document access.
- Yjs persistence and recovery journal/snapshots.
- Explicit transaction origins for agent, human, and resolution mutations.
- Reconnect, offline/stale state, duplicate delivery, and reload tests.
- Persistence acknowledgement before mutation success is returned.
- Cross-document, cross-tenant, and document-incarnation isolation.

Verification:

- Controlled persistence failures, delayed acknowledgements, reloads, and recovery drills.
- Duplicate and reordered update tests.
- Two or more synchronized clients plus agent mutations.
- Isolation tests across tenants, documents, schemas, and incarnations.

Exit criteria:

- All connected clients converge to identical semantic state.
- Acknowledged changes survive unload and reload.
- Persistence failure cannot produce a false success.
- Recovery restores the last acknowledged semantic state.

### Workstream D — Shared fixture browser and visual harness

Build the browser-visible verification surface on the shared fixture catalog:

- Four independent editors: `before`, `proposed`, `accepted`, and `rejected`.
- Fixture filtering, direct fixture URLs, operation details, assertion status, schema version, and reproducible seeds.
- Canonical JSON, clean projections, tracking metadata, and schema-validity assertions in the page.
- Visual regression routes for supported blocks, lists, nesting, headings, tables, and edge cases.

Verification:

- Browser state agrees with canonical JSON and clean projections.
- Accepted and rejected states are never produced by sequentially mutating the same editor.
- Every certified fixture is reachable by a deterministic URL.

Exit criteria:

- The same fixture drives unit, REST, collaboration, persistence, and browser verification.
- Visual inspection supplements, but does not replace, semantic assertions.

### Workstream E — REST sidecar

Expose the production domain through HTTP:

- Versioned read and apply-edits endpoints.
- Structured errors and conflict recovery metadata.
- Authentication, document authorization, limits, deadlines, and cancellation.
- Durable audit and acknowledgement levels.
- REST contract tests using the shared fixture catalog.

Verification and exit criteria:

- REST results match direct mutation-core results.
- Invalid, stale, duplicate, unauthorized, oversized, cancelled, and timed-out requests fail safely.
- Persistence acknowledgement semantics are preserved across HTTP.
- Sidecar tests expose before/proposed/accepted/rejected fixture states.

### Workstream F — MCP adapters

The MCP workstream remains the owner of product-facing tools, resources, and domain contracts. An
infrastructure-only stdio shell may be developed earlier in parallel under `apps/mcp-server` so
process, transport, and lifecycle concerns are proven independently. That shell must advertise no
product capabilities and must not introduce protocol, core, or editor-tool contracts before the
corresponding domain work is ready.

Implement the thin agent-facing adapter independently of domain semantics:

- `editor.document.create.v1`.
- `editor.document.read.v1`.
- `editor.document.apply_edits.v1`.
- Bounded resources for outlines and blocks.
- Local stdio transport first.
- Streamable HTTP transport after remote authentication and runtime contracts are stable.
- MCP Inspector and protocol conformance tests.

The local stdio adapter may proceed in parallel with Workstreams C–E once the domain contracts are stable. Remote Streamable HTTP belongs in the final integration lane because it depends on authentication, authorization, cancellation, and operational policy.

Verification and exit criteria:

- MCP calls map one-to-one to domain outcomes.
- Tool schemas prevent unsupported or unsafe inputs.
- Agents receive concise conflict and retry guidance without whole-document echoes.
- Protocol behavior, transport lifecycle, cancellation, and error mapping pass conformance tests.

## Gate 3 — Integration, demo, and release hardening

Join all completed workstreams on the production packages.

Scope:

- Agent panel that reads and submits semantic edits.
- Multiple synchronized editor clients.
- Fixture browser and visual regression routes.
- Visible collaboration, proposal, accept, and reject flows.
- Browser end-to-end tests.
- Load tests, failure injection, recovery drills, rollback tests, and runbooks.
- Remote MCP authentication and operational deployment checks.

Release criteria:

- `pnpm run check` passes in a clean checkout.
- Unit, contract, integration, convergence, persistence, REST, MCP, and browser suites pass.
- Every supported schema and protocol version is documented.
- Operational limits, authorization, audit, recovery, persistence acknowledgement, and rollback behavior are tested.
- No transport bypasses the mutation core or authoritative collaboration runtime.

## Immediate next task

Harden the demo boundary into a deployable product composition: replace demo identities and memory
persistence with real tenant authentication and durable storage, add browser end-to-end coverage for
create → suggest → human edit → accept/reject → reload, and verify an external Codex or Claude client
against the hosted MCP endpoint and returned editor URL.
