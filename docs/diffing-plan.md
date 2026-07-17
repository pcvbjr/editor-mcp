# In-Document Diffing Plan

## Status

Proposed standalone implementation plan. Real-time collaboration is deferred.

## Summary

The Editor MCP will provide GitHub-style diffs inside Tiptap documents without relying on Tiptap's diffing extension.

The durable diff representation will be part of the ProseMirror document:

- Inline insertions and deletions will use a custom `diffChange` mark.
- Block insertions, deletions, and modifications will use diff attributes on a defined set of existing block node types.
- Change metadata will live in an extension-managed store keyed by `changeId`.
- Decorations will be derived from document state and used only for presentation, controls, and gutters.

The MCP will produce semantic edit operations. A companion Tiptap extension will translate those operations into schema-valid ProseMirror transactions.

The initial release targets one authoritative editor state. Yjs synchronization, offline merging, and concurrent accept/reject behavior are deferred. The representation remains compatible with collaboration later because diff identity is stored in marks and node attributes rather than editor positions.

## Goals

1. Show concise, GitHub-style insertions and deletions directly in a live Tiptap document.
2. Keep diffs stable while humans and agents continue editing the document.
3. Support accepting and rejecting individual changes or groups of changes.
4. Work with common Tiptap block types out of the box.
5. Allow applications to register their own custom block types.
6. Keep editor-specific behavior out of the MCP's semantic interface.
7. Preserve the original text of proposed deletions until the deletion is accepted.
8. Produce schema-valid changes or fail safely without partially mutating the document.

## Non-goals

- Reconstructing arbitrary historical diffs.
- Replacing the application's version-history system.
- Supporting an unknown custom ProseMirror schema without a capability handshake or configuration.
- Real-time collaboration, offline merging, and multi-client conflict resolution in the first release.
- Providing a tamper-proof compliance audit log.
- Reusing Tiptap's existing diffing extension.
- Allowing arbitrary overlapping or recursively nested pending changes in the first version.

## Core decision

Use one custom inline mark and diff attributes on existing block nodes.

Do not introduce parallel node types such as `trackedParagraph`, `trackedHeading`, or `trackedTable`. Creating tracked variants would duplicate the schema, complicate lists and tables, and make third-party Tiptap extensions harder to support.

The representation is:

```text
Inline content
  diffChange {
    changeId: string
    kind: "insert" | "delete" | "format"
  }

Existing block or atom node
  diffChangeId: string | null
  diffChangeKind: "insert" | "delete" | "modify" | null
```

The mark or node attribute identifies the affected content. A separate metadata record describes who created the change, its current state, and how related segments are grouped.

## Architecture

```text
AI agent
    |
    | semantic edit request
    v
Editor MCP
    |
    | validated diff operations
    v
Tiptap diff adapter
    |
    | ProseMirror transactions
    v
Tiptap document + change metadata store
```

### Editor MCP responsibilities

- Read the document through the application's semantic representation.
- Address blocks by stable block ID.
- Validate requested targets and preconditions.
- Produce localized insert, delete, replace, and format operations.
- Group related operations into one logical change.
- Return clear errors when the host schema cannot represent an operation.

### Tiptap diff adapter responsibilities

- Declare the `diffChange` mark.
- Add diff attributes to configured node types.
- Convert semantic operations into ProseMirror transactions.
- Enforce schema validity.
- Normalize invalid or overlapping diff state.
- Render inline and block diffs.
- Implement accept, reject, accept-all, and reject-all commands.
- Strip or resolve diff metadata during clean export.

### Host application responsibilities

- Install and configure the companion diff extension.
- Provide the Tiptap schema and supported block types.
- Persist the document and optional change metadata through the application's normal persistence layer.
- Route MCP operations to the active editor or a compatible headless adapter.

## Supported block types

The extension will ship with a default set of common Tiptap node names:

```text
paragraph
heading
blockquote
bulletList
orderedList
listItem
taskList
taskItem
codeBlock
horizontalRule
image
table
tableRow
tableHeader
tableCell
```

Applications can extend or replace this set:

```ts
DiffExtension.configure({
  blockTypes: [
    'paragraph',
    'heading',
    'blockquote',
    'table',
    'tableRow',
    'tableCell',
    'image',
    'customCallout',
  ],
  unsupportedNodeStrategy: 'nearest-supported-parent',
})
```

The actual configuration API may change, but support must be explicit at schema construction time. The active editor and any headless adapter must use a compatible schema.

### Block handling rules

- Text changes inside a block use inline marks.
- Inserting or deleting an entire block uses attributes on that block.
- Leaf and atom nodes, such as images or embeds, use node attributes.
- A table-wide change is attached to the table.
- A row-only or cell-only change is attached at the narrowest valid table node.
- A change spanning several unrelated blocks creates multiple segments sharing one `groupId`.
- Unsupported custom nodes fall back to the configured strategy or fail without mutation.

