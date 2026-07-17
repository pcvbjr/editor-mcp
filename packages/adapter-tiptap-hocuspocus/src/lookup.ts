import { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { readAttr } from './attrs.js';
import { digestCanonicalJson, validateDocument } from './canonical.js';
import { isAddressableNodeType } from './schema.js';
import type { BlockSummary } from './types.js';

export function digestBlock(block: ProseMirrorNode): `sha256:${string}` {
  return digestCanonicalJson(block);
}

export function listBlockSummaries(document: ProseMirrorNode): readonly BlockSummary[] {
  validateDocument(document);
  const summaries: BlockSummary[] = [];
  document.descendants((node) => {
    if (isAddressableNodeType(node.type.name)) {
      summaries.push({
        id: String(readAttr(node.attrs, 'blockId')),
        nodeType: node.type.name,
        contentDigest: digestBlock(node),
      });
    }
  });
  return summaries;
}
