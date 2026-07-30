import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { HocuspocusProvider } from '@hocuspocus/provider';

import { editorExtensions } from './extensions';
import type { ChangeMetadata, ChatMessage, DocumentIdentity, DocumentSession } from './types';

const humanHeaders = {
  authorization: 'Bearer demo-human',
  'content-type': 'application/json',
};

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

function ReviewQueue({
  changes,
  busyChange,
  onResolve,
}: {
  readonly changes: readonly ChangeMetadata[];
  readonly busyChange: string | undefined;
  readonly onResolve: (changeId: string, decision: 'accept' | 'reject') => Promise<void>;
}) {
  const pending = changes.filter(({ status }) => status === 'pending');
  return (
    <aside className="review-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Human review</p>
          <h2>Suggestions</h2>
        </div>
        <span className="count-badge">{pending.length}</span>
      </div>
      {pending.length === 0 ? (
        <div className="empty-review">
          <div className="empty-check">✓</div>
          <strong>All caught up</strong>
          <p>New agent changes will appear here for your approval.</p>
        </div>
      ) : (
        <div className="change-list">
          {pending.map((change) => (
            <article className="change-card" key={change.id}>
              <div className="change-meta">
                <span className="agent-dot" />
                <span>{change.authorId}</span>
                <time>
                  {new Date(change.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </div>
              <strong>{change.operation} suggestion</strong>
              <p>{change.summary ?? 'Review the highlighted changes in the document.'}</p>
              <div className="review-actions">
                <button
                  className="accept-button"
                  disabled={busyChange === change.id}
                  onClick={() => void onResolve(change.id, 'accept')}
                  type="button"
                >
                  Accept
                </button>
                <button
                  className="reject-button"
                  disabled={busyChange === change.id}
                  onClick={() => void onResolve(change.id, 'reject')}
                  type="button"
                >
                  Reject
                </button>
              </div>
            </article>
          ))}
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
  const [busyChange, setBusyChange] = useState<string>();
  const [reviewError, setReviewError] = useState<string>();
  const editor = useEditor(
    {
      extensions: editorExtensions(provider.document, session.identity.collaborationField),
      editorProps: {
        attributes: {
          class: 'document-content',
          'aria-label': 'Collaborative document editor',
        },
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

  const resolve = async (changeId: string, decision: 'accept' | 'reject') => {
    setBusyChange(changeId);
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
            operations: [
              {
                operationId: `review-${crypto.randomUUID()}`,
                kind: decision === 'accept' ? 'accept_change' : 'reject_change',
                changeId,
              },
            ],
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
      setBusyChange(undefined);
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
      <ReviewQueue changes={changes} busyChange={busyChange} onResolve={resolve} />
    </div>
  );
}

function ChatPanel({
  session,
  onSession,
}: {
  readonly session: DocumentSession | undefined;
  readonly onSession: (session: DocumentSession, editorUrl: string) => void;
}) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([
    {
      id: 'welcome',
      role: 'agent',
      text: 'Tell me what you want to create. I’ll open a shared document and propose the first draft.',
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async (message: string) => {
    const trimmed = message.trim();
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    setInput('');
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', text: trimmed },
    ]);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: trimmed, document: session?.identity }),
      });
      const body = (await response.json()) as {
        message?: string;
        editorUrl?: string;
        session?: DocumentSession;
        error?: { message?: string };
      };
      if (!response.ok || body.session === undefined || body.editorUrl === undefined) {
        throw new Error(body.error?.message ?? 'The demo agent could not complete that request.');
      }
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'agent',
          text: body.message ?? 'I added a tracked suggestion.',
        },
      ]);
      onSession(body.session, body.editorUrl);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'agent',
          text: error instanceof Error ? error.message : 'Something went wrong.',
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send(input);
  };

  return (
    <aside className="chat-panel">
      <header className="brand-header">
        <div className="brand-mark">E</div>
        <div>
          <strong>Editor MCP</strong>
          <span>Agent workspace</span>
        </div>
      </header>
      <div className="chat-intro">
        <p className="eyebrow">Same tools, shared state</p>
        <h1>Write together.</h1>
        <p>The demo agent creates and edits through the MCP. You keep the final say.</p>
      </div>
      <div className="messages" aria-live="polite">
        {messages.map((message) => (
          <div className={`message ${message.role}`} key={message.id}>
            <span>{message.role === 'agent' ? 'Agent' : 'You'}</span>
            <p>{message.text}</p>
          </div>
        ))}
        {sending ? (
          <div className="message agent thinking">
            <span>Agent</span>
            <p>Reading the live document…</p>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
      {session === undefined ? (
        <div className="prompt-chips">
          <button
            onClick={() => void send('Create a one-page launch brief for Editor MCP.')}
            type="button"
          >
            Draft a launch brief
          </button>
          <button
            onClick={() =>
              void send('Create a product requirements document for collaborative agent editing.')
            }
            type="button"
          >
            Start a product spec
          </button>
        </div>
      ) : null}
      <form className="chat-form" onSubmit={submit}>
        <textarea
          aria-label="Message the document agent"
          onChange={(event) => {
            setInput(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(input);
            }
          }}
          placeholder={
            session === undefined ? 'What should we create?' : 'Ask for another revision…'
          }
          rows={3}
          value={input}
        />
        <button disabled={sending || input.trim().length === 0} type="submit">
          Send
        </button>
      </form>
      <footer>
        External agents can connect at <code>/mcp</code>
      </footer>
    </aside>
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

  const selectSession = (nextSession: DocumentSession, editorUrl: string) => {
    setSession(nextSession);
    const url = new URL(editorUrl);
    window.history.pushState({}, '', `${url.pathname}${url.search}`);
  };

  return (
    <div className="app-shell">
      <ChatPanel session={session} onSession={selectSession} />
      {loading ? (
        <main className="welcome-canvas">
          <div className="loading-card">Opening the live document…</div>
        </main>
      ) : loadError === undefined ? (
        session === undefined ? (
          <main className="welcome-canvas">
            <div className="welcome-card">
              <span className="live-pill">
                <i /> Ready for an agent
              </span>
              <h2>A document is one conversation away.</h2>
              <p>
                Start in the chat. The agent will create the document, return its URL, and propose
                the first draft here.
              </p>
              <div className="flow-line">
                <span>Chat request</span>
                <b>→</b>
                <span>MCP tools</span>
                <b>→</b>
                <span>Live Tiptap document</span>
              </div>
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
