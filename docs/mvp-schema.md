# Editor MCP MVP Schema

**Schema ID:** `editor-mcp/mvp`
**Schema version:** `1`
**Status:** Normative

## Purpose

This profile defines the first document schema certified by Editor MCP. A document adapter must use an equivalent ProseMirror schema on the server and client. Unsupported content fails without mutation.

## Nodes

| Node             | Addressable | Allowed attributes                                                        |
| ---------------- | ----------- | ------------------------------------------------------------------------- |
| `doc`            | no          | none                                                                      |
| `text`           | no          | none                                                                      |
| `paragraph`      | yes         | `blockId`, tracking attributes                                            |
| `heading`        | yes         | `blockId`, `level` from 1 through 6, tracking attributes                  |
| `blockquote`     | yes         | `blockId`, tracking attributes                                            |
| `bulletList`     | yes         | `blockId`, tracking attributes                                            |
| `orderedList`    | yes         | `blockId`, `start` greater than or equal to 1, tracking attributes        |
| `listItem`       | yes         | `blockId`, tracking attributes                                            |
| `codeBlock`      | yes         | `blockId`, optional `language`, tracking attributes                       |
| `horizontalRule` | yes         | `blockId`, tracking attributes                                            |
| `hardBreak`      | no          | none                                                                      |
| `table`          | yes         | `blockId`, tracking attributes                                            |
| `tableRow`       | yes         | `blockId`, tracking attributes                                            |
| `tableHeader`    | yes         | `blockId`, `colspan`, `rowspan`, optional `colwidth`, tracking attributes |
| `tableCell`      | yes         | `blockId`, `colspan`, `rowspan`, optional `colwidth`, tracking attributes |

`blockId` is an opaque UUID assigned by the server. Model-supplied IDs on newly inserted or
replacement content are rejected. Localized text and formatting operations retain the containing
block's ID, and moving an existing node retains that node's ID.

`replace_block` is an identity boundary, not a localized content edit. It retires the target block
ID and assigns fresh server-owned IDs to every addressable node in the replacement subtree. This
rule applies even when the replacement has the same node type. A block type change is a replacement
and therefore always produces a new block ID; there is no "compatible type change" exception.

## Marks

- `bold`
- `italic`
- `strike`
- `code`
- `link` with an allowed `href` and optional `title`
- `diffChange` with server-derived `changeId` and `kind`

Allowed link schemes are `https`, `http`, and `mailto`. Relative links are allowed. Scripts, event handlers, embedded content, style attributes, and unknown attributes are rejected.

## Tracking attributes

Addressable nodes support:

```text
diffChangeId: string | null
diffChangeKind: "insert" | "delete" | "modify" | null
```

Inline tracked content uses:

```text
diffChange {
  changeId: string
  kind: "insert" | "delete" | "format"
}
```

Resolution-critical metadata is stored in the document's `diffChanges` Yjs map. Client presentation is not part of this schema.

## Structural constraints

- A document contains one or more valid block nodes.
- List containers contain list items; nested lists occur inside list items.
- Tables are rectangular after accounting for `colspan` and `rowspan`.
- A table contains table rows; rows contain table headers or table cells.
- Table cells contain one or more block nodes.
- Inline marks must be valid for their parent node.
- `diffChange` marks may not overlap another incompatible `diffChange`.
- Pending block deletions remain in the document until accepted.

## Canonicalization

Incoming HTML is parsed through the exact registered schema and serialized to canonical ProseMirror JSON before hashing or comparison. Unsupported elements, attributes, invalid nesting, lossy parsing, duplicate IDs, and resource-limit violations reject the entire operation.

The required round-trip invariant is semantic:

```text
ProseMirror JSON → agent HTML → ProseMirror JSON
```

must produce an equivalent canonical document. Byte-identical HTML is not required.

## Initial semantic operations

- `insert_before`
- `insert_after`
- `replace_block`
- `delete_block`
- `insert_text`
- `delete_text`
- `replace_text`
- `format_text`
- `insert_table_row`
- `delete_table_row`
- `insert_table_column`
- `delete_table_column`
- `accept_change`
- `reject_change`

All mutations execute as atomic, idempotent operations against target-specific preconditions in the authoritative Hocuspocus/Yjs document.

## Executable fixtures

Every certified operation and edge case has one shared fixture definition that drives:

- mutation-core tests;
- sidecar REST contract tests;
- Yjs/Hocuspocus convergence tests;
- accept and reject tests;
- canonical HTML and ProseMirror JSON snapshots;
- a browser-visible Tiptap matrix showing `before`, `proposed`, `accepted`, and `rejected`.

The accepted and rejected states are independently derived from the same proposed state.
