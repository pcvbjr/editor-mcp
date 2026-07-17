# ADR 0001: WorkOS and Express for remote MCP authorization

## Status

Accepted — amended before launch.

## Context

The remote Editor MCP endpoint lets third-party agents request reads and mutations against real user
documents. The service therefore needs standard MCP OAuth discovery, audience-bound credentials,
document-independent transport authorization, bounded public HTTP behavior, and a deployment model that
does not make this repository an authorization server.

The initial Streamable HTTP spike used Hono before public OAuth was in scope. The pinned
`@modelcontextprotocol/sdk` 1.29.0 resource-server helpers are Express middleware and its Node transport
accepts Express request authentication context directly.

## Decision

- Use WorkOS AuthKit as the hosted user identity source for the alpha and WorkOS Connect as the external
  OAuth authorization server.
- Keep Editor MCP exclusively an OAuth protected resource. It does not implement login, consent, token
  issuance, refresh rotation, or client registration.
- Use Express only in the remote HTTP composition root so the SDK owns Host validation, protected-resource
  metadata, bearer challenges, scope enforcement, and auth-context propagation.
- Keep stateless JSON-response Streamable HTTP. Document state belongs to the product/editor runtime, not
  an MCP session.
- Use one canonical product-owned `https://.../mcp` resource. Its exact audience is the alpha's OAuth
  transport grant.
- Verify JWT signature, issuer, audience, and expiry locally with JOSE, then use bounded WorkOS
  introspection as the authoritative source for active status and OAuth client ID.
- Translate WorkOS identity into a token-free external principal. Product code must resolve that principal
  to product-owned actor and tenant IDs before accessing a document.
- Launch one Railway replica. Distributed rate limiting and multiple replicas are deferred until document
  writes and idempotency are durable across replicas.

## Consequences

The service has a runtime dependency on WorkOS introspection and fails closed if that dependency is
unavailable. This is acceptable for the low-volume alpha and provides authoritative client identity and
revocation. Positive introspection caching is deferred until measured load defines an explicit revocation
latency contract.

Hono and `@hono/node-server` are no longer direct application dependencies. Express, JOSE,
`express-rate-limit`, Pino, and `pino-http` are direct dependencies because the MCP server imports them.
The core, stdio server, editor adapters, and product tool schemas remain independent of these choices.

If live WorkOS staging tokens do not expose the required audience, client identity, and
identity through the documented JWT/introspection surfaces, implementation stops and this decision is
explicitly reopened. Claims are never synthesized from unrelated provider fields.

## Decision update: OAuth scopes

The initial design proposed a route-wide `documents:edit` scope. Before launch, the WorkOS token and
introspection reference was rechecked and found not to expose granted OAuth scopes for Connect access
tokens. That part of the decision is superseded: the server does not request, advertise, synthesize, or
enforce a WorkOS scope that it cannot verify. The exact MCP Resource Indicator and audience gate access to
this single-purpose server. Product-owned principal, tenant, document, and operation authorization remains
mandatory before any read or mutation.
