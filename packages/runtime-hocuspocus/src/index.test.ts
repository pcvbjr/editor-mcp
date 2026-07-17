import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { XmlFragment, applyUpdate, encodeStateAsUpdate } from 'yjs';

import {
  COLLABORATION_STATE_MAP,
  HocuspocusRuntime,
  MemoryYjsPersistence,
  ProseMirrorYjsDocumentCodec,
  RuntimeCancellationError,
  RuntimeConflictError,
  RuntimePersistenceError,
  documentNameFor,
  type RuntimeDocumentIdentity,
} from './index.js';

const identity: RuntimeDocumentIdentity = {
  tenantId: 'tenant-a',
  documentId: 'doc-a',
  documentIncarnation: 'inc-1',
  collaborationField: 'default',
  schemaId: 'editor-mcp/mvp',
  schemaVersion: 1,
};

const initial = {
  type: 'doc',
  content: [{ type: 'paragraph', attrs: { blockId: 'block-a' } }],
};

const proseMirrorSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: { blockId: { default: null } },
    },
    text: { group: 'inline' },
  },
});

describe('document identity isolation', () => {
  it('includes tenant, incarnation, field, and schema in the runtime name', () => {
    const base = documentNameFor(identity);
    expect(documentNameFor({ ...identity, tenantId: 'tenant-b' })).not.toBe(base);
    expect(documentNameFor({ ...identity, documentIncarnation: 'inc-2' })).not.toBe(base);
    expect(documentNameFor({ ...identity, collaborationField: 'other' })).not.toBe(base);
    expect(documentNameFor({ ...identity, schemaVersion: 2 })).not.toBe(base);
  });
});

