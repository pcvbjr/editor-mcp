import { createHash, randomUUID } from 'node:crypto';

import type {
  IdempotencyClaim,
  IdempotencyLedger,
  IdempotencyReceipt,
  IdempotencyScope,
} from '@editor-mcp/core';
import { Doc, applyUpdate, encodeStateAsUpdate } from 'yjs';

import type { JsonObject, YjsPersistence } from './index.js';

const LEDGER_MAP = 'editorMcpIdempotency';
const ENTRY_KEY = 'entry';

interface PendingRecord {
  readonly state: 'pending';
  readonly requestHash: string;
  readonly leaseId: string;
  readonly claimedAt: string;
}

interface CompleteRecord {
  readonly state: 'complete';
  readonly requestHash: string;
  readonly receipt: IdempotencyReceipt;
}

type StoredRecord = CompleteRecord | PendingRecord;

interface LoadedLedger {
  readonly document: Doc;
  readonly sequence: number | undefined;
}

export interface DurableYjsIdempotencyLedgerOptions {
  readonly persistence: YjsPersistence;
  readonly pendingLeaseMs?: number;
  readonly now?: () => Date;
}

class KeyMutex {
  readonly #tails = new Map<string, Promise<void>>();

  public async run<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await callback();
    } finally {
      release?.();
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}

function ledgerName(scope: IdempotencyScope): string {
  const canonical = JSON.stringify([
    scope.tenantId,
    scope.principalId,
    scope.documentId,
    scope.documentIncarnation,
    scope.collaborationField,
    scope.schemaId,
    scope.schemaVersion,
    scope.key,
  ]);
  return `editor-mcp-idempotency.${createHash('sha256').update(canonical).digest('base64url')}`;
}

