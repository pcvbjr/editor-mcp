# Editor MCP Production Implementation Plan

**Status:** Active
**Approach:** Test-driven, production path from the first vertical slice
**Normative design:** [architecture.md](architecture.md), [mvp-schema.md](mvp-schema.md), and [diffing-plan.md](diffing-plan.md)

This is the consolidated delivery plan. Every phase produces working, tested production code. There is no disposable spike track: technical experiments belong inside the phase that will ship the resulting capability.

## Current baseline

Complete:

- TypeScript and pnpm workspace infrastructure from `origin/main`.
- Strict lint, formatting, type-checking, build, Vitest, and coverage gates.
- Versioned Zod contracts in `@editor-mcp/protocol`.
- Normative MVP schema covering common blocks, lists, marks, tables, and tracking fields.
- Initial contract tests for schema capabilities, document reads, table operations, model-supplied IDs, and duplicate operation IDs.

The current baseline passes `pnpm run check`.

## Delivery principles

- Write a failing test before implementing each behavior.
- Keep the semantic mutation core independent of MCP, HTTP, and Tiptap UI concerns.
- Treat Hocuspocus/Yjs as authoritative from the first mutation phase.
- Keep resolution-critical change metadata collaborative and durable.
- Let clients decide how tracked changes look; the service exposes synchronized semantic state and resolution commands.
- Use deterministic fixtures across unit, REST, collaboration, persistence, and browser tests.
- Do not broaden the MVP schema without a capability, fixture, and migration decision.
- A phase is complete only when its exit criteria pass in a clean checkout.

## Phase 1 — MVP schema and adapter

Build the certified Tiptap/ProseMirror adapter:

- `doc`, paragraphs, headings, blockquotes, lists, list items, code blocks, horizontal rules, hard breaks, and tables.
- Bold, italic, strike, code, link, and `diffChange` marks.
- Stable server-owned block IDs and tracking attributes.
- Strict HTML allowlist and canonical HTML/ProseMirror conversion.
- Duplicate-ID, unsupported-content, invalid-nesting, and resource-limit rejection.
- Yjs-backed `diffChanges` metadata.

TDD order:

1. Schema construction and capability manifest tests.
2. Canonical ProseMirror JSON fixtures.
3. HTML round-trip and lossy-parse rejection tests.
4. Stable-ID lifecycle tests for insert, move, replace, split, join, copy, and type changes.
5. Tracking mark/attribute and metadata invariants.

Exit criteria:

- Every supported fixture parses and serializes losslessly at the semantic level.
- Unsupported input fails without mutation.
- All generated IDs are unique, server-owned, and deterministic under replay.

## Phase 2 — Shared executable fixtures and visual harness

Create one fixture system consumed by all test layers. Each fixture contains:

- Initial canonical document.
- Semantic operation or batch.
- Expected proposed document and tracking state.
- Expected accepted document.
- Expected rejected document.
- Expected conflicts and invariants.

Expose every fixture through a browser page with four independent editors:

```text
before → proposed
             ├── accepted
             └── rejected
```

The harness supports fixture filtering, direct fixture URLs, operation details, assertion status, schema version, and reproducible seeds. Accepted and rejected states are always derived independently from proposed state.

Exit criteria:

- The same fixture drives automated and visual verification.
- The initial page covers text replacement, insertion, deletion, lists, nesting, headings, and tables.
- Browser state agrees with canonical JSON and clean projections.

## Phase 3 — Mutation core

Implement framework-neutral semantic mutation use cases:

- Read document and bounded block projections.
- `insert_before`, `insert_after`, `replace_block`, and `delete_block`.
- Localized text insert/delete/replace.
- Structured table row and column operations.
- Atomic multi-operation batches.
- Target digest preconditions and structured conflict results.
- Durable idempotency ledger and replay behavior.
- Operation provenance and audit envelope.

TDD order:

1. Operation planning tests against immutable document fixtures.
2. Schema-valid transaction tests.
3. Stale-target, missing-target, ambiguous-target, and schema-mismatch tests.
4. Atomicity tests proving no partial batch mutation.
5. Idempotency tests for duplicate, concurrent, and mismatched retries.

Exit criteria:

- Every accepted operation changes only intended targets and required ancestors.
- Every rejected operation leaves the document unchanged.
- Replays have one semantic effect and return the original result.

## Phase 4 — Review resolution

Implement server-side tracked-change semantics without prescribing client visuals:

- Create and group change segments.
- Preserve proposed deletions until resolution.
- Accept and reject inline, block, grouped, and table changes.
- Resolve changes atomically and idempotently.
- Serialize conflicting accept/reject commands.
- Keep resolution-critical metadata synchronized in Yjs.
- Return semantic change state for clients to render.

Defer standalone formatting-only suggestions until text, block, and table resolution is stable. Formatted replacement content remains supported.

Exit criteria:

- Accept and reject produce the expected clean documents from independent proposed copies.
- Concurrent clients converge after proposal and resolution.
- Pending metadata survives persistence and reload.
- No client decoration is required for correctness or resolution.

## Phase 5 — Hocuspocus/Yjs production runtime

Integrate the mutation core with the authoritative collaboration runtime:

- Long-lived Hocuspocus service and direct document access.
- Yjs persistence and recovery journal/snapshots.
- Explicit transaction origins for agent, human, and resolution mutations.
- Two or more synchronized clients plus agent mutations.
- Reconnect, offline/stale state, duplicate delivery, and reload tests.
- Persistence acknowledgement before mutation success is returned.

Exit criteria:

- All connected clients converge to identical semantic state.
- Acknowledged changes survive unload and reload.
- Persistence failure cannot produce a false success.
- Cross-document and cross-tenant state cannot leak.

## Phase 6 — REST sidecar

Expose the production domain through HTTP:

- Versioned read and apply-edits endpoints.
- Structured errors and conflict recovery metadata.
- Authentication, document authorization, limits, deadlines, and cancellation.
- Durable audit and acknowledgement levels.
- REST contract tests using the shared fixture catalog.

Exit criteria:

- REST results match direct mutation-core results.
- Invalid, stale, duplicate, unauthorized, and oversized requests fail safely.
- Sidecar tests expose before/proposed/accepted/rejected fixture states.

## Phase 7 — MCP adapter

Add the thin agent-facing adapter:

- `editor.document.read.v1`.
- `editor.document.apply_edits.v1`.
- Bounded resources for outlines and blocks.
- Local stdio transport first.
- Streamable HTTP transport after domain and REST behavior is stable.
- MCP Inspector and protocol conformance tests.

Exit criteria:

- MCP calls map one-to-one to domain outcomes.
- Tool schemas prevent unsupported or unsafe inputs.
- Agents receive concise conflict and retry guidance without whole-document echoes.

## Phase 8 — Demo and release hardening

Build the finished demonstration on the same production packages:

- Agent panel that reads and submits semantic edits.
- Multiple synchronized editor clients.
- Fixture browser and visual regression routes.
- Visible collaboration, proposal, accept, and reject flows.
- Browser end-to-end tests, load tests, failure injection, recovery drills, and runbooks.

Release criteria:

- `pnpm run check` passes in a clean checkout.
- Unit, contract, integration, convergence, persistence, REST, MCP, and browser suites pass.
- Supported schema and protocol versions are documented.
- Operational limits, authorization, audit, recovery, and rollback behavior are tested.

## Immediate next task

Implement Phase 1 schema construction and Phase 2 fixture types together, starting with one `replace_block` fixture. Do not add more semantic operations until that fixture passes schema, tracking, canonicalization, and visual-state assertions.
