import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  findFixture,
  fixtureCatalog,
  fixtureUrl,
  planCoverage,
  selectFixtures,
  type FixtureDefinition,
  type FixtureMark,
  type FixtureNode,
  type FixtureSelection,
  type FixtureState,
} from '@editor-mcp/fixtures';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function attrs(node: FixtureNode): string {
  const pairs: [string, unknown][] = [
    ['data-block-id', node.attrs?.['blockId']],
    ['data-diff-change-id', node.attrs?.['diffChangeId']],
    ['data-diff-change-kind', node.attrs?.['diffChangeKind']],
  ];
  return pairs
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('');
}

function renderMarks(text: string, marks: readonly FixtureMark[]): string {
  return marks.reduce((content, mark) => {
    switch (mark.type) {
      case 'bold':
        return `<strong>${content}</strong>`;
      case 'italic':
        return `<em>${content}</em>`;
      case 'strike':
        return `<s>${content}</s>`;
      case 'code':
        return `<code>${content}</code>`;
      case 'link': {
        const href =
          typeof mark.attrs?.['href'] === 'string' ? escapeHtml(mark.attrs['href']) : '#';
        return `<a href="${href}">${content}</a>`;
      }
      case 'diffChange': {
        const changeId =
          typeof mark.attrs?.['changeId'] === 'string' ? escapeHtml(mark.attrs['changeId']) : '';
        const kind = typeof mark.attrs?.['kind'] === 'string' ? escapeHtml(mark.attrs['kind']) : '';
        return `<span data-diff-change-id="${changeId}" data-diff-change-kind="${kind}">${content}</span>`;
      }
      default:
        return content;
    }
  }, escapeHtml(text));
}

function renderChildren(node: FixtureNode): string {
  return (node.content ?? []).map(renderNode).join('');
}

export function renderNode(node: FixtureNode): string {
  if (node.type === 'text') {
    return renderMarks(node.text ?? '', node.marks ?? []);
  }
  const children = renderChildren(node);
  const attributes = attrs(node);
  switch (node.type) {
    case 'doc':
      return children;
    case 'paragraph':
      return `<p${attributes}>${children}</p>`;
    case 'heading': {
      const level =
        typeof node.attrs?.['level'] === 'number'
          ? Math.min(6, Math.max(1, node.attrs['level']))
          : 1;
      return `<h${String(level)}${attributes}>${children}</h${String(level)}>`;
    }
    case 'blockquote':
      return `<blockquote${attributes}>${children}</blockquote>`;
    case 'bulletList':
      return `<ul${attributes}>${children}</ul>`;
    case 'orderedList': {
      const start =
        typeof node.attrs?.['start'] === 'number' ? ` start="${String(node.attrs['start'])}"` : '';
      return `<ol${attributes}${start}>${children}</ol>`;
    }
    case 'listItem':
      return `<li${attributes}>${children}</li>`;
    case 'codeBlock':
      return `<pre${attributes}><code>${children}</code></pre>`;
    case 'horizontalRule':
      return `<hr${attributes}>`;
    case 'hardBreak':
      return '<br>';
    case 'table':
      return `<table${attributes}><tbody>${children}</tbody></table>`;
    case 'tableRow':
      return `<tr${attributes}>${children}</tr>`;
    case 'tableHeader':
      return `<th${attributes}>${children}</th>`;
    case 'tableCell':
      return `<td${attributes}>${children}</td>`;
    default:
      return `<div data-unsupported-node="${escapeHtml(node.type)}">${children}</div>`;
  }
}

function statePanel(
  name: 'accepted' | 'before' | 'proposed' | 'rejected',
  state: FixtureState,
): string {
  const canonicalJson = JSON.stringify(state.document, null, 2);
  const trackingJson = JSON.stringify(state.diffChanges, null, 2);
  return `<section class="state" data-state="${name}">
    <h2>${name}</h2>
    <article class="editor" data-editor-state="${name}" aria-label="${name} editor">${renderNode(state.document)}</article>
    <details><summary>Canonical JSON</summary><pre data-canonical-json="${name}">${escapeHtml(canonicalJson)}</pre></details>
    <details><summary>Tracking metadata</summary><pre data-tracking-metadata="${name}">${escapeHtml(trackingJson)}</pre></details>
  </section>`;
}

const STYLES = `
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172033; background: #f5f7fb; }
body { margin: 0; padding: 1.5rem; }
header { display: grid; gap: .5rem; margin-bottom: 1rem; }
.meta { display: flex; flex-wrap: wrap; gap: .5rem; color: #526078; }
.meta span, .status { border: 1px solid #ced5e1; border-radius: 999px; padding: .2rem .6rem; background: white; }
.matrix { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.state { min-width: 0; border: 1px solid #d8deea; border-radius: .75rem; background: white; padding: 1rem; box-shadow: 0 2px 10px #1720330d; }
.state h2 { margin-top: 0; text-transform: capitalize; }
.editor { min-height: 8rem; padding: 1rem; border: 1px solid #e0e5ee; border-radius: .5rem; overflow: auto; }
[data-diff-change-kind="insert"] { color: #116329; text-decoration: underline; text-decoration-color: #1a7f37; }
[data-diff-change-kind="delete"] { color: #a40e26; text-decoration: line-through; text-decoration-color: #cf222e; }
[data-diff-change-kind="modify"] { border-left: .25rem solid #bf8700; padding-left: .5rem; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f6f8fa; border-radius: .4rem; padding: .75rem; }
table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #d0d7de; padding: .4rem; }
.assertions li::marker { color: #1a7f37; }
@media (max-width: 850px) { .matrix { grid-template-columns: 1fr; } }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLES}</style></head><body>${body}</body></html>`;
}

