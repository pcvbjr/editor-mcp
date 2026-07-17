import type { MiddlewareHandler } from 'hono';

import { parseHostAuthority } from './authority.js';
import type { HttpServerConfig } from './config.js';
import { parseOrigin } from './origin.js';

function hostMatches(requestHost: string, allowedHost: string): boolean {
  const requestAuthority = parseHostAuthority(requestHost);
  const allowedAuthority = parseHostAuthority(allowedHost);
  if (requestAuthority === undefined || allowedAuthority === undefined) return false;
  return (
    requestAuthority.hostname === allowedAuthority.hostname &&
    (allowedAuthority.port === undefined || requestAuthority.port === allowedAuthority.port)
  );
}

function isAllowedHost(request: Request, config: HttpServerConfig): boolean {
  const requestHost = request.headers.get('host') ?? new URL(request.url).host;
  return config.allowedHosts.some((allowedHost) => hostMatches(requestHost, allowedHost));
}

function isAllowedOrigin(request: Request, config: HttpServerConfig): boolean {
  const requestOrigin = request.headers.get('origin');
  if (requestOrigin === null) {
    return true;
  }

  const normalizedOrigin = parseOrigin(requestOrigin);
  return (
    normalizedOrigin !== undefined &&
    config.allowedOrigins.some((allowedOrigin) => allowedOrigin === normalizedOrigin)
  );
}

export function createSecurityMiddleware(config: HttpServerConfig): MiddlewareHandler {
  return async (context, next) => {
    if (!isAllowedHost(context.req.raw, config) || !isAllowedOrigin(context.req.raw, config)) {
      return context.json({ error: 'Forbidden' }, 403);
    }

    return next();
  };
}
