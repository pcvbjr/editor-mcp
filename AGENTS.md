# Editor MCP Agent Guidance

## Start here

- If implementation evidence challenges an accepted decision, explicitly reopen or supersede it
  rather than silently diverging.
- Use `make check` as the canonical verification gate. See `docs/development-environment.md` for
  the supported toolchain, Codex loopback profile, and environment-failure classification.
- Keep this file concise. Put feature- and version-specific rules in the nearest design document,
  package, or nested `AGENTS.md`.

## Quality bar

Review changes against observable requirements rather than subjective scores:

- Each business rule, public contract, runtime schema, and important constant has one authoritative
  owner.
- Responsibilities and dependency boundaries are clear without speculative abstractions or
  ceremonial interfaces.
- Correctness, safety, and clarity take precedence over deduplication or architectural symmetry.
- Follow official documentation for the dependency version resolved by the lockfile unless an
  accepted repository decision says otherwise.

### Applying DRY and aim for 90/100

- Reuse domain knowledge, not merely similar-looking code.
- Extract an abstraction after a second real use demonstrates a stable shared concept, or when a
  present architectural boundary requires substitution.
- Do not maintain parallel definitions of the same contract. In particular, infer public TypeScript
  types and generated JSON Schema from their runtime schemas.
- Prefer a little local repetition over an abstraction that couples unrelated features or hides
  control flow.

### Applying SOLID and aim for 80/100 or better

- Give a module or function one clear reason to change.
- Keep business policy independent from transports, editors, persistence, and other vendor SDKs.
- Introduce interfaces at genuine substitution or testing boundaries, not around every function.
- Keep interfaces narrow and consumer-focused. Implementations must preserve documented error,
  cancellation, atomicity, and durability contracts.
- Prefer plain functions and data. Use stateful objects only when identity or lifecycle makes them
  clearer.

## Engineering expectations

- Implement the smallest coherent solution that fully satisfies the requested behavior.
- Make invalid states difficult to represent and validate every untrusted boundary. Once data is
  validated, do not repeatedly validate it through internal layers.
- Use explicit domain language. Avoid vague names such as `manager`, `helper`, `data`, or `utils`
  when a more precise responsibility exists.
- Keep side effects at boundaries and make core behavior deterministic where practical.
- Prefer immutable values. Isolate unavoidable mutation inside transactions or stateful adapters.
- Fail closed on unsupported, ambiguous, stale, or unauthorized operations. Never report success
  after a partial mutation.
- Use stable domain errors and preserve causal context internally. Do not expose secrets, document
  contents, stack traces, or raw infrastructure errors to clients.
- Comments explain decisions, invariants, and tradeoffs, not syntax. Remove stale comments in the
  same change.
- Do not add a dependency when the platform or an existing dependency already provides the needed
  behavior. New architecture-shaping dependencies require a clear present use.

## Architecture guardrails

- Keep the domain core independent from MCP wire schemas, Tiptap, persistence, and deployment code.
- Public wire schemas have one owner in the protocol boundary. Translate between protocol DTOs and
  domain types at the application boundary.
- The intended dependency direction is:
  - composition roots may depend on protocol adapters, editor adapters, and the core;
  - protocol and editor adapters may depend on the core;
  - the core must not depend on adapters or public wire contracts.
- Keep MCP handlers and editor integrations thin. Do not spread vendor types through the core.
- The host editor adapter owns its exact schema, extensions, stable IDs, and transactions.
  `docs/diffing-plan.md` remains a proposal until an accepted review/tracked-changes ADR selects a
  representation.
- Do not bypass public package boundaries or introduce dependency cycles once those packages exist.
- Runtime dependencies belong to the workspace package that imports them. Root dependencies are
  acceptable during the single-package spike; move them with the code when packages are extracted.

## Type and API design

- When a third-party boundary requires an assertion, isolate it beside runtime validation and add a
  concise rationale and focused test. Do not use assertions merely to silence the compiler.
- Any `@ts-expect-error` must explain the expected error and be exercised by a compile-time test or
  fixture.
- Prefer discriminated unions and exhaustive handling for operations, results, errors, and state
  machines.
- Keep public APIs small and intentional. Do not export internals in anticipation of future use.
- Preserve the difference between an omitted value, `null`, and `undefined` when the contract does.
- Avoid hidden global state and time-dependent behavior. Inject nondeterministic capabilities such
  as clocks, IDs, and storage at the boundary that owns them.

## Testing expectations

- Match verification to the change. Behavior changes require tests; documentation-only changes need
  formatting and relevant link or example checks, not artificial behavioral tests.
- Test observable behavior and invariants, not private implementation details.
- Every bug fix includes a regression test that fails for the original cause.
- Cover success, rejection, malformed input, stale state, retries, cancellation, and atomic failure
  where applicable.
- Use property or model-based tests when the input space or state transitions make example tests
  insufficient, especially for document transformations, schema round trips, idempotency, stable
  IDs, Unicode, nested structures, and edit sequences.
- Prefer real domain and editor behavior over mocks. Mock only slow or nondeterministic external
  boundaries.
- Coverage is a floor, not the goal. Do not add meaningless assertions or test implementation
  details to improve a percentage.

## Definition of done

- The requested behavior is complete and verified at the appropriate level. Public contract or
  architecture changes are documented and decision statuses remain accurate.
- The final diff contains no unrelated edits, duplicated rules, leaked dependencies, unexplained
  suppressions, or dead code.
- Run `make check` for code or tooling changes, plus focused integration or end-to-end verification
  for every changed boundary. For documentation-only changes, run the applicable formatting and
  document checks.
- Record intentional exceptions in the change with their scope and rationale; do not weaken the
  repository-wide rule to accommodate a one-off boundary.
- Do not commit, push, publish, or change external state unless the user explicitly requests it.
