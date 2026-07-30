import { useEffect, useMemo, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { HocuspocusProvider } from '@hocuspocus/provider';

import { editorExtensions } from './extensions';
import type { ChangeMetadata, DocumentIdentity, DocumentSession } from './types';

const humanHeaders = {
  authorization: 'Bearer demo-human',
  'content-type': 'application/json',
};

interface ReviewEdit {
  readonly id: string;
  readonly changeId: string;
  readonly changeIds: readonly string[];
  readonly operation: ChangeMetadata['operation'];
}

interface ReviewGroup {
  readonly id: string;
  readonly name: string;
  readonly authorId: string;
  readonly createdAt: string;
  readonly edits: readonly ReviewEdit[];
}

interface EditPreview {
  readonly before?: string;
  readonly after?: string;
  readonly label: string;
}

function identityFromLocation(): DocumentIdentity | undefined {
  const match = /^\/documents\/([^/]+)$/u.exec(window.location.pathname);
  const incarnation = new URLSearchParams(window.location.search).get('incarnation');
  if (match?.[1] === undefined || incarnation === null) return undefined;
  return {
    tenantId: 'demo',
    documentId: decodeURIComponent(match[1]),
    documentIncarnation: incarnation,
    collaborationField: 'default',
    schemaId: 'editor-mcp/mvp',
    schemaVersion: 1,
  };
}

async function loadSession(identity: DocumentIdentity): Promise<DocumentSession> {
  const response = await fetch(
    `/api/documents/${encodeURIComponent(identity.documentId)}/session?incarnation=${encodeURIComponent(identity.documentIncarnation)}`,
  );
  if (!response.ok) throw new Error('This document could not be opened.');
  return (await response.json()) as DocumentSession;
}

function Toolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  return (
    <div className="toolbar" role="toolbar" aria-label="Document formatting">
      <button
        className={editor.isActive('bold') ? 'active' : ''}
        onClick={() => editor.chain().focus().toggleBold().run()}
        type="button"
      >
        Bold
      </button>
      <button
        className={editor.isActive('italic') ? 'active' : ''}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        type="button"
      >
        Italic
      </button>
      <span className="toolbar-divider" />
      <button
        className={editor.isActive('heading', { level: 2 }) ? 'active' : ''}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        type="button"
      >
        Heading
      </button>
      <button
        className={editor.isActive('bulletList') ? 'active' : ''}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        type="button"
      >
        List
      </button>
    </div>
  );
}