## Inline mark specification

The initial mark will be conceptually equivalent to:

```ts
const DiffChange = Mark.create({
  name: 'diffChange',
  inclusive: false,

  addAttributes() {
    return {
      changeId: { default: null },
      kind: { default: null },
    }
  },
})
```

Implementation requirements:

- `changeId` is required when the mark is present.
- `kind` must be `insert`, `delete`, or `format`.
- The mark must coexist with ordinary formatting marks such as bold, italic, code, and link.
- The mark should exclude another `diffChange` mark on the same text in the first version.
- Typing at a mark boundary must not automatically extend the pending change.
- Pasting marked content into an unrelated location must strip the diff mark by default.
- The adapter must prevent or normalize text that simultaneously represents incompatible change kinds.

## Block attributes

Configured block and atom nodes receive two optional attributes:

```text
diffChangeId: string | null
diffChangeKind: "insert" | "delete" | "modify" | null
```

Attributes are added to existing node types through the companion extension. They must serialize to data attributes in review HTML and must be omitted from clean HTML.

Example review HTML:

```html
<p data-diff-change-id="chg_123" data-diff-change-kind="insert">
  Added paragraph
</p>
```

The final DOM naming is an implementation detail. The stable contract is the ProseMirror attribute names and semantic values.

## Change metadata

The extension will maintain a metadata store named `diffChanges`. Each `changeId` maps to a record with fields similar to:

```text
id
groupId
status: "pending" | "accepted" | "rejected"
operation: "insert" | "delete" | "replace" | "format" | "structure"
authorId
authorType: "human" | "agent"
createdAt
resolvedAt
resolvedBy
summary
baseBlockId
```

Formatting changes may additionally store the previous and proposed formatting required to accept or reject the operation.

The store may be backed by extension storage, application state, or a database. The document mark or node attribute should contain only the stable change identifier and kind. Mutable metadata should not be duplicated across every marked segment.

The core diff remains understandable if optional metadata is unavailable: `changeId` and `kind` are sufficient to render and resolve it. If a product requires immutable auditing, the sidecar must also write proposal and resolution events to an external append-only store.

When collaboration is added later, the metadata-store interface can be backed by a Yjs shared map without changing the mark or node-attribute representation.

## Semantic operation model

The MCP should operate on semantic changes rather than ProseMirror positions.

Example:

```json
{
  "changeId": "chg_123",
  "groupId": "grp_45",
  "operation": "replace",
  "target": {
    "blockId": "study-objectives"
  },
  "before": "The study measures safety.",
  "after": "The study measures safety and efficacy.",
  "author": {
    "id": "agent-researcher",
    "type": "agent"
  }
}
```

Initial operation types:

```text
insert_text
delete_text
replace_text
format_text
insert_block_before
insert_block_after
delete_block
replace_block
set_node_attribute
```

Every operation includes:

- a stable target block ID;
- sufficient before-state to detect stale requests;
- the intended after-state;
- a unique change ID;
- an optional group ID;
- author metadata;
- an idempotency key.

## Creating diffs

### Text insertion

1. Resolve the stable block ID.
2. Validate the expected surrounding text or hash.
3. Insert the new text.
4. Apply `diffChange { changeId, kind: "insert" }` to exactly the inserted text.
5. Create the metadata record through the same editor command boundary.

### Text deletion

1. Resolve and validate the target text.
2. Do not remove it from the document.
3. Apply `diffChange { changeId, kind: "delete" }` to the text.
4. Keep the text in the live document until the change is accepted.

### Text replacement

1. Mark the old text as `delete`.
2. Insert the new text adjacent to it and mark it as `insert`.
3. Give both segments the same `groupId`.
4. Resolve both segments together.

### Block insertion

1. Parse and validate the proposed block using the host schema.
2. Assign a stable block ID if it does not already have one.
3. Insert the block.
4. Set its diff attributes to `insert`.

### Block deletion

1. Keep the block in the document.
2. Set its diff attributes to `delete`.
3. Treat its content as read-only while the deletion is pending.

### Formatting change

1. Record the previous and proposed formatting in metadata.
2. Apply a `format` diff mark to the affected content.
3. Render the proposed format in review mode with an additional diff indicator.
4. Accept applies the proposal; reject restores the recorded prior formatting.

## Accept and reject behavior

| Change | Accept | Reject |
| --- | --- | --- |
| Inline insertion | Remove diff mark and retain text | Delete marked text |
| Inline deletion | Delete marked text | Remove diff mark and retain text |
| Block insertion | Remove diff attributes and retain node | Delete node |
| Block deletion | Delete node | Remove diff attributes and retain node |
| Replacement | Accept insertion and deletion together | Reject insertion and deletion together |
| Formatting | Apply proposed marks and remove diff mark | Restore previous marks and remove diff mark |

