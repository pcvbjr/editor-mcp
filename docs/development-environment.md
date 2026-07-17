# Development environment

## Supported toolchain

Editor MCP requires Node.js 22.13.0 or newer and pnpm 11.9.0. The root `package.json` owns
these requirements. Run repository verification through `make check` so local terminals, Codex,
and CI use the same gate.

## Codex configuration

The trusted-project configuration in `.codex/config.toml` extends Codex's workspace profile and
adds only the network access required by local integration tests:

- subprocesses may bind and connect to `localhost`, `127.0.0.1`, and `::1`;
- public network destinations remain unavailable inside the sandbox;
- the user's shell profile is loaded so version managers and user-local executables are available;
- filesystem access retains the built-in workspace safeguards, including protected `.git` and
  `.codex` paths.

Codex loads project configuration only for trusted projects. Start a new task after changing the
configuration so its execution profile is rebuilt.

Dependency installation and tests that intentionally contact public services still require a
separate, explicit network approval. Do not broaden the project profile to unrestricted network or
filesystem access for those occasional operations. In particular, pnpm's lockfile supply-chain
verification may consult registry metadata even when installation is requested with `--offline`;
use `make install` with narrowly approved registry access for a clean bootstrap.

## Diagnosing environment failures

Treat failures by boundary before treating them as product defects:

| Symptom | Boundary | Action |
| --- | --- | --- |
| `node: command not found` | Shell toolchain | Confirm the shell profile exposes Node 22.13.0 or newer. |
| `listen EPERM` on a loopback address | Codex sandbox | Confirm the project is trusted and the project permission profile is active. |
| Child readiness timeout after `listen EPERM` | Downstream symptom | Resolve the socket denial first; do not report both as independent failures. |
| Registry lookup during an offline pnpm install | Dependency policy | Bootstrap with `make install` and explicit registry access. |
| DNS, registry, or public HTTP failure | External network | Request narrowly scoped host-level network access when the operation requires it. |
| Failure reproduced outside Codex | Application or host | Investigate it as a real test or host configuration failure. |

## Verification

From the repository root:

```sh
node --version
pnpm --version
make check
```

When changing the Codex permission profile, also verify that a short-lived server can bind to an
ephemeral loopback port from a fresh Codex task. The full integration suite remains the
authoritative check; the focused probe only diagnoses the environment boundary.
