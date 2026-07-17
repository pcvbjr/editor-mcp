import { z } from 'zod';

const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'] as const;

const csv = z.string().transform((value, context) => {
  const items = value.split(',').map((item) => item.trim());
  if (items.some((item) => item.length === 0)) {
    context.addIssue({ code: 'custom', message: 'Lists must not contain empty entries' });
    return z.NEVER;
  }
  return items;
});

const optionalCsv = z.string().transform((value, context) => {
  if (value.trim().length === 0) return [];
  const items = value.split(',').map((item) => item.trim());
  if (items.some((item) => item.length === 0)) {
    context.addIssue({ code: 'custom', message: 'Lists must not contain empty entries' });
    return z.NEVER;
  }
  return items;
});

const origin = z.string().superRefine((value, context) => {
  if (value === 'null' || value.includes('*')) {
    context.addIssue({ code: 'custom', message: 'Origins must be explicit values' });
    return;
  }

  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.pathname !== '/' ||
      parsed.search
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Origins must contain only a scheme and authority',
      });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'Origin must be a valid URL' });
  }
});

const httpConfigSchema = z.object({
  host: z
    .string()
    .trim()
    .refine(
      (value) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value),
      'HTTP server host must be loopback-only in this slice',
    )
    .default('127.0.0.1'),
  port: z.coerce.number().int().min(0).max(65_535).default(3000),
  allowedHosts: z.preprocess((value) => value ?? loopbackHosts.join(','), csv),
  allowedOrigins: z.preprocess((value) => value ?? '', optionalCsv.pipe(origin.array())),
  shutdownGraceMs: z.coerce.number().int().min(1).max(120_000).default(5_000),
});

export type HttpServerConfig = z.infer<typeof httpConfigSchema>;

export interface HttpEnvironment {
  readonly EDITOR_MCP_HTTP_HOST?: string;
  readonly EDITOR_MCP_HTTP_PORT?: string;
  readonly EDITOR_MCP_HTTP_ALLOWED_HOSTS?: string;
  readonly EDITOR_MCP_HTTP_ALLOWED_ORIGINS?: string;
  readonly EDITOR_MCP_HTTP_SHUTDOWN_GRACE_MS?: string;
}

export function parseHttpServerConfig(
  environment: HttpEnvironment = process.env,
): HttpServerConfig {
  return httpConfigSchema.parse({
    host: environment.EDITOR_MCP_HTTP_HOST,
    port: environment.EDITOR_MCP_HTTP_PORT,
    allowedHosts: environment.EDITOR_MCP_HTTP_ALLOWED_HOSTS,
    allowedOrigins: environment.EDITOR_MCP_HTTP_ALLOWED_ORIGINS,
    shutdownGraceMs: environment.EDITOR_MCP_HTTP_SHUTDOWN_GRACE_MS,
  });
}

export function createHttpServerConfig(
  overrides: Partial<HttpServerConfig> = {},
): HttpServerConfig {
  return httpConfigSchema.parse({
    host: overrides.host ?? '127.0.0.1',
    port: overrides.port ?? 3000,
    allowedHosts: overrides.allowedHosts?.join(',') ?? loopbackHosts.join(','),
    allowedOrigins: overrides.allowedOrigins?.join(',') ?? '',
    shutdownGraceMs: overrides.shutdownGraceMs ?? 5_000,
  });
}
