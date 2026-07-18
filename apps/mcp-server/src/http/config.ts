import { z } from 'zod';

import { parseHostAuthority } from './authority.js';
import { parseSerializedHttpOrigin } from './origin.js';

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
  const parsed = parseSerializedHttpOrigin(value);
  if (parsed === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Origins must be explicit serialized HTTP origins',
    });
    return z.NEVER;
  }
  return parsed;
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

const httpUrl = z.url().transform((value, context) => {
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    context.addIssue({ code: 'custom', message: 'URL must be an HTTP URL without credentials' });
    return z.NEVER;
  }
  return parsed;
});

const publicMcpUrl = httpUrl.superRefine((value, context) => {
  if (value.pathname !== '/mcp') {
    context.addIssue({ code: 'custom', message: 'Public URL must end at /mcp' });
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(value.hostname);
  if (value.protocol !== 'https:' && !loopback) {
    context.addIssue({ code: 'custom', message: 'Non-loopback public URLs must use HTTPS' });
  }
});

const issuerUrl = httpUrl.superRefine((value, context) => {
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(value.hostname);
  if (value.pathname !== '/' || (value.protocol !== 'https:' && !loopback)) {
    context.addIssue({
      code: 'custom',
      message: 'WorkOS issuer must be an HTTPS origin unless it is loopback-only',
    });
  }
});

const boundedMilliseconds = (defaultValue: number, maximum: number) =>
  z.coerce.number().int().min(1).max(maximum).default(defaultValue);

const httpConfigSchema = z
  .object({
    host: z
      .string()
      .trim()
      .refine(
        (value) => ['0.0.0.0', '127.0.0.1', 'localhost', '::1'].includes(value),
        'HTTP server host must be a supported explicit listener',
      )
      .default('127.0.0.1'),
    port: decimalPort.default(3000),
    publicUrl: publicMcpUrl,
    issuerUrl,
    workosClientId: z.string().trim().min(1),
    workosClientSecret: z.string().min(1),
    allowedHosts: z.preprocess((value) => value ?? loopbackHosts.join(','), canonicalAuthorities),
    allowedOrigins: z.preprocess((value) => value ?? '', canonicalOrigins),
    bodyLimitBytes: z.coerce.number().int().min(1_024).max(10_485_760).default(1_048_576),
    requestTimeoutMs: boundedMilliseconds(25_000, 120_000),
    authTimeoutMs: boundedMilliseconds(2_000, 10_000),
    authMaxInFlight: z.coerce.number().int().min(1).max(256).default(16),
    maxInFlight: z.coerce.number().int().min(1).max(1_024).default(32),
    shutdownGraceMs: boundedMilliseconds(30_000, 30_000),
  })
  .superRefine((value, context) => {
    const publicAuthority = parseHostAuthority(value.publicUrl.host)?.canonical;
    const publicHostname = value.publicUrl.hostname.replace(/^\[|\]$/gu, '');
    if (
      publicAuthority === undefined ||
      !value.allowedHosts.some((allowed) => {
        const parsed = parseHostAuthority(allowed);
        return parsed?.hostname === publicHostname;
      })
    ) {
      context.addIssue({
        code: 'custom',
        path: ['allowedHosts'],
        message: 'Allowed hosts must include the public MCP hostname',
      });
    }
  });

export type HttpServerConfig = z.infer<typeof httpConfigSchema>;

export interface HttpEnvironment {
  readonly EDITOR_MCP_PUBLIC_URL?: string;
  readonly EDITOR_MCP_AUTH_ISSUER_URL?: string;
  readonly EDITOR_MCP_WORKOS_CLIENT_ID?: string;
  readonly EDITOR_MCP_WORKOS_CLIENT_SECRET?: string;
  readonly EDITOR_MCP_HTTP_HOST?: string;
  readonly EDITOR_MCP_HTTP_PORT?: string;
  readonly PORT?: string;
  readonly EDITOR_MCP_HTTP_ALLOWED_HOSTS?: string;
  readonly EDITOR_MCP_HTTP_ALLOWED_ORIGINS?: string;
  readonly EDITOR_MCP_HTTP_BODY_LIMIT_BYTES?: string;
  readonly EDITOR_MCP_HTTP_REQUEST_TIMEOUT_MS?: string;
  readonly EDITOR_MCP_AUTH_TIMEOUT_MS?: string;
  readonly EDITOR_MCP_AUTH_MAX_IN_FLIGHT?: string;
  readonly EDITOR_MCP_HTTP_MAX_IN_FLIGHT?: string;
  readonly EDITOR_MCP_HTTP_SHUTDOWN_GRACE_MS?: string;
}

export function parseHttpServerConfig(
  environment: HttpEnvironment = process.env,
): HttpServerConfig {
  if (
    environment.PORT !== undefined &&
    environment.EDITOR_MCP_HTTP_PORT !== undefined &&
    environment.PORT !== environment.EDITOR_MCP_HTTP_PORT
  ) {
    throw new Error('PORT and EDITOR_MCP_HTTP_PORT must match when both are configured');
  }
  return httpConfigSchema.parse({
    host: environment.EDITOR_MCP_HTTP_HOST,
    port: environment.PORT ?? environment.EDITOR_MCP_HTTP_PORT,
    publicUrl: environment.EDITOR_MCP_PUBLIC_URL,
    issuerUrl: environment.EDITOR_MCP_AUTH_ISSUER_URL,
    workosClientId: environment.EDITOR_MCP_WORKOS_CLIENT_ID,
    workosClientSecret: environment.EDITOR_MCP_WORKOS_CLIENT_SECRET,
    allowedHosts: environment.EDITOR_MCP_HTTP_ALLOWED_HOSTS,
    allowedOrigins: environment.EDITOR_MCP_HTTP_ALLOWED_ORIGINS,
    bodyLimitBytes: environment.EDITOR_MCP_HTTP_BODY_LIMIT_BYTES,
    requestTimeoutMs: environment.EDITOR_MCP_HTTP_REQUEST_TIMEOUT_MS,
    authTimeoutMs: environment.EDITOR_MCP_AUTH_TIMEOUT_MS,
    authMaxInFlight: environment.EDITOR_MCP_AUTH_MAX_IN_FLIGHT,
    maxInFlight: environment.EDITOR_MCP_HTTP_MAX_IN_FLIGHT,
    shutdownGraceMs: environment.EDITOR_MCP_HTTP_SHUTDOWN_GRACE_MS,
  });
}

const testDefaults = {
  publicUrl: 'http://127.0.0.1/mcp',
  issuerUrl: 'https://authkit.example.test/',
  workosClientId: 'client_test',
  workosClientSecret: 'secret_test',
} as const;

export function createHttpServerConfig(
  overrides: Partial<HttpServerConfig> = {},
): HttpServerConfig {
  return httpConfigSchema.parse({
    ...testDefaults,
    host: '127.0.0.1',
    port: 3000,
    bodyLimitBytes: 1_048_576,
    requestTimeoutMs: 25_000,
    authTimeoutMs: 2_000,
    authMaxInFlight: 16,
    maxInFlight: 32,
    shutdownGraceMs: 30_000,
    ...overrides,
    publicUrl: overrides.publicUrl?.href ?? testDefaults.publicUrl,
    issuerUrl: overrides.issuerUrl?.href ?? testDefaults.issuerUrl,
    allowedHosts: overrides.allowedHosts?.join(',') ?? loopbackHosts.join(','),
    allowedOrigins: overrides.allowedOrigins?.join(',') ?? '',
  });
}
