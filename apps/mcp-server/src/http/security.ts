import { randomUUID } from 'node:crypto';

import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { parseHostAuthority } from './authority.js';
import type { HttpServerConfig } from './config.js';

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

export function createMcpHostValidation(config: HttpServerConfig): RequestHandler {
  return hostHeaderValidation(allowedHostnames(config.allowedHosts));
}

export function createHealthHostValidation(config: HttpServerConfig): RequestHandler {
  return hostHeaderValidation([...allowedHostnames(config.allowedHosts), railwayHealthHost]);
}

export function createOriginValidation(config: HttpServerConfig): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const requestOrigin = request.header('origin');
    if (requestOrigin === undefined) {
      next();
      return;
    }

    try {
      const normalized = new URL(requestOrigin).origin;
      if (requestOrigin === 'null' || !config.allowedOrigins.includes(normalized)) {
        response.status(403).json({ error: 'Forbidden' });
        return;
      }
      next();
    } catch {
      response.status(403).json({ error: 'Forbidden' });
    }
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
