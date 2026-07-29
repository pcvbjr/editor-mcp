import { randomUUID } from 'node:crypto';

import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { parseHostAuthority } from './authority.js';
import type { HttpServerConfig } from './config.js';
import { parseSerializedHttpOrigin } from './origin.js';

const railwayHealthHost = 'healthcheck.railway.app';
const requestIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;

function allowedHostnames(authorities: readonly string[]): string[] {
  return authorities.flatMap((authority) => {
    const parsed = parseHostAuthority(authority);
    return parsed === undefined
      ? []
      : [parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname];
  });
}

function createAuthorityValidation(authorities: readonly string[]): RequestHandler {
  const validateHostname = hostHeaderValidation(allowedHostnames(authorities));
  return (request, response, next): void => {
    validateHostname(request, response, () => {
      const requestAuthority = parseHostAuthority(request.headers.host ?? '');
      const allowed =
        requestAuthority !== undefined &&
        authorities.some((authority) => {
          const configured = parseHostAuthority(authority);
          return (
            configured?.hostname === requestAuthority.hostname &&
            (configured.port === undefined || configured.port === requestAuthority.port)
          );
        });
      if (!allowed) {
        response.status(403).json({
          jsonrpc: '2.0',
          error: { code: -32_000, message: 'Invalid Host authority' },
          id: null,
        });
        return;
      }
      next();
    });
  };
}

export function createMcpHostValidation(config: HttpServerConfig): RequestHandler {
  return createAuthorityValidation(config.allowedHosts);
}

export function createHealthHostValidation(config: HttpServerConfig): RequestHandler {
  return createAuthorityValidation([...config.allowedHosts, railwayHealthHost]);
}

export function createOriginValidation(config: HttpServerConfig): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const requestOrigin = request.header('origin');
    if (requestOrigin === undefined) {
      next();
      return;
    }

    const normalized = parseSerializedHttpOrigin(requestOrigin);
    if (
      normalized === undefined ||
      requestOrigin !== normalized ||
      !config.allowedOrigins.includes(normalized)
    ) {
      response.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}

export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const candidate = request.header('x-railway-request-id');
  const requestId =
    candidate !== undefined && requestIdPattern.test(candidate) ? candidate : randomUUID();
  response.setHeader('x-request-id', requestId);
  response.locals['requestId'] = requestId;
  next();
}
