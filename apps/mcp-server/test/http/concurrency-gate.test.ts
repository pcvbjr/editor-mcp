import { describe, expect, it } from 'vitest';

import { createConcurrencyGate } from '../../src/http/operations/concurrency-gate.js';

describe('concurrency gate', () => {
  it('caps active work and makes lease release idempotent', () => {
    const gate = createConcurrencyGate(1);
    const lease = gate.tryAcquire();

    expect(lease).toBeDefined();
    expect(gate.active).toBe(1);
    expect(gate.tryAcquire()).toBeUndefined();

    lease?.release();
    lease?.release();
    expect(gate.active).toBe(0);
    expect(gate.tryAcquire()).toBeDefined();
  });
});
