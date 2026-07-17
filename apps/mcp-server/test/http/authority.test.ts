import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseHostAuthority } from '../../src/http/authority.js';
import { parseOrigin } from '../../src/http/origin.js';

describe('HTTP authority parsing', () => {
  it('canonicalizes equivalent IPv6 spellings', () => {
    expect(parseHostAuthority('[0:0:0:0:0:0:0:1]:3000')).toEqual({
      canonical: '[::1]:3000',
      hostname: '::1',
      port: 3000,
    });
  });

  it.each([
    'a..b',
    'a.-b',
    'a-.b',
    `${'a'.repeat(64)}.example`,
    'a'.repeat(254),
    '[not-ipv6]',
    'localhost:',
  ])('rejects malformed authority %s', (authority) => {
    expect(parseHostAuthority(authority)).toBeUndefined();
  });

  it('produces an idempotent canonical authority for every accepted input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (value) => {
        const parsed = parseHostAuthority(value);
        if (parsed === undefined) return;
        expect(parseHostAuthority(parsed.canonical)).toEqual(parsed);
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('HTTP Origin parsing', () => {
  it.each([
    '',
    ' https://agent.example',
    'https://agent.example ',
    'null',
    '*',
    'ftp://agent.example',
    'https://user@agent.example',
    'https://agent.example/path',
    'https://agent.example?query',
    'https://agent.example#fragment',
  ])('rejects malformed Origin %s', (origin) => {
    expect(parseOrigin(origin)).toBeUndefined();
  });

  it('canonicalizes scheme, hostname, and default port', () => {
    expect(parseOrigin('HTTPS://AGENT.example:443/')).toBe('https://agent.example');
  });
});
