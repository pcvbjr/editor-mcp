import { z } from 'zod';

import { parseHostAuthority } from './authority.js';
import { parseOrigin } from './origin.js';

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

const origin = z.string().transform((value, context) => {
  const parsed = parseOrigin(value);
  if (parsed !== undefined) return parsed;

  context.addIssue({
    code: 'custom',
    message: 'Origins must be explicit HTTP(S) scheme-and-authority values',
  });
  return z.NEVER;
});

const canonicalAuthorities = csv.transform((values, context) => {
  const authorities = values.map((value) => parseHostAuthority(value));
  if (authorities.some((authority) => authority === undefined)) {
    context.addIssue({ code: 'custom', message: 'Hosts must be valid HTTP authorities' });
    return z.NEVER;
  }
  const canonical = authorities.map((authority) => authority?.canonical ?? '');
  if (new Set(canonical).size !== canonical.length) {
    context.addIssue({ code: 'custom', message: 'Hosts must not contain duplicates' });
    return z.NEVER;
  }
  return canonical;
});

const canonicalOrigins = optionalCsv.pipe(origin.array()).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: 'Origins must not contain duplicates' });
  }
});

const decimalPort = z.union([
  z.number().int().min(0).max(65_535),
  z
    .string()
    .regex(/^(?:0|[1-9]\d*)$/u, 'Port must be a nonempty decimal integer')
    .transform(Number)
    .pipe(z.number().int().min(0).max(65_535)),
]);

const httpConfigSchema = z.object({
  host: z
    .string()
    .trim()
    .refine(
      (value) => ['127.0.0.1', 'localhost', '::1'].includes(value),
      'HTTP server host must be loopback-only in this slice',
    )
    .default('127.0.0.1'),
  port: decimalPort.default(3000),
  allowedHosts: z.preprocess((value) => value ?? loopbackHosts.join(','), canonicalAuthorities),
  allowedOrigins: z.preprocess((value) => value ?? '', canonicalOrigins),
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