Resolution requirements:

- Resolve every segment sharing the same `groupId` atomically from the user's perspective.
- Make accept and reject idempotent.
- Process positional mutations from the end of the document toward the start.
- Update metadata only after the content transaction has been constructed successfully.
- Return `already_resolved` when the target change is no longer pending.
- Return a stable result for repeated requests with the same idempotency key.

## Collaboration and concurrency — deferred

The initial release assumes one authoritative editor state while a diff command is applied. It does not synchronize pending changes between sessions and does not resolve simultaneous accept/reject actions.

The document model is intentionally suitable for a later collaborative implementation:

- Diff identity is attached to content rather than absolute positions.
- Proposed deletions remain live document content.
- Change metadata is accessed through a replaceable store interface.
- Commands are deterministic and idempotent.
- Grouped changes resolve in one ProseMirror transaction.

Future collaboration work will add Yjs-backed metadata, transaction origins, multi-client normalization, offline testing, and serialized accept/reject decisions. None of that is required for the standalone release.

### Editing pending changes

Initial policy:

- Pending deletion content is read-only.
- Text inside a pending insertion may be edited and remains part of that insertion.
- Deleting part of a pending insertion simply removes that content; it does not create a nested deletion.
- Editing ordinary content adjacent to a pending change creates a separate change.
- Applying a new diff over an existing pending diff is rejected or normalized into the existing change group.

These rules avoid overlapping diff graphs in the first implementation.

## Rendering

The document state is canonical. Decorations are regenerated from marks and node attributes.

Default GitHub-style presentation:

- Inserted inline text: green background and optional underline.
- Deleted inline text: red background and strikethrough.
- Inserted block: green left gutter and light green background.
- Deleted block: red left gutter, reduced emphasis, and strikethrough where appropriate.
- Modified block: neutral change gutter with inline additions and deletions.
- Focused change: stronger outline plus accept/reject controls.

Review controls, hover cards, author labels, and change navigation are decorations or node-view UI. They must never be the only place where change identity is stored.

### View modes

The extension should support three projections:

```text
review
  Show insertions and deletions with diff styling.

final
  Show insertions and hide pending deletions.

original
  Show deletions and hide pending insertions.
```

View-mode hiding is visual only. It must not mutate the document.

## HTML and clipboard behavior

The sidecar needs explicit serialization modes:

```text
review HTML
  Includes diff wrappers or data attributes.

final HTML
  Includes pending insertions and excludes pending deletions.

original HTML
  Includes pending deletions and excludes pending insertions.

clean HTML
  Requires all changes to be resolved or an explicit resolution policy.
```

Clipboard defaults:

- Copying from the editor exports visible content without internal change IDs.
- Pasting ordinary HTML never creates diff marks from untrusted `data-*` attributes.
- An internal review-copy command may preserve change metadata when explicitly requested.
- Duplicated blocks receive new stable block IDs.

## Schema capability handshake

A generic Editor MCP cannot assume every Tiptap application has the same schema. Each host must expose a capability description:

```json
{
  "schemaVersion": "app-schema-v7",
  "nodes": [
    "paragraph",
    "heading",
    "table",
    "tableRow",
    "tableCell",
    "customCallout"
  ],
  "marks": [
    "bold",
    "italic",
    "link",
    "diffChange"
  ],
  "diffableBlocks": [
    "paragraph",
    "heading",
    "table",
    "customCallout"
  ]
}
```

The sidecar uses this manifest to:

- reject unsupported content before mutation;
- select the correct block strategy;
- determine whether a formatting operation is available;
- detect schema-version mismatches;
- choose a configured fallback for custom nodes.

The active editor and any headless sidecar must agree on the diff mark and attribute definitions.

## Stable block IDs

All addressable blocks require a stable ID independent of ProseMirror positions.

Rules:

- IDs are generated by the application or sidecar, not by the language model.
- IDs survive ordinary text edits and formatting changes.
- Copying or duplicating a block generates a new ID.
- Replacing a block preserves its ID when it remains the same semantic block.
- Splitting a block preserves the ID on one side and creates a new ID for the other.
- Joining blocks preserves one canonical ID and records the retired ID if necessary.

The stable block ID remains the public MCP locator. Relative-position guards can be considered later when collaboration is implemented.

## Transaction and undo policy

- Construct each proposed change as one logical transaction whenever possible.
- Tag sidecar-created transactions with recognizable ProseMirror metadata.
- Make an explicit decision about whether agent changes enter the local undo history.
- Treat accept and reject as explicit review commands rather than ordinary typing undo.
- Update document state and extension metadata through the same command boundary.
- Persist ProseMirror JSON or application-native document state; HTML is a projection.

## Validation and normalization

Before applying a change, validate:

