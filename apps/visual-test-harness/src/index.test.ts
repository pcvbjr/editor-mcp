import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  fixtureCatalog,
  fixtureCatalogById,
  fixtureUrl,
  type FixtureNode,
} from '@editor-mcp/fixtures';

import {
  createVisualHarnessHandler,
  renderFixtureIndex,
  renderFixturePage,
  renderNode,
  renderPlanCoveragePage,
} from './index.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function requestHarness(
  url: string,
  method = 'GET',
): { readonly body: string; readonly status: number } {
  let status = 0;
  let body = '';
  const response = {
    writeHead: (nextStatus: number): void => {
      status = nextStatus;
    },
    end: (value: string): void => {
      body = value;
    },
  } as unknown as ServerResponse;
  const request = {
    method,
    url,
    headers: { host: 'localhost' },
  } as IncomingMessage;
  createVisualHarnessHandler()(request, response);
  return { body, status };
}

describe('visual fixture harness', () => {
  it('renders four independent, labeled editor states', () => {
    const fixture = fixtureCatalog[0];
    expect(fixture).toBeDefined();
    if (fixture === undefined) {
      return;
    }
    const html = renderFixturePage(fixture);
    expect(html.match(/data-editor-state=/gu)).toHaveLength(4);
    for (const state of ['before', 'proposed', 'accepted', 'rejected']) {
      expect(html).toContain(`data-editor-state="${state}"`);
      expect(html).toContain(`data-state="${state}"`);
    }
    expect(html).toContain(`seed ${String(fixture.seed)}`);
    expect(html).toContain(`schema ${fixture.schema.id}@${String(fixture.schema.version)}`);
  });

  it('renders the paragraph-to-heading proposal as one real tracked replacement', () => {
    const fixture = fixtureCatalogById['replace-block-direct-type-change'];
    expect(fixture).toBeDefined();
    if (fixture === undefined) {
      return;
    }

    const html = renderFixturePage(fixture);
    const proposedStart = html.indexOf('data-editor-state="proposed"');
    const acceptedStart = html.indexOf('data-editor-state="accepted"');
    const proposed = html.slice(proposedStart, acceptedStart);

    expect(fixture.request.changeMode).toBe('suggest');
    expect(proposed).toContain('data-diff-change-kind="delete"');
    expect(proposed).toContain('data-diff-change-kind="insert"');
    expect(fixture.expected.states.proposed.diffChanges).toHaveLength(1);
    expect(proposed.match(/data-diff-change-kind="(?:delete|insert)"/gu) ?? []).toHaveLength(2);
    expect(proposed).toContain('data-block-id="78219323-0ba7-43b6-838f-6da907400891"');
    expect(proposed).not.toContain('Removed by this');
    expect(html).not.toContain('data-visual-diff-kind');
    expect(html).not.toContain('[data-diff-change-kind="insert"] { background:');
    expect(html).not.toContain('[data-diff-change-kind="delete"] { background:');
  });

  it('uses deterministic direct fixture URLs in the index', () => {
    const html = renderFixtureIndex();
    for (const fixture of fixtureCatalog) {
      expect(html).toContain(`href="${fixtureUrl(fixture)}"`);
      expect(html).toContain(`data-fixture-id="${fixture.id}"`);
    }
  });

  it('publishes every scratch-plan coverage row with fixture links or contract status', () => {
    const html = renderPlanCoveragePage();
    expect(html).toContain('Scratch-plan coverage');
    expect(html.match(/data-coverage-id=/gu)).toHaveLength(25);
    expect(html).toContain('contract-test');
    expect(html).toContain('/fixtures/structure-deeply-nested-mixed-lists-direct?seed=430016');
    expect(requestHarness('/coverage').status).toBe(200);
  });

  it('renders exact canonical JSON for every state of every catalog fixture', () => {
    for (const fixture of fixtureCatalog) {
      const html = renderFixturePage(fixture);
      for (const state of ['before', 'proposed', 'accepted', 'rejected'] as const) {
        const canonicalJson = escapeHtml(
          JSON.stringify(fixture.expected.states[state].document, null, 2),
        );
        const trackingJson = escapeHtml(
          JSON.stringify(fixture.expected.states[state].diffChanges, null, 2),
        );
        expect(html).toContain(`data-canonical-json="${state}">${canonicalJson}</pre>`);
        expect(html).toContain(`data-tracking-metadata="${state}">${trackingJson}</pre>`);
      }
    }
  });

  it('escapes hostile text and renders only supported semantic nodes', () => {
    const node: FixtureNode = {
      type: 'paragraph',
      attrs: {
        blockId: '550e8400-e29b-41d4-a716-446655440000',
      },
      content: [
        {
          type: 'text',
          text: '<script>alert(1)</script>',
          marks: [
            {
              type: 'diffChange',
              attrs: { changeId: 'change-1', kind: 'insert' },
            },
          ],
        },
      ],
    };
    const html = renderNode(node);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('data-diff-change-kind="insert"');
  });

  it('renders every supported node and ordinary mark without executable HTML', () => {
    const text = (marks: FixtureNode['marks'] = []): FixtureNode => ({
      type: 'text',
      text: 'content',
      marks,
    });
    const paragraph = (content: readonly FixtureNode[] = [text()]): FixtureNode => ({
      type: 'paragraph',
      attrs: { blockId: '550e8400-e29b-41d4-a716-446655440000' },
      content,
    });
    const document: FixtureNode = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 9 },
          content: [
            text([
              { type: 'bold' },
              { type: 'italic' },
              { type: 'strike' },
              { type: 'code' },
              { type: 'link', attrs: { href: 'https://example.com' } },
            ]),
          ],
        },
        { type: 'blockquote', content: [paragraph()] },
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [paragraph()] }],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [{ type: 'listItem', content: [paragraph()] }],
        },
        { type: 'codeBlock', content: [text()] },
        { type: 'horizontalRule' },
        { type: 'hardBreak' },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [paragraph()] },
                { type: 'tableCell', content: [paragraph()] },
              ],
            },
          ],
        },
        { type: 'futureNode', content: [text()] },
      ],
    };
    const html = renderNode(document);
    for (const element of [
      '<h6',
      '<blockquote',
      '<ul',
      '<ol',
      '<li',
      '<pre',
      '<hr',
      '<br>',
      '<table',
      '<tr',
      '<th',
      '<td',
      '<strong>',
      '<em>',
      '<s>',
      '<a href="https://example.com">',
      'data-unsupported-node="futureNode"',
    ]) {
      expect(html).toContain(element);
    }
  });

  it('shows canonical JSON, metadata, operations, and assertions', () => {
    const fixture = fixtureCatalog[0];
    expect(fixture).toBeDefined();
    if (fixture === undefined) {
      return;
    }
    const html = renderFixturePage(fixture);
    expect(html).toContain('Canonical JSON');
    expect(html).toContain('Tracking metadata');
    expect(html).toContain('Semantic operation');
    expect(html).toContain('Automated assertions');
    for (const invariant of fixture.invariants) {
      expect(html).toContain(`data-assertion="${invariant.id}"`);
    }
  });

  it('serves deterministic filtered routes and safe HTTP failures', () => {
    const fixture = fixtureCatalog[0];
    expect(fixture).toBeDefined();
    if (fixture === undefined) {
      throw new Error('Expected a fixture');
    }
    const index = requestHarness('/fixtures?tag=direct&nodeType=paragraph&operation=replace_block');
    expect(index.status).toBe(200);
    expect(index.body).toContain('fixture browser');

    const direct = requestHarness(fixtureUrl(fixture));
    expect(direct.status).toBe(200);
    expect(direct.body).toContain(fixture.title);
    expect(requestHarness(`/fixtures/${fixture.id}?seed=1`).status).toBe(400);
    expect(requestHarness('/fixtures/%E0%A4%A').status).toBe(404);
    expect(requestHarness('/missing').status).toBe(404);
    expect(requestHarness('/fixtures', 'POST').status).toBe(405);
  });
});
