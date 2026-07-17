# Remote MCP production-alpha runbook

## Launch boundary

The alpha is a real production service with deliberately limited scale: one Railway region, one replica,
stateless Streamable HTTP, WorkOS-hosted OAuth, and one audience-bound MCP resource. Redis, multiple replicas,
multi-region routing, resumable sessions, and legacy SSE are deferred.

Do not invite users until the product-owned custom MCP hostname is stable. Use that exact URL, including
`/mcp`, as the Railway endpoint, WorkOS Resource Indicator, token audience, protected-resource identifier,
and `EDITOR_MCP_PUBLIC_URL`. Railway preview domains are not production OAuth resources.

## WorkOS setup

1. Configure and prove the flow in WorkOS staging first.
2. Enable Client ID Metadata Documents. Enable DCR only for a launch client that still requires it.
3. Register the exact MCP Resource Indicator. Do not configure an application scope that the resource
   server cannot verify from WorkOS's documented token or introspection contracts.
4. Confirm a real authorization-code + PKCE token has the expected `sub`, `org_id` when applicable,
   `exp`, and exact audience. Confirm introspection returns `active` and `client_id`.
5. Configure access tokens with a maximum one-hour lifetime and verify refresh in MCP Inspector and the
   selected launch clients.
6. Recreate the setup in the separate WorkOS production environment. Add production billing and branding;
   never copy staging users, keys, client secrets, or issuer values into production.
7. Create a dedicated production M2M client for non-mutating smoke checks. Product write
   policy must reject service principals unless a separate business rule authorizes them.

## Railway setup

Set the service config path to `/apps/mcp-server/railway.toml` while leaving the monorepo root as the
Railway root directory. Configure the custom domain before setting the production WorkOS resource.

Required variables:

| Variable | Value |
| --- | --- |
| `EDITOR_MCP_PUBLIC_URL` | Exact custom HTTPS endpoint ending in `/mcp`. |
| `EDITOR_MCP_AUTH_ISSUER_URL` | Exact WorkOS production issuer. |
| `EDITOR_MCP_WORKOS_CLIENT_ID` | Confidential WorkOS credential used for introspection. |
| `EDITOR_MCP_WORKOS_CLIENT_SECRET` | Matching secret; never store it in the repository. |
| `EDITOR_MCP_HTTP_HOST` | `0.0.0.0` |
| `EDITOR_MCP_HTTP_ALLOWED_HOSTS` | Custom production host and the generated Railway host when operationally required. |
| `EDITOR_MCP_HTTP_ALLOWED_ORIGINS` | Comma-separated trusted browser origins, or empty for native clients only. |

Railway supplies `PORT`. Optional bounds have production defaults: 1 MiB bodies, 25-second request
deadline, 2-second/16-request WorkOS introspection bulkhead, 32 MCP requests per replica, and a 30-second
application drain inside Railway's 35-second drain window.

## Release verification

Before inviting a user:

1. Run `make check` and the compiled package integration test.
2. Complete interactive OAuth with MCP Inspector, Claude custom connectors, and Cursor.
3. Verify missing, malformed, expired, and wrong-audience tokens fail closed.
4. Run the remote SDK smoke through the protected GitHub `mcp-production-smoke` environment.
5. Attach the product identity resolver and prove unresolved, service, and cross-tenant principals cannot
   access a document.
6. Complete one authorized read/edit/read against a disposable production document.
7. Exercise a Railway rollback and `SIGTERM` drain before launch.

## Operations

The GitHub workflow runs a non-mutating authenticated smoke every 15 minutes and after successful
production deployments. Configure its environment variable and secrets, protect the environment, and
route failures to the named alpha operator.

- WorkOS outage: the verifier returns a sanitized server failure and no request proceeds unauthenticated.
  Check WorkOS status; do not disable authentication.
- Signing-key rotation: JOSE refreshes the remote JWKS. Unknown keys remain rejected.
- Secret rotation: create the replacement WorkOS credential, update Railway and GitHub environment
  secrets, verify smoke, then revoke the old credential.
- Bad deployment: use Railway rollback. Readiness fails as shutdown starts and active requests drain before
  forced connection closure.
- Disable access: remove the public Railway domain or stop the service. Do not alter document storage and
  do not add an authentication bypass.
- Suspected credential leak: rotate the affected WorkOS credential, revoke exposed clients/tokens, and
  inspect redacted request IDs. Logs must never contain authorization headers, cookies, request bodies,
  tool arguments, tool results, tokens, or document contents.

Record the named production owner and user-facing support/security contact before launch.