function cloneReceipt(receipt: IdempotencyReceipt): IdempotencyReceipt {
  return structuredClone(receipt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeStored(value: unknown): StoredRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value['state'] === 'pending' &&
    typeof value['requestHash'] === 'string' &&
    typeof value['leaseId'] === 'string' &&
    typeof value['claimedAt'] === 'string'
  ) {
    return {
      state: 'pending',
      requestHash: value['requestHash'],
      leaseId: value['leaseId'],
      claimedAt: value['claimedAt'],
    };
  }
  if (
    value['state'] === 'complete' &&
    typeof value['requestHash'] === 'string' &&
    isRecord(value['receipt'])
  ) {
    return {
      state: 'complete',
      requestHash: value['requestHash'],
      receipt: structuredClone(value['receipt']) as unknown as IdempotencyReceipt,
    };
  }
  return undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class DurableYjsIdempotencyLedger implements IdempotencyLedger {
  readonly #persistence: YjsPersistence;
  readonly #pendingLeaseMs: number;
  readonly #pollIntervalMs: number;
  readonly #now: () => Date;
  readonly #mutex = new KeyMutex();

  public constructor(options: DurableYjsIdempotencyLedgerOptions) {
    this.#persistence = options.persistence;
    this.#pendingLeaseMs = options.pendingLeaseMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.#pendingLeaseMs) || this.#pendingLeaseMs < 1) {
      throw new TypeError('pendingLeaseMs must be a positive integer');
    }
    this.#pollIntervalMs = Math.max(1, Math.min(25, Math.ceil(this.#pendingLeaseMs / 4)));
  }

  public async claim(scope: IdempotencyScope, requestHash: string): Promise<IdempotencyClaim> {
    const name = ledgerName(scope);
    return this.#mutex.run(name, async () => {
      for (;;) {
        const loaded = await this.#load(name);
        const current = decodeStored(loaded.document.getMap<JsonObject>(LEDGER_MAP).get(ENTRY_KEY));
        if (current?.requestHash !== undefined && current.requestHash !== requestHash) {
          return { kind: 'mismatch' };
        }
        if (current?.state === 'complete') {
          return { kind: 'replay', receipt: cloneReceipt(current.receipt) };
        }
        if (current?.state === 'pending') {
          const claimedAt = new Date(current.claimedAt).getTime();
          const age = this.#now().getTime() - claimedAt;
          if (Number.isFinite(age) && age < this.#pendingLeaseMs) {
            return {
              kind: 'wait',
              receipt: this.#observePending(
                name,
                requestHash,
                current.leaseId,
                claimedAt + this.#pendingLeaseMs,
              ),
            };
          }
        }

        const leaseId = randomUUID();
        loaded.document.getMap<JsonObject>(LEDGER_MAP).set(ENTRY_KEY, {
          state: 'pending',
          requestHash,
          leaseId,
          claimedAt: this.#now().toISOString(),
        });
        const acknowledgement = await this.#persistence.storeIfSequence(
          name,
          loaded.sequence,
          encodeStateAsUpdate(loaded.document),
        );
        if (acknowledgement !== undefined) {
          return { kind: 'claimed', leaseId };
        }
      }
    });
  }

  public async complete(
    scope: IdempotencyScope,
    leaseId: string,
    receipt: IdempotencyReceipt,
  ): Promise<void> {
    const name = ledgerName(scope);
    await this.#mutex.run(name, async () => {
      for (;;) {
        const loaded = await this.#load(name);
        const current = decodeStored(loaded.document.getMap<JsonObject>(LEDGER_MAP).get(ENTRY_KEY));
        if (current?.state !== 'pending' || current.leaseId !== leaseId) {
          throw new Error('Durable idempotency lease is no longer active');
        }
        if (receipt.requestHash !== current.requestHash) {
          throw new Error('Durable idempotency receipt does not match its lease');
        }
        loaded.document.getMap<JsonObject>(LEDGER_MAP).set(ENTRY_KEY, {
          state: 'complete',
          requestHash: current.requestHash,
          receipt: cloneReceipt(receipt),
        } as unknown as JsonObject);
        const acknowledgement = await this.#persistence.storeIfSequence(
          name,
          loaded.sequence,
          encodeStateAsUpdate(loaded.document),
        );
        if (acknowledgement !== undefined) {
          return;
        }
      }
    });
  }

  public async abort(scope: IdempotencyScope, leaseId: string, error: unknown): Promise<void> {
    // A durable observer cannot receive the originating process's error, but
    // retaining it in the port keeps this implementation substitutable.
    void error;
    const name = ledgerName(scope);
    await this.#mutex.run(name, async () => {
      for (;;) {
        const loaded = await this.#load(name);
        const map = loaded.document.getMap<JsonObject>(LEDGER_MAP);
        const current = decodeStored(map.get(ENTRY_KEY));
        if (current?.state !== 'pending' || current.leaseId !== leaseId) {
          return;
        }
        map.delete(ENTRY_KEY);
        const acknowledgement = await this.#persistence.storeIfSequence(
          name,
          loaded.sequence,
          encodeStateAsUpdate(loaded.document),
        );
        if (acknowledgement !== undefined) {
          return;
        }
      }
    });
  }

  async #load(name: string): Promise<LoadedLedger> {
    const document = new Doc();
    const snapshot = await this.#persistence.load(name);
    if (snapshot !== undefined) {
      applyUpdate(document, snapshot.update);
    }
    return {
      document,
      sequence: snapshot?.sequence,
    };
  }

  async #observePending(
    name: string,
    requestHash: string,
    leaseId: string,
    leaseExpiresAt: number,
  ): Promise<IdempotencyReceipt> {
    const logicalRemaining = leaseExpiresAt - this.#now().getTime();
    const wallExpiresAt =
      Date.now() + Math.max(0, Math.min(this.#pendingLeaseMs, logicalRemaining));

    for (;;) {
      const loaded = await this.#load(name);
      const current = decodeStored(loaded.document.getMap<JsonObject>(LEDGER_MAP).get(ENTRY_KEY));
      if (current?.state === 'complete' && current.requestHash === requestHash) {
        return cloneReceipt(current.receipt);
      }
      if (
        current?.state !== 'pending' ||
        current.requestHash !== requestHash ||
        current.leaseId !== leaseId
      ) {
        throw new Error('Durable idempotency lease ended without a receipt');
      }

      const remaining = Math.min(
        leaseExpiresAt - this.#now().getTime(),
        wallExpiresAt - Date.now(),
      );
      if (!Number.isFinite(remaining) || remaining <= 0) {
        throw new Error('Durable idempotency lease expired before completion');
      }
      await delay(Math.max(1, Math.min(this.#pollIntervalMs, Math.ceil(remaining))));
    }
  }
}