- target block exists;
- stable block ID is unique;
- expected before-state still matches;
- proposed HTML parses under the host schema;
- affected node types support diff attributes;
- marks are allowed in the target text block;
- change and group IDs are not already in use incompatibly;
- the operation does not create unsupported overlapping diffs.

After document transactions, normalize:

- orphaned metadata records;
- marks with missing metadata;
- invalid change kinds;
- duplicate stable block IDs;
- empty diff ranges;
- partially missing replacement groups;
- diff attributes on unsupported nodes.

Normalization must be deterministic and idempotent so repeated processing produces the same valid representation.

## Error model

Initial stable errors:

```text
block_not_found
stale_target
schema_mismatch
unsupported_node
unsupported_mark
invalid_html
overlapping_change
change_not_found
already_resolved
incomplete_change_group
duplicate_block_id
```

No validation error should leave part of a proposed change applied.

## Testing strategy

### Unit tests

- Mark parsing and serialization.
- Node diff attributes for every default block type.
- Inline insertion, deletion, replacement, and formatting operations.
- Block insertion and deletion.
- Accept and reject behavior for every operation type.
- Grouped replacements across multiple blocks.
- Review, final, and original HTML projections.
- Clipboard stripping and block-ID regeneration.
- Idempotent creation and resolution.
- Validation and normalization rules.

### Schema tests

- Paragraphs and headings.
- Nested lists and list items.
- Code blocks.
- Blockquotes.
- Images and other atom nodes.
- Full tables, individual rows, and individual cells.
- A representative custom container node.
- A custom atom node.
- Nodes that explicitly disallow marks.

### Deferred collaboration tests

These tests are not required for the standalone release. When collaboration is implemented, run two or more synchronized documents and verify:

- typing before, inside, and after pending insertions;
- edits adjacent to pending deletions;
- simultaneous edits in unrelated blocks;
- block splitting and joining near diffs;
- table edits while a row or cell is marked;
- reconnecting an offline client with stale content;
- duplicate accept requests;
- concurrent accept and reject requests through sidecar serialization;
- eventual identical ProseMirror JSON on all clients.

### Property and fuzz tests

Generate random valid documents and sequences of:

- insertions;
- deletions;
- replacements;
- block splits and joins;
- accepts and rejects;
- repeated idempotent commands.

After every sequence, assert:

- the document satisfies the schema;
- no pending mark references missing metadata;
- every pending metadata record has at least one document segment;
- clean projections contain no diff artifacts.

## Implementation phases

### Phase 1: Inline proof of concept

- Implement the `diffChange` mark.
- Support paragraph and heading text.
- Implement insert, delete, and replace.
- Render GitHub-style inline diffs.
- Implement individual accept and reject.
- Implement the standalone change metadata store.

### Phase 2: Common block support

- Add global block attributes.
- Support paragraphs, headings, blockquotes, lists, code blocks, horizontal rules, and images.
- Add block gutters and navigation.
- Implement grouped multi-block changes.

### Phase 3: Tables and custom schemas

- Support table, row, header, and cell changes.
- Add the schema capability handshake.
- Add configurable custom node adapters and fallback behavior.
- Add schema mismatch reporting.

### Phase 4: Standalone production and packaging

- Publish the companion Tiptap extension.
- Publish the schema/capability contract.
- Provide example integrations for a basic editor, tables, and a custom node.
- Add idempotency keys and durable resolution records.
- Complete standalone fuzz and recovery testing.
- Add metrics for invalid, stale, and normalized changes.

### Deferred phase: Collaboration

- Add Yjs-backed change metadata.
- Define transaction-origin and undo behavior.
- Serialize conflicting accept/reject decisions.
- Add multi-client and offline normalization.
- Complete convergence, reconnect, and conflict testing.
- Document integration with Hocuspocus and Yjs providers.

## Success criteria

The first production release is successful when:

1. An MCP client can insert, delete, or replace content using stable block IDs.
2. Every change renders as a clear GitHub-style diff in the editor.
3. Pending deletions remain reviewable until accepted.
4. Accepting or rejecting a change produces the expected clean document.
5. Common Tiptap blocks, including tables, remain schema-valid.
6. Unsupported custom content fails safely with a useful capability error.
7. Review, final, and original HTML projections are deterministic.
8. The implementation does not depend on Tiptap's diffing extension.

## Open implementation decisions

- Final package and extension names.
- Exact metadata fields retained after resolution.
- How standalone change metadata is persisted and whether resolved records are compacted into external history.
- Whether editing inside a pending insertion remains enabled in the first release.
- The fallback policy for unsupported custom container nodes.
- How much formatting-diff support belongs in the first public version.
- Whether accept/reject operations are exposed only through MCP tools or also as direct client commands.

These decisions do not change the foundational model: inline changes are marks, block changes are attributes on existing node types, and diff metadata is managed separately by change ID.
