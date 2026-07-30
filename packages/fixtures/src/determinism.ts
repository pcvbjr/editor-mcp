import { createHash } from 'node:crypto';

export interface DeterministicFixtureFactories {
  readonly blockId: () => string;
  readonly changeId: () => string;
  readonly changeSetId: () => string;
}

function digest(seed: number, namespace: string, sequence: number): string {
  return createHash('sha256')
    .update(`${String(seed)}:${namespace}:${String(sequence)}`, 'utf8')
    .digest('hex');
}

function uuidFromHex(value: string): string {
  const hex = value.slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const normalized = hex.join('');
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20, 32),
  ].join('-');
}

/**
 * Recreates all server-owned fixture IDs from the published seed. Separate
 * counters keep changes in one ID family from perturbing another.
 */
export function createDeterministicFixtureFactories(seed: number): DeterministicFixtureFactories {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4_294_967_295) {
    throw new TypeError('Fixture seed must be an unsigned 32-bit integer');
  }
  let blockSequence = 0;
  let changeSequence = 0;
  let changeSetSequence = 0;
  return {
    blockId: () => {
      const value = uuidFromHex(digest(seed, 'block', blockSequence));
      blockSequence += 1;
      return value;
    },
    changeId: () => {
      const value = `chg_${digest(seed, 'change', changeSequence).slice(0, 24)}`;
      changeSequence += 1;
      return value;
    },
    changeSetId: () => {
      const value = `grp_${digest(seed, 'change-set', changeSetSequence).slice(0, 24)}`;
      changeSetSequence += 1;
      return value;
    },
  };
}