describe('authoritative Hocuspocus lifecycle', () => {
  it('commits atomically and reloads the acknowledged state', async () => {
    const persistence = new MemoryYjsPersistence();
    const runtime = new HocuspocusRuntime({ persistence });
    await runtime.seed(identity, initial);
    const before = await runtime.read(identity);
    expect(before?.document).toEqual(initial);

    const commit = await runtime.mutate(
      identity,
      before?.revision ?? '',
      { kind: 'agent', actorId: 'agent-a', traceId: 'trace-a' },
      (state) => ({
        document: {
          ...state.document,
          title: 'persisted',
        },
        changes: {
          changeA: {
            id: 'changeA',
            status: 'pending',
          },
        },
        result: 'ok',
      }),
    );

    expect(commit.result).toBe('ok');
    expect(commit.acknowledgement.level).toBe('snapshot');
    await runtime.unload(identity);
    const reloaded = await runtime.read(identity);
    expect(reloaded?.document).toMatchObject({ title: 'persisted' });
    expect(reloaded?.changes).toHaveProperty('changeA');
  });

  it('rejects a stale revision without calling the mutation plan', async () => {
    const persistence = new MemoryYjsPersistence();
    const runtime = new HocuspocusRuntime({ persistence });
    await runtime.seed(identity, initial);
    let planned = false;
    await expect(
      runtime.mutate(
        identity,
        'sha256:stale',
        { kind: 'agent', actorId: 'agent-a', traceId: 'trace-a' },
        (state) => {
          planned = true;
          return {
            document: state.document,
            changes: state.changes,
            result: undefined,
          };
        },
      ),
    ).rejects.toBeInstanceOf(RuntimeConflictError);
    expect(planned).toBe(false);
  });

  it('rolls semantic state back when durable persistence fails', async () => {
    const persistence = new MemoryYjsPersistence();
    const runtime = new HocuspocusRuntime({ persistence });
    await runtime.seed(identity, initial);
    const before = await runtime.read(identity);
    persistence.failNextStore();

    await expect(
      runtime.mutate(
        identity,
        before?.revision ?? '',
        { kind: 'agent', actorId: 'agent-a', traceId: 'trace-a' },
        (state) => ({
          document: { ...state.document, leaked: true },
          changes: state.changes,
          result: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(RuntimePersistenceError);

    await runtime.unload(identity);
    expect((await runtime.read(identity))?.document).toEqual(initial);
  });

  it('honors cancellation after planning starts and before the durable commit', async () => {
    const persistence = new MemoryYjsPersistence();
    const runtime = new HocuspocusRuntime({ persistence });
    await runtime.seed(identity, initial);
    const before = await runtime.read(identity);
    const controller = new AbortController();
    let releasePlan: (() => void) | undefined;
    const planPaused = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });
    let planStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      planStarted = resolve;
    });

    const mutation = runtime.mutate(
      identity,
      before?.revision ?? '',
      { kind: 'agent', actorId: 'agent-a', traceId: 'trace-a' },
      async (state) => {
        planStarted?.();
        await planPaused;
        return {
          document: { ...state.document, leaked: true },
          changes: state.changes,
          result: undefined,
        };
      },
      { signal: controller.signal },
    );
    await started;
    controller.abort();
    releasePlan?.();

    await expect(mutation).rejects.toBeInstanceOf(RuntimeCancellationError);
    await runtime.unload(identity);
    expect((await runtime.read(identity))?.document).toEqual(initial);
  });

  it('produces convergent Yjs replicas including collaborative metadata', async () => {
    const persistence = new MemoryYjsPersistence();
    const runtime = new HocuspocusRuntime({ persistence });
    await runtime.seed(identity, initial, {
      changeA: { id: 'changeA', status: 'pending' },
    });
    const first = await runtime.replica(identity);
    const second = await runtime.replica(identity);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) {
      throw new Error('Expected both replicas to exist');
    }
    applyUpdate(second, encodeStateAsUpdate(first));
    expect(second.getMap(COLLABORATION_STATE_MAP).get('document')).toEqual(
      first.getMap(COLLABORATION_STATE_MAP).get('document'),
    );
    expect(encodeStateAsUpdate(second)).toEqual(encodeStateAsUpdate(first));
  });

  it('synchronizes two live clients and persists a human update', async () => {
    const persistence = new MemoryYjsPersistence();
    const runtime = new HocuspocusRuntime({ persistence });
    await runtime.seed(identity, initial);
    const first = await runtime.connectReplica(identity, {
      kind: 'human',
      actorId: 'human-a',
      traceId: 'trace-client-a',
    });
    const second = await runtime.connectReplica(identity, {
      kind: 'human',
      actorId: 'human-b',
      traceId: 'trace-client-b',
    });
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    first?.document
      .getMap(COLLABORATION_STATE_MAP)
      .set('document', { ...initial, editedBy: 'human-a' });
    await first?.flush();

    expect(second?.document.getMap(COLLABORATION_STATE_MAP).get('document')).toMatchObject({
      editedBy: 'human-a',
    });

    await first?.disconnect();
    await second?.disconnect();
    await runtime.unload(identity);
    expect((await runtime.read(identity))?.document).toMatchObject({
      editedBy: 'human-a',
    });
  });

  it('does not broadcast a replica update before persistence succeeds', async () => {
    const persistence = new MemoryYjsPersistence();
    const runtime = new HocuspocusRuntime({ persistence });
    await runtime.seed(identity, initial);
    const first = await runtime.connectReplica(identity, {
      kind: 'human',
      actorId: 'human-a',
      traceId: 'trace-client-a',
    });
    const second = await runtime.connectReplica(identity, {
      kind: 'human',
      actorId: 'human-b',
      traceId: 'trace-client-b',
    });
    if (first === undefined || second === undefined) {
      throw new Error('Expected both live replicas to exist');
    }

    persistence.failNextStore();
    first.document.getMap(COLLABORATION_STATE_MAP).set('document', { ...initial, leaked: true });
    await expect(first.flush()).rejects.toBeInstanceOf(RuntimePersistenceError);
    expect(second.document.getMap(COLLABORATION_STATE_MAP).get('document')).toEqual(initial);

    await expect(first.disconnect()).rejects.toBeInstanceOf(RuntimePersistenceError);
    await second.disconnect();
    await runtime.unload(identity);
    expect((await runtime.read(identity))?.document).toEqual(initial);
  });

  it('uses the real named Y.XmlFragment as authoritative ProseMirror state', async () => {
    const persistence = new MemoryYjsPersistence();
    const codec = new ProseMirrorYjsDocumentCodec(proseMirrorSchema);
    const runtime = new HocuspocusRuntime({
      persistence,
      documentCodec: codec,
    });
    await runtime.seed(identity, initial);
    const first = await runtime.connectReplica(identity, {
      kind: 'human',
      actorId: 'human-a',
      traceId: 'trace-client-a',
    });
    const second = await runtime.connectReplica(identity, {
      kind: 'human',
      actorId: 'human-b',
      traceId: 'trace-client-b',
    });
    expect(first?.document.getXmlFragment(identity.collaborationField)).toBeInstanceOf(XmlFragment);
    expect(first?.document.getMap(COLLABORATION_STATE_MAP).get('document')).toBeUndefined();

    if (first === undefined || second === undefined) {
      throw new Error('Expected both live replicas to exist');
    }
    codec.replace(first.document, identity, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'block-a' },
          content: [{ type: 'text', text: 'edited collaboratively' }],
        },
      ],
    });
    await first.flush();
    expect(codec.read(second.document, identity)).toMatchObject({
      content: [
        {
          content: [{ text: 'edited collaboratively' }],
        },
      ],
    });
    await first.disconnect();
    await second.disconnect();

    await runtime.unload(identity);
    expect(await runtime.read(identity)).toMatchObject({
      document: {
        content: [
          {
            content: [{ text: 'edited collaboratively' }],
          },
        ],
      },
    });
  });
});