function pendingReviewGroups(changes: readonly ChangeMetadata[]): readonly ReviewGroup[] {
  const groups = new Map<
    string,
    {
      name: string;
      authorId: string;
      createdAt: string;
      edits: Map<string, ChangeMetadata[]>;
    }
  >();

  for (const change of changes.filter(({ status }) => status === 'pending')) {
    const groupId = change.suggestionGroupId ?? change.id;
    const group = groups.get(groupId) ?? {
      name: change.suggestionGroupName ?? 'Suggested edits',
      authorId: change.authorId,
      createdAt: change.createdAt,
      edits: new Map<string, ChangeMetadata[]>(),
    };
    const editId = change.groupId ?? change.id;
    group.edits.set(editId, [...(group.edits.get(editId) ?? []), change]);
    groups.set(groupId, group);
  }

  return [...groups.entries()]
    .map(([id, group]): ReviewGroup => ({
      id,
      name: group.name,
      authorId: group.authorId,
      createdAt: group.createdAt,
      edits: [...group.edits.entries()].map(([editId, records]) => {
        const first = records[0];
        if (first === undefined) throw new Error('A review edit must contain a change');
        return {
          id: editId,
          changeId: first.id,
          changeIds: records.map(({ id: changeId }) => changeId),
          operation: first.operation,
        };
      }),
    }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function clippedText(element: HTMLElement): string | undefined {
  const value = element.innerText.replaceAll(/\s+/gu, ' ').trim();
  if (value.length === 0) return undefined;
  return value;
}

function combinedPreview(elements: readonly HTMLElement[]): string | undefined {
  const values = elements.map(clippedText).filter((value) => value !== undefined);
  const combined = [...new Set(values)].join(' · ');
  if (combined.length === 0) return undefined;
  return combined.length > 150 ? `${combined.slice(0, 147)}…` : combined;
}

function editPreview(
  changeIds: readonly string[],
  operation: ReviewEdit['operation'],
): EditPreview {
  const selected = new Set(changeIds);
  const elements = [...document.querySelectorAll<HTMLElement>('[data-diff-change-id]')].filter(
    (element) => selected.has(element.dataset['diffChangeId'] ?? ''),
  );
  const before = combinedPreview(
    elements.filter((element) => element.dataset['diffChangeKind'] === 'delete'),
  );
  const after = combinedPreview(
    elements.filter((element) => element.dataset['diffChangeKind'] !== 'delete'),
  );
  const labels: Record<ReviewEdit['operation'], string> = {
    delete: 'Remove content',
    format: 'Change formatting',
    insert: 'Add content',
    replace: 'Replace content',
    structure: 'Change table structure',
  };
  return {
    label: labels[operation],
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

function navigateToEdit(changeIds: readonly string[]): void {
  const selected = new Set(changeIds);
  const target = [...document.querySelectorAll<HTMLElement>('[data-diff-change-id]')].find(
    (element) => selected.has(element.dataset['diffChangeId'] ?? ''),
  );
  if (target === undefined) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.animate(
    [
      { boxShadow: '0 0 0 5px rgba(234, 185, 106, 0.72)' },
      { boxShadow: '0 0 0 5px rgba(234, 185, 106, 0)' },
    ],
    { duration: 1600, easing: 'ease-out' },
  );
}

function ReviewQueue({
  changes,
  documentVersion,
  busyTarget,
  onResolve,
}: {
  readonly changes: readonly ChangeMetadata[];
  readonly documentVersion: number;
  readonly busyTarget: string | undefined;
  readonly onResolve: (
    changeIds: readonly string[],
    decision: 'accept' | 'reject',
    target: string,
  ) => Promise<void>;
}) {
  const groups = useMemo(() => pendingReviewGroups(changes), [changes]);
  const editCount = groups.reduce((count, group) => count + group.edits.length, 0);
  // Reading the version makes live editor transactions invalidate DOM-derived previews.
  void documentVersion;

  return (
    <aside className="review-panel" aria-label="Human review">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Human review</p>
          <h2>Suggestions</h2>
        </div>
        <span className="count-badge">{editCount}</span>
      </div>
      {groups.length === 0 ? (
        <div className="empty-review">
          <div className="empty-check">✓</div>
          <strong>All caught up</strong>
          <p>New suggestions from your agent will appear here.</p>
        </div>
      ) : (
        <div className="suggestion-groups">
          {groups.map((group) => {
            const groupChangeIds = group.edits.map(({ changeId }) => changeId);
            return (
              <section className="suggestion-group" key={group.id}>
                <header className="group-heading">
                  <div>
                    <span className="group-kicker">Agent suggestion</span>
                    <h3>{group.name}</h3>
                    <p>
                      {group.edits.length} {group.edits.length === 1 ? 'edit' : 'edits'} ·{' '}
                      {group.authorId}
                    </p>
                  </div>
                  <time>
                    {new Date(group.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </header>
                <div className="group-actions">
                  <button
                    className="accept-button"
                    disabled={busyTarget !== undefined}
                    onClick={() => void onResolve(groupChangeIds, 'accept', `group:${group.id}`)}
                    type="button"
                  >
                    Accept all
                  </button>
                  <button
                    className="reject-button"
                    disabled={busyTarget !== undefined}
                    onClick={() => void onResolve(groupChangeIds, 'reject', `group:${group.id}`)}
                    type="button"
                  >
                    Reject all
                  </button>
                </div>
                <div className="edit-list">
                  {group.edits.map((edit, index) => {
                    const preview = editPreview(edit.changeIds, edit.operation);
                    return (
                      <article className="edit-card" key={edit.id}>
                        <button
                          className="edit-preview"
                          onClick={() => {
                            navigateToEdit(edit.changeIds);
                          }}
                          type="button"
                        >
                          <span className="edit-number">Edit {index + 1}</span>
                          <strong>{preview.label}</strong>
                          {preview.before === undefined ? null : (
                            <span className="preview-before">− {preview.before}</span>
                          )}
                          {preview.after === undefined ? null : (
                            <span className="preview-after">+ {preview.after}</span>
                          )}
                          <span className="jump-link">View in document →</span>
                        </button>
                        <div className="edit-actions">
                          <button
                            className="accept-link"
                            disabled={busyTarget !== undefined}
                            onClick={() =>
                              void onResolve([edit.changeId], 'accept', `edit:${edit.id}`)
                            }
                            type="button"
                          >
                            Accept
                          </button>
                          <button
                            className="reject-link"
                            disabled={busyTarget !== undefined}
                            onClick={() =>
                              void onResolve([edit.changeId], 'reject', `edit:${edit.id}`)
                            }
                            type="button"
                          >
                            Reject
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </aside>
  );
}

function CollaborativeDocument({ session }: { readonly session: DocumentSession }) {
  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: session.collaborationUrl,
        name: session.documentName,
      }),
    [session.collaborationUrl, session.documentName],
  );
  const [connection, setConnection] = useState('connecting');
  const [changes, setChanges] = useState<readonly ChangeMetadata[]>([]);
  const [busyTarget, setBusyTarget] = useState<string>();
  const [reviewError, setReviewError] = useState<string>();
  const [documentVersion, setDocumentVersion] = useState(0);
  const editor = useEditor(
    {
      extensions: editorExtensions(provider.document, session.identity.collaborationField),
      editorProps: {
        attributes: {
          class: 'document-content',
          'aria-label': 'Collaborative document editor',
        },
      },
      onUpdate: () => {
        setDocumentVersion((version) => version + 1);
      },
    },
    [provider],
  );

  useEffect(() => {
    const map = provider.document.getMap<ChangeMetadata>('diffChanges');
    const refresh = () => {
      setChanges(
        [...map.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      );
      window.requestAnimationFrame(() => {
        setDocumentVersion((version) => version + 1);
      });
    };
    const onStatus = ({ status }: { status: string }) => {
      setConnection(status);
    };
    map.observe(refresh);
    provider.on('status', onStatus);
    provider.on('synced', refresh);
    refresh();
    return () => {
      map.unobserve(refresh);
      provider.off('status', onStatus);
      provider.off('synced', refresh);
      provider.destroy();
    };
  }, [provider]);

  const resolve = async (
    changeIds: readonly string[],
    decision: 'accept' | 'reject',
    target: string,
  ) => {
    setBusyTarget(target);
    setReviewError(undefined);
    try {
      const identity = session.identity;
      const query = new URLSearchParams({
        documentIncarnation: identity.documentIncarnation,
        collaborationField: identity.collaborationField,
        schemaId: identity.schemaId,
        schemaVersion: String(identity.schemaVersion),
        representationProfile: 'agent-html/v1',
      });
      const readResponse = await fetch(
        `/v1/documents/${encodeURIComponent(identity.documentId)}?${query.toString()}`,
        { headers: { authorization: humanHeaders.authorization } },
      );
      if (!readResponse.ok) throw new Error('The latest document revision could not be read.');
      const read = (await readResponse.json()) as { revision: string };
      const response = await fetch(
        `/v1/documents/${encodeURIComponent(identity.documentId)}:applyEdits`,
        {
          method: 'POST',
          headers: humanHeaders,
          body: JSON.stringify({
            protocolVersion: 1,
            ...identity,
            idempotencyKey: `review-${crypto.randomUUID()}`,
            readRevision: read.revision,
            atomic: true,
            changeMode: 'direct',
            operations: changeIds.map((changeId) => ({
              operationId: `review-${crypto.randomUUID()}`,
              kind: decision === 'accept' ? 'accept_change' : 'reject_change',
              changeId,
            })),
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'The review decision could not be applied.');
      }
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Review failed.');
    } finally {
      setBusyTarget(undefined);
    }
  };

  return (
    <div className="document-workspace">
      <main className="editor-shell">
        <header className="document-header">
          <div>
            <p className="eyebrow">Shared document</p>
            <h1>Collaborative working document</h1>
          </div>
          <div className={`connection-status ${connection}`}>
            <span />
            {connection === 'connected' ? 'Live & saved' : connection}
          </div>
        </header>
        <Toolbar editor={editor} />
        <div className="paper">
          <EditorContent editor={editor} />
        </div>
        {reviewError === undefined ? null : <div className="error-banner">{reviewError}</div>}
      </main>
      <ReviewQueue
        busyTarget={busyTarget}
        changes={changes}
        documentVersion={documentVersion}
        onResolve={resolve}
      />
    </div>
  );
}

function ProductHeader() {
  return (
    <header className="product-header">
      <div className="product-brand">
        <span className="brand-mark">E</span>
        <div>
          <strong>Editor MCP</strong>
          <span>Bring your own agent</span>
        </div>
      </div>
      <div className="agent-endpoint">
        <span>Agent endpoint</span>
        <code>{window.location.origin}/mcp</code>
      </div>
    </header>
  );
}

export function App() {
  const [session, setSession] = useState<DocumentSession>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    const identity = identityFromLocation();
    if (identity === undefined) return;
    setLoading(true);
    void loadSession(identity)
      .then(setSession)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'The document could not be opened.');
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return (
    <div className="app-shell">
      <ProductHeader />
      {loading ? (
        <main className="welcome-canvas">
          <div className="loading-card">Opening the live document…</div>
        </main>
      ) : loadError === undefined ? (
        session === undefined ? (
          <main className="welcome-canvas">
            <div className="welcome-card">
              <span className="live-pill">
                <i /> Ready for your agent
              </span>
              <h1>Start the document from the agent you already use.</h1>
              <p>
                Connect Codex, Claude, or any MCP client to the endpoint above. Your agent creates
                the document, proposes named groups of edits, and returns the shared URL.
              </p>
              <ol className="agent-steps">
                <li>
                  <span>1</span>Connect your MCP client
                </li>
                <li>
                  <span>2</span>Ask it to create and edit a document
                </li>
                <li>
                  <span>3</span>Open the returned URL and review together
                </li>
              </ol>
            </div>
          </main>
        ) : (
          <CollaborativeDocument key={session.documentName} session={session} />
        )
      ) : (
        <main className="welcome-canvas">
          <div className="error-banner">{loadError}</div>
        </main>
      )}
    </div>
  );
}
