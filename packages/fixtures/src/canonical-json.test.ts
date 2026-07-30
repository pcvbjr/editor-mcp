import { canonicalJsonString, canonicalizeDocument } from '@editor-mcp/adapter-tiptap-hocuspocus';
import { describe, expect, it } from 'vitest';

import { fixtureCatalog } from './index.js';
import type { FixtureDocument, FixtureNode, FixtureState } from './types.js';

const canonicalDocument = (document: FixtureDocument): FixtureDocument =>
  canonicalizeDocument(document).toJSON() as FixtureDocument;

const blockIds = (node: FixtureNode): readonly string[] => [
  ...(typeof node.attrs?.['blockId'] === 'string' ? [node.attrs['blockId']] : []),
  ...(node.content?.flatMap(blockIds) ?? []),
];

const stateLabel = (fixtureId: string, state: string): string => `${fixtureId}:${state}`;

describe('fixture canonical JSON contracts', () => {
  it('stores every expected state as adapter-canonical JSON, byte-for-byte', () => {
    for (const fixture of fixtureCatalog) {
      const states: readonly [string, FixtureState][] = [
        ['before', fixture.expected.states.before],
        ['proposed', fixture.expected.states.proposed],
        ['accepted', fixture.expected.states.accepted],
        ['rejected', fixture.expected.states.rejected],
      ];
      for (const [name, state] of states) {
        const canonical = canonicalDocument(state.document);
        expect({ label: stateLabel(fixture.id, name), value: canonical }).toEqual({
          label: stateLabel(fixture.id, name),
          value: state.document,
        });
        expect(canonicalJsonString(canonical)).toBe(canonicalJsonString(state.document));
      }
    }
  });

  it('publishes exact block identity sets for every expected state', () => {
    for (const fixture of fixtureCatalog) {
      const beforeIds = blockIds(fixture.expected.states.before.document);
      const proposedIds = blockIds(fixture.expected.states.proposed.document);
      const acceptedIds = blockIds(fixture.expected.states.accepted.document);
      const rejectedIds = blockIds(fixture.expected.states.rejected.document);

      expect(new Set(beforeIds).size).toBe(beforeIds.length);
      expect(new Set(proposedIds).size).toBe(proposedIds.length);
      expect(new Set(acceptedIds).size).toBe(acceptedIds.length);
      expect(new Set(rejectedIds).size).toBe(rejectedIds.length);

      for (const generatedId of fixture.expected.generatedBlockIds) {
        expect(beforeIds).not.toContain(generatedId);
        expect(proposedIds).toContain(generatedId);
      }
    }
  });
});
