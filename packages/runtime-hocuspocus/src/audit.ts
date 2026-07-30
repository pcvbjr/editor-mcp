import { createHash } from 'node:crypto';

import type { AuditEnvelope, AuditSink } from '@editor-mcp/core';
import { Doc, applyUpdate, encodeStateAsUpdate } from 'yjs';

import type { JsonObject, YjsPersistence } from './index.js';

const AUDIT_MAP = 'editorMcpAudit';

export interface DurableYjsAuditSinkOptions {
  readonly persistence: YjsPersistence;
}

export interface AuditEventReference {
  readonly document: AuditEnvelope['document'];
  readonly auditEventId: string;
}

function documentIdentityParts(document: AuditEnvelope['document']): readonly (number | string)[] {
  return [
    document.tenantId,
    document.documentId,
    document.documentIncarnation,
    document.collaborationField,
    document.schemaId,
    document.schemaVersion,
  ];
}

function auditName(event: AuditEventReference): string {
  const scope = JSON.stringify([...documentIdentityParts(event.document), event.auditEventId]);
  return `editor-mcp-audit.${createHash('sha256').update(scope).digest('base64url')}`;
}

function sameDocumentIdentity(
  left: AuditEnvelope['document'],
  right: AuditEnvelope['document'],
): boolean {
  return (
    JSON.stringify(documentIdentityParts(left)) === JSON.stringify(documentIdentityParts(right))
  );
}

export class DurableYjsAuditSink implements AuditSink {
  readonly #persistence: YjsPersistence;

  public constructor(options: DurableYjsAuditSinkOptions) {
    this.#persistence = options.persistence;
  }

  public async append(event: AuditEnvelope): Promise<void> {
    const name = auditName(event);
    for (;;) {
      const existing = await this.#persistence.load(name);
      const document = new Doc();
      if (existing !== undefined) {
        applyUpdate(document, existing.update);
      }
      const map = document.getMap<JsonObject>(AUDIT_MAP);
      const current = map.get(event.auditEventId);
      if (current !== undefined) {
        if (JSON.stringify(current) !== JSON.stringify(event)) {
          throw new Error('Audit event ID was reused with different content');
        }
        return;
      }
      map.set(event.auditEventId, structuredClone(event) as unknown as JsonObject);
      const stored = await this.#persistence.storeIfSequence(
        name,
        existing?.sequence,
        encodeStateAsUpdate(document),
      );
      if (stored !== undefined) {
        return;
      }
    }
  }

  public async read(event: AuditEventReference): Promise<AuditEnvelope | undefined> {
    const name = auditName(event);
    const snapshot = await this.#persistence.load(name);
    if (snapshot === undefined) {
      return undefined;
    }
    const document = new Doc();
    applyUpdate(document, snapshot.update);
    const value = document.getMap<JsonObject>(AUDIT_MAP).get(event.auditEventId);
    if (value === undefined) {
      return undefined;
    }
    const stored = structuredClone(value) as unknown as AuditEnvelope;
    if (
      stored.auditEventId !== event.auditEventId ||
      !sameDocumentIdentity(stored.document, event.document)
    ) {
      throw new Error('Stored audit event does not match the requested document identity');
    }
    return stored;
  }
}
