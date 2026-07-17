import type { MiddlewareHandler } from 'hono';

import type { HttpServerConfig } from './config.js';

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, '');
}

function hostMatches(requestHost: string, allowedHost: string): boolean {
  const requestValue = normalizeHost(requestHost);
  const allowedValue = normalizeHost(allowedHost);

  if (requestValue === allowedValue) {
    return true;
  }

  try {
    const requestUrl = new URL(`http://${requestValue}`);
    const allowedUrl = new URL(`http://${allowedValue}`);
    return allowedUrl.port.length === 0 && requestUrl.hostname === allowedUrl.hostname;
  } catch {
    return false;
  }
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

  try {
    const normalizedOrigin = new URL(requestOrigin).origin;
    return config.allowedOrigins.some((allowedOrigin) => allowedOrigin === normalizedOrigin);
  } catch {
    return false;
  }
}

export function createSecurityMiddleware(config: HttpServerConfig): MiddlewareHandler {
  return async (context, next) => {
    if (!isAllowedHost(context.req.raw, config) || !isAllowedOrigin(context.req.raw, config)) {
      return context.json({ error: 'Forbidden' }, 403);
    }

    return next();
  };
}
