import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import cors from 'cors';
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { rateLimit } from 'express-rate-limit';
import pino, { type Logger } from 'pino';
import { pinoHttp } from 'pino-http';

import packageManifest from '../../package.json' with { type: 'json' };

import { authenticatedMcpPrincipalFromAuthInfo } from './auth/principal.js';
import type { HttpServerConfig } from './config.js';
import { createConcurrencyGate } from './operations/concurrency-gate.js';
import type { ReadinessController } from './readiness.js';
import type { ActiveRequestRegistry } from './request-registry.js';
import {
  createHealthHostValidation,
  createMcpHostValidation,
  createOriginValidation,
  requestIdMiddleware,
} from './security.js';
import { reportInternalError, type InternalErrorReporter } from '../diagnostics.js';
import { createExecutionTracker } from '../execution-tracker.js';
import {
  createMcpServer,
  type CapabilityRegistrar,
  type CreateMcpServerOptions,
} from '../server.js';

export type McpServerFactory = (
  options: CreateMcpServerOptions,
) => Pick<ReturnType<typeof createMcpServer>, 'connect' | 'close'>;

export interface HttpAppOptions {
  readonly config: HttpServerConfig;
  readonly oauthMetadata: OAuthMetadata;
  readonly tokenVerifier: OAuthTokenVerifier;
  readonly readiness: ReadinessController;
  readonly activeRequests: ActiveRequestRegistry;
  readonly register?: CapabilityRegistrar;
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly reportError?: InternalErrorReporter;
  readonly createServer?: McpServerFactory;
  readonly logger?: Logger;
}

function createHttpLogger(): Logger {
  return pino(
    {},
    pino.multistream(
      [
        { level: 'info', stream: process.stdout },
        { level: 'error', stream: process.stderr },
      ],
      { dedupe: true },
    ),
  );
}

function sendInternalError(response: Response): void {
  if (response.headersSent) return;
  response.status(500).json({
    jsonrpc: '2.0',
    error: { code: ErrorCode.InternalError, message: 'Internal server error' },
    id: null,
  });
}

function createBodyErrorHandler(): ErrorRequestHandler {
  return (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
    if (!(error instanceof Error)) {
      next(error);
      return;
    }
    const typed = error as Error & { status?: number; type?: string };
    if (typed.status === 413 || typed.type === 'entity.too.large') {
      response.status(413).json({ error: 'Request body too large' });
      return;
    }
    if (typed.status === 400 || typed instanceof SyntaxError) {
      response.status(400).json({ error: 'Malformed JSON request body' });
      return;
    }
    next(error);
  };
}

