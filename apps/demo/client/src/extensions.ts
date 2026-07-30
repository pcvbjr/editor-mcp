import { Extension, Mark, mergeAttributes, type Extensions } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { TableKit, TableView } from '@tiptap/extension-table';
import UniqueID from '@tiptap/extension-unique-id';
import StarterKit from '@tiptap/starter-kit';
import type { Doc } from 'yjs';

const addressableNodeTypes = [
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'horizontalRule',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
] as const;

type TableNode = Parameters<InstanceType<typeof TableView>['update']>[0];

/**
 * Tiptap's table node view only refreshes column widths during an update. The
 * document's tracking attributes can therefore change in ProseMirror while
 * stale data-diff-* attributes remain on the live table element. Keep the DOM
 * projection synchronized so accepting or rejecting a table is visible
 * immediately without a page reload.
 */
class SynchronizedTableView extends TableView {
  override update(node: TableNode): boolean {
    const updated = super.update(node);
    if (updated) {
      this.syncAttribute(node, 'data-block-id', 'blockId');
      this.syncAttribute(node, 'data-diff-change-id', 'diffChangeId');
      this.syncAttribute(node, 'data-diff-change-kind', 'diffChangeKind');
    }
    return updated;
  }

  private syncAttribute(node: TableNode, htmlName: string, documentName: string): void {
    // ProseMirror types attrs as any; the editor schema validates these values before this boundary.
    const attributes = node.attrs as Record<string, unknown>;
    const value = attributes[documentName];
    if (typeof value === 'string') {
      this.table.setAttribute(htmlName, value);
    } else {
      this.table.removeAttribute(htmlName);
    }
  }
}

const EditorMcpAttributes = Extension.create({
  name: 'editorMcpAttributes',
  addGlobalAttributes() {
    return [
      {
        types: [...addressableNodeTypes],
        attributes: {
          blockId: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-block-id'),
            renderHTML: ({ blockId }) =>
              typeof blockId === 'string' ? { 'data-block-id': blockId } : {},
          },
          diffChangeId: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-diff-change-id'),
            renderHTML: ({ diffChangeId }) =>
              typeof diffChangeId === 'string' ? { 'data-diff-change-id': diffChangeId } : {},
          },
          diffChangeKind: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-diff-change-kind'),
            renderHTML: ({ diffChangeKind }) =>
              typeof diffChangeKind === 'string' ? { 'data-diff-change-kind': diffChangeKind } : {},
          },
        },
      },
    ];
  },
});

const DiffChange = Mark.create({
  name: 'diffChange',
  inclusive: false,
  addAttributes() {
    return {
      changeId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-diff-change-id'),
      },
      kind: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-diff-change-kind'),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-diff-change-id][data-diff-change-kind]' }];
  },
  renderHTML({ HTMLAttributes }) {
    const attributes = HTMLAttributes as Record<string, unknown>;
    const changeId = attributes['changeId'];
    const kind = attributes['kind'];
    return [
      'span',
      mergeAttributes(
        typeof changeId === 'string' ? { 'data-diff-change-id': changeId } : {},
        typeof kind === 'string' ? { 'data-diff-change-kind': kind } : {},
      ),
      0,
    ];
  },
});

export function editorExtensions(document: Doc, field: string): Extensions {
  return [
    StarterKit.configure({ undoRedo: false }),
    TableKit.configure({ table: { View: SynchronizedTableView } }),
    EditorMcpAttributes,
    DiffChange,
    UniqueID.configure({
      attributeName: 'blockId',
      types: [...addressableNodeTypes],
    }),
    Collaboration.configure({ document, field }),
  ];
}
