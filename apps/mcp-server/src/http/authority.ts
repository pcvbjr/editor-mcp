import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export interface HostAuthority {
  readonly canonical: string;
  readonly hostname: string;
  readonly port?: number;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,5}$/u.test(value)) return undefined;
  const port = Number(value);
  return port <= 65_535 ? port : undefined;
}

export function parseHostAuthority(value: string): HostAuthority | undefined {
  if (value.length === 0 || value !== value.trim() || /[\s@/?#]/u.test(value)) {
    return undefined;
  }

  const ipv6Match = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(value);
  if (ipv6Match !== null) {
    const hostname = ipv6Match[1]?.toLowerCase();
    const port = parsePort(ipv6Match[2]);
    if (
      hostname === undefined ||
      isIP(hostname) !== 6 ||
      (ipv6Match[2] !== undefined && port === undefined)
    ) {
      return undefined;
    }
    return {
      canonical: `[${hostname}]${port === undefined ? '' : `:${String(port)}`}`,
      hostname,
      ...(port === undefined ? {} : { port }),
    };
  }

  const hostnameMatch = /^([^:]+)(?::(\d{1,5}))?$/u.exec(value);
  if (hostnameMatch === null) return undefined;

  const rawHostname = hostnameMatch[1];
  const port = parsePort(hostnameMatch[2]);
  if (rawHostname === undefined || (hostnameMatch[2] !== undefined && port === undefined)) {
    return undefined;
  }

  const withoutTrailingDot = rawHostname.replace(/\.$/u, '');
  const hostname =
    isIP(withoutTrailingDot) === 4
      ? withoutTrailingDot
      : domainToASCII(withoutTrailingDot).toLowerCase();
  if (
    hostname.length === 0 ||
    (isIP(hostname) === 0 && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname))
  ) {
    return undefined;
  }

  return {
    canonical: `${hostname}${port === undefined ? '' : `:${String(port)}`}`,
    hostname,
    ...(port === undefined ? {} : { port }),
  };
}