export function createHttpApp({
  config,
  oauthMetadata,
  tokenVerifier,
  readiness,
  activeRequests,
  register,
  serverName = packageManifest.name,
  serverVersion = packageManifest.version,
  reportError,
  createServer = createMcpServer,
  logger = createHttpLogger(),
}: HttpAppOptions): Express {
  const app = express();
  const requestGate = createConcurrencyGate(config.maxInFlight);

  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (request) => request.url === '/healthz' || request.url === '/readyz',
      },
      genReqId: (_request: Request, response: Response) =>
        String(response.getHeader('x-request-id')),
      customLogLevel: (_request, response, error) => {
        if (error !== undefined || response.statusCode >= 500) return 'error';
        if (response.statusCode >= 400) return 'warn';
        return 'info';
      },
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
      wrapSerializers: false,
      serializers: {
        req: (request: Request) => ({
          id: request.id,
          method: request.method,
          path: request.path,
        }),
        res: (response: Response) => ({ statusCode: response.statusCode }),
      },
    }),
  );
  app.use(createOriginValidation(config));

  const healthHostValidation = createHealthHostValidation(config);
  app.get('/healthz', healthHostValidation, (_request, response) => {
    response.json({ status: 'ok' });
  });
  app.get('/readyz', healthHostValidation, (_request, response) => {
    if (!readiness.isReady) {
      response.status(503).json({ status: 'not-ready' });
      return;
    }
    response.json({ status: 'ready' });
  });

  app.use(createMcpHostValidation(config));
  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        callback(
          null,
          requestOrigin !== undefined && config.allowedOrigins.includes(requestOrigin),
        );
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version'],
      exposedHeaders: [
        'WWW-Authenticate',
        'X-Request-Id',
        'RateLimit',
        'RateLimit-Policy',
        'Retry-After',
      ],
      optionsSuccessStatus: 204,
    }),
  );
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: config.publicUrl,
      resourceName: 'Editor MCP',
    }),
  );

  app.all('/mcp', (request, response, next) => {
    if (request.method === 'POST') {
      next();
      return;
    }
    response.setHeader('allow', 'POST');
    response.status(405).send('Method Not Allowed');
  });

  const parseJson = express.json({ limit: config.bodyLimitBytes, strict: true });
  const requireAuth = requireBearerAuth({
    verifier: tokenVerifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.publicUrl),
  });
  const requireReady: RequestHandler = (_request, response, next) => {
    if (!readiness.isReady) {
      response.setHeader('retry-after', '1');
      response.status(503).json({ error: 'Server is not ready' });
      return;
    }
    next();
  };
  const principalRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    legacyHeaders: false,
    standardHeaders: 'draft-8',
    keyGenerator: (request) => {
      const principal = authenticatedMcpPrincipalFromAuthInfo(request.auth);
      return `${principal.issuer}|${principal.organizationExternalId ?? '-'}|${principal.subject}`;
    },
  });

  app.post(
    '/mcp',
    requireReady,
    parseJson,
    createBodyErrorHandler(),
    requireAuth,
    principalRateLimit,
    async (request: Request, response: Response) => {
      const lease = requestGate.tryAcquire();
      if (lease === undefined) {
        response.setHeader('retry-after', '1');
        response.status(503).json({ error: 'Server is busy' });
        return;
      }

      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      const executions = createExecutionTracker();
      const serverOptions = reportError
        ? { name: serverName, version: serverVersion, reportError, executionTracker: executions }
        : { name: serverName, version: serverVersion, executionTracker: executions };
      const server = register
        ? createServer({ ...serverOptions, register })
        : createServer(serverOptions);
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        const results = await Promise.allSettled([transport.close(), server.close()]);
        results.forEach((result) => {
          if (result.status === 'rejected') {
            reportInternalError(reportError, { phase: 'close', error: result.reason });
          }
        });
      };
      const removeActiveRequest = activeRequests.add({ close });
      let bookkeepingSettled = false;
      const settleBookkeeping = async (): Promise<void> => {
        if (bookkeepingSettled) return;
        bookkeepingSettled = true;
        removeActiveRequest();
        lease.release();
        await close();
      };
      let resolveDeadline: (() => void) | undefined;
      const deadlineReached = new Promise<'expired'>((resolve) => {
        resolveDeadline = () => {
          resolve('expired');
        };
      });
      const deadline = setTimeout(() => {
        if (!response.headersSent) {
          response.status(504).json({ error: 'Request deadline exceeded' });
        }
        void close();
        resolveDeadline?.();
      }, config.requestTimeoutMs);

      try {
        // The SDK's Node transport declaration predates exactOptionalPropertyTypes.
        await server.connect(transport as Transport);
        const requestOutcome = await Promise.race([
          transport.handleRequest(request, response, request.body).then(() => 'handled' as const),
          deadlineReached,
        ]);
        if (requestOutcome === 'expired') await executions.whenIdle();
      } catch (error: unknown) {
        reportInternalError(reportError, { phase: 'request', error });
        sendInternalError(response);
      } finally {
        clearTimeout(deadline);
        await executions.whenIdle();
        await settleBookkeeping();
      }
    },
  );

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    void _next;
    reportInternalError(reportError, { phase: 'request', error });
    sendInternalError(response);
  });

  return app;
}