export function renderFixturePage(fixture: FixtureDefinition): string {
  const states = fixture.expected.states;
  const assertions = fixture.invariants
    .map(
      (invariant) =>
        `<li data-assertion="${escapeHtml(invariant.id)}">${escapeHtml(invariant.description)}</li>`,
    )
    .join('');
  return page(
    fixture.title,
    `<header>
      <a href="/fixtures">← All fixtures</a>
      <h1>${escapeHtml(fixture.title)}</h1>
      <p>${escapeHtml(fixture.description)}</p>
      <div class="meta"><span>fixture ${escapeHtml(fixture.id)}</span><span>seed ${String(fixture.seed)}</span><span>schema ${escapeHtml(fixture.schema.id)}@${String(fixture.schema.version)}</span><span>${escapeHtml(fixture.request.changeMode)}</span></div>
      <details><summary>Semantic operation</summary><pre>${escapeHtml(JSON.stringify(fixture.request, null, 2))}</pre></details>
      <div class="status">Automated assertions: ${String(fixture.invariants.length)} configured</div>
      <ul class="assertions">${assertions}</ul>
    </header>
    <main class="matrix">
      ${statePanel('before', states.before)}
      ${statePanel('proposed', states.proposed)}
      ${statePanel('accepted', states.accepted)}
      ${statePanel('rejected', states.rejected)}
    </main>`,
  );
}

export function renderFixtureIndex(selection: FixtureSelection = {}): string {
  const fixtures = selectFixtures(fixtureCatalog, selection);
  const items = fixtures
    .map(
      (fixture) =>
        `<li data-fixture-id="${escapeHtml(fixture.id)}"><a href="${escapeHtml(fixtureUrl(fixture))}">${escapeHtml(fixture.title)}</a> <small>${escapeHtml(fixture.request.operations.map(({ kind }) => kind).join(', '))} · ${escapeHtml(fixture.tags.join(', '))}</small></li>`,
    )
    .join('');
  return page(
    'Editor MCP fixture browser',
    `<header><h1>Editor MCP fixture browser</h1><p>${String(fixtures.length)} deterministic fixtures</p><p><a href="/coverage">View scratch-plan coverage</a></p></header><main><ul>${items}</ul></main>`,
  );
}

export function renderPlanCoveragePage(): string {
  const rows = planCoverage
    .map((entry) => {
      const links = entry.fixtureIds
        .map((fixtureId) => {
          const fixture = findFixture(fixtureCatalog, fixtureId);
          return fixture === undefined
            ? escapeHtml(fixtureId)
            : `<a href="${escapeHtml(fixtureUrl(fixture))}">${escapeHtml(fixtureId)}</a>`;
        })
        .join(', ');
      return `<tr data-coverage-id="${escapeHtml(entry.id)}"><td>${escapeHtml(entry.case)}</td><td>${escapeHtml(entry.status)}</td><td>${links || '—'}</td><td>${escapeHtml(entry.note)}</td></tr>`;
    })
    .join('');
  return page(
    'Scratch-plan coverage',
    `<header><a href="/fixtures">← Fixture browser</a><h1>Scratch-plan coverage</h1><p>Each row is either an executable fixture or an explicit certified contract test.</p></header><main><table><thead><tr><th>Case</th><th>Status</th><th>Fixture(s)</th><th>Contract</th></tr></thead><tbody>${rows}</tbody></table></main>`,
  );
}

function selectionFrom(url: URL): FixtureSelection {
  const tags = url.searchParams.getAll('tag');
  const nodeTypes = url.searchParams.getAll('nodeType');
  const operationKinds = url.searchParams.getAll('operation');
  const selection: {
    tags?: readonly string[];
    nodeTypes?: readonly string[];
    operationKinds?: NonNullable<FixtureSelection['operationKinds']>;
  } = {};
  if (tags.length > 0) {
    selection.tags = tags;
  }
  if (nodeTypes.length > 0) {
    selection.nodeTypes = nodeTypes;
  }
  if (operationKinds.length > 0) {
    selection.operationKinds = operationKinds as unknown as NonNullable<
      FixtureSelection['operationKinds']
    >;
  }
  return selection;
}

export function createVisualHarnessHandler(): (
  request: IncomingMessage,
  response: ServerResponse,
) => void {
  return (request, response): void => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    let body: string;
    let status = 200;
    if (request.method !== 'GET') {
      status = 405;
      body = page('Method not allowed', '<h1>Method not allowed</h1>');
    } else if (url.pathname === '/coverage') {
      body = renderPlanCoveragePage();
    } else if (url.pathname === '/' || url.pathname === '/fixtures') {
      body = renderFixtureIndex(selectionFrom(url));
    } else if (url.pathname.startsWith('/fixtures/')) {
      let id: string | undefined;
      try {
        id = decodeURIComponent(url.pathname.slice('/fixtures/'.length));
      } catch {
        id = undefined;
      }
      const fixture = id === undefined ? undefined : findFixture(fixtureCatalog, id);
      if (fixture === undefined) {
        status = 404;
        body = page('Fixture not found', '<h1>Fixture not found</h1>');
      } else if (
        url.searchParams.get('seed') !== null &&
        url.searchParams.get('seed') !== String(fixture.seed)
      ) {
        status = 400;
        body = page('Fixture seed mismatch', '<h1>Fixture seed does not match the catalog</h1>');
      } else {
        body = renderFixturePage(fixture);
      }
    } else {
      status = 404;
      body = page('Not found', '<h1>Not found</h1>');
    }
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
  };
}
