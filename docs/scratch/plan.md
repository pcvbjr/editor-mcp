
# Agent-Native Editing for Live Collaborative Documents

## Background

One of the hardest engineering problems we encountered while building AI agents wasn't generating rich text documents—it was **editing them**.

Modern LLMs are surprisingly good at writing long-form text. They are much worse at making **small, precise edits inside a live collaborative rich-text document**.

Our users were collaborating with an AI inside a rich-text editor similar to Google Docs. The AI needed to behave like another editor on the document, making localized edits that users could review through tracked changes.

This turned out to be a much harder problem than simply generating text.

---

# The Problem

Initially, it seems like editing a document should be easy.

The AI already knows how to write.

Why not just give it the document and ask it to edit it?

In practice, this approach has several problems.

## Whole-document regeneration

The simplest solution is:

```
Current document
      ↓
Prompt LLM
      ↓
Entire new document
```

This works for prototypes.

It performs poorly in production.

If a user asks:

> "Add a paragraph describing inclusion criteria."

the model frequently rewrites surrounding content.

That creates:

- unnecessary latency
- huge prompts
- huge outputs
- noisy diffs
- accidental wording changes
- formatting problems
- difficult review

Users don't want the document rewritten.

They want **one precise edit**.

---

# Why ProseMirror Is Difficult

Our editor is built on **ProseMirror**.

ProseMirror is an outstanding editor framework.

It is not an outstanding interface for LLMs.

Internally, ProseMirror represents documents as deeply nested trees.

Instead of thinking about:

```
Paragraph

Sentence

Heading
```

the model has to reason about

- nodes
- marks
- nested children
- attributes
- editor schema
- transactions
- positions
- selections

An LLM can understand these structures.

But it isn't naturally good at manipulating large nested trees reliably.

Small mistakes can invalidate the entire document.

The core issue wasn't that ProseMirror is bad.

The issue was that **ProseMirror is optimized for editors, not AI agents.**

---

# Existing Solutions

We evaluated several existing approaches.

## Tiptap AI

Tiptap had begun building AI editing capabilities.

At the time we evaluated it, the experience felt clunky and still immature. You can try their beta on their website now - the demo they post themselves is clunky and buggy.

It isn't capable of the fast, native editing experience we wanted.

---

## Claude in Word

Claude in Microsoft Word is another interesting comparison.

Claude can absolutely edit documents.

But the workflow feels like:

```
Think...
Think...
Think...

Rewrite large chunk...
```

Even relatively small edits take noticeable time because the model spends significant effort reasoning about the document and reconstructing the desired output.

It feels like an AI bolted onto Word.

We wanted the AI to feel like a native participant in the document.

---

# Design Goals

We decided our solution needed to satisfy several goals.

### 1. Precise

Only modify exactly what needs changing.

---

### 2. Fast

Small edits should execute quickly.

---

### 3. Collaborative

The AI edits the same live document as humans.

---

### 4. Reviewable

Users should see tracked changes and accept or reject them.

---

### 5. Agent-Friendly

The interface should match how LLMs naturally reason.

---

# The Key Insight

The biggest realization was:

> **The agent should never edit ProseMirror directly.**

Instead, we should build an abstraction layer.

The agent doesn't care about ProseMirror.

It cares about:

- reading the document
- deciding what to change
- generating new content
- deciding where it belongs

Everything else is deterministic software.

---

# The Architecture

```
             AI Agent
                 │
      Reads HTML document
                 │
      Chooses block to edit
                 │
 Generates localized HTML patch
                 │
                 ▼
        REST API (Sidecar)
                 │
    Validates requested edit
                 │
 Converts into ProseMirror ops
                 │
 Applies tracked changes
                 │
                 ▼
      Live collaborative editor
```

The architecture deliberately separates:

**Semantic reasoning**

from

**Document mutation**

---

# The Hocuspocus Sidecar

Instead of letting the AI manipulate the document directly, we created a **Hocuspocus sidecar**.

The sidecar owned all interaction with the collaborative document.

It exposed a REST API.

The agent could:

- read the document
- request edits
- insert content
- replace content

The sidecar handled everything editor-specific.

Sidecar edit verbs:
- overwrite - replace all content in the document
- insert - based on a block-id, gives html to put in after or before that block-id
- edit - edit the inner text withn an block-id, includes a `mode` field for `text` or `html`
- replace - give a block-id to delete, give new html to insert
- delete - deletes by block-id
- table ops (insert_row, insert_col, delete_row, delete_col) - since rows and cols are multi-block

The sidecar takes the agent's content changes as HTML content. The sidecar the performs the HTML edits, and converts that into ProseMirror `pm_new`. It then diffs `pm_new` vs. `pm_current` by finding the first and last changed nodes - between them, inclusive, is tracked as a diff, using insert/delete tags. When `edit` verb is used, it narrows the diff to just the changed text within the block, so editing "Hi my name is Chris" to "Hi your name is Chris" only shows a diff within the block of <del>my</del><ins>your</ins>.

Building the sidecar diffing requires comprehensive testing and strong edge-case coverage. Because diffing is foundational, it must be deterministic, lossless, and highly reliable.

- ordered lists: insertions, deletions, reordering, renumbering, start values, and numbering-style changes
- unordered lists: insertions, deletions, reordering, bullet-style changes, and transitions to or from ordered lists
- nested content: arbitrary nesting depth, mixed list types, indentation changes, reparenting, and subtree moves
- tables: row and column insertion, deletion, and reordering; cell edits; merged and split cells; header changes; and nested content
- headings: level changes, text edits, conversions between headings and paragraphs, and section moves
- text formatting: bold, italic, underline, links, code, and overlapping or adjacent mark changes
- block types: paragraphs, blockquotes, code blocks, dividers, callouts, and conversions between types
- structural operations: insertions, deletions, replacements, moves, splits, joins, and simultaneous adjacent edits
- empty and boundary cases: empty documents, empty blocks or cells, first and last nodes, trailing content, and whitespace-only changes
- ambiguous matches: duplicate text, repeated headings, identical list items, and similar table rows
- Unicode and special content: emoji, combining characters, non-Latin scripts, bidirectional text, line breaks, and special whitespace
- metadata and attributes: IDs, anchors, classes, alignment, language, and other node attributes
- compound edits: content, formatting, and structural changes made together in the same subtree
- correctness properties: deterministic output, stable operation ordering, valid patches, round-trip reconstruction, idempotence, and preservation of untouched content
- robustness: malformed or partially supported input, very deep nesting, very large documents, and performance regression coverage
- fuzz and property-based testing: randomized document pairs with invariants verifying that applying the diff reconstructs the target exactly

---

# HTML Instead of ProseMirror

The agent never saw raw ProseMirror.

Instead, the sidecar serialized the document into HTML.

Why?

Because HTML is much closer to how LLMs naturally understand documents.

The model can easily reason about

```
Heading

Paragraph

List

Table

Bold

Italic
```

without worrying about editor transactions.

The HTML became an **AI-native representation** of the document.

---

# Stable Block IDs

One remaining challenge:

How does the agent specify *where* an edit belongs?

Using character positions doesn't work well.

Documents change.

Users edit them simultaneously.

Instead every editable block received a stable ID (uuid).

Example:

```html
<h2 block-id="xyz-123">

Study Objectives

</h2>
```

The agent could then say:

```
Insert after

xyz-123
```

instead of

```
Insert at character 7,382
```

This made edits much more robust.

---

# Localized HTML Patches

Instead of generating an entire document,

the agent generated only the new HTML.

Example:

```
Insert after block

study-objectives

↓

<p>

Secondary objectives include...

</p>
```

The model never regenerated surrounding content.

Only the new paragraph.

---

# Tracked Changes

The sidecar converted those HTML edits into tracked changes.

Conceptually:

```
Old text

↓

<deleted>

Old text

</deleted>

<inserted>

New text

</inserted>
```

The important point is that **the AI never had to create tracked changes itself.**

It simply described the desired edit.

The sidecar converted that request into whatever tracked-change representation the editor required.

---

# Why This Worked

The agent became responsible for exactly two things:

1. deciding what should change

2. writing the replacement content

Everything else became deterministic software.

The sidecar handled:

- ProseMirror
- transactions
- tracked changes
- HTML conversion
- validation
- collaboration
- synchronization

That dramatically reduced complexity.

---

# Benefits

Compared to document regeneration, this architecture provided:

### Much faster edits

The model only generated small HTML snippets.

---

### Much smaller prompts

The model didn't need to rewrite large sections.

---

### Better precision

Only requested content changed.

---

### Better review

Tracked changes were clean.

---

### Better collaboration

Humans and AI worked in the same live document.

---

### Better reliability

The model never manipulated complex ProseMirror structures directly.

---

# Accept/Reject
Each tracked edit has an id. It corresponds to the atomic call from the agent - so all of a single `insert`, or both the deletion and inserted block from `replace` would have the same tracking id. The user can then accept or reject - the sidecar exposes a REST API endpoint to take these accept/reject decisions and apply the desired edit, removing the tracking.

# Interface
This is an MCP for agents to use. They can create or connect to documents, which spins them up in a sidecar. The MCP automatically hits the REST API under the hood, given the agent's edits. We need to make available to the client the hocuspocus websocket URL for the document and the accept/reject endpoint.

# Key questions
### 1. Define the canonical document schema

  The proposal needs an explicit list of supported ProseMirror nodes, marks, and attributes.

  Questions include:

  - Which headings, lists, tables, media, code blocks, links, comments, and custom nodes exist? headings, paragraphs, lists, tables, code blocks, links - that is sufficient for mvp
  - Can HTML contain arbitrary elements and styles, or only a strict allowlist? only allowlist
  - What happens to unsupported HTML?
  - Is HTML normalized before comparison?
  - Must HTML serialization round-trip without losing attributes? yes

### 2. Specify block identity and addressability

  “Every editable block receives a UUID” in docs/scratch/plan.md:314 needs a precise lifecycle.

  Decide:

  - Which nodes receive IDs: paragraphs, headings, list items, table cells, rows, nested blocks? yes every block allowed
  - Are IDs stored in ProseMirror/Yjs or added only during HTML serialization? stored in prosemirror, as are edit ids
  - Are IDs preserved through type changes and moves? not thru html block type change
  - What IDs result from splitting, joining, copying, or pasting blocks? new ones
  - Who detects and repairs duplicate IDs? sidecar should not allow them to be written to the source of truth PM
  - Should the HTML attribute be data-block-id rather than a custom block-id? yes
  - Can a command target a table cell or nested list position without addressing its parent? yes

### 3. Define concurrency semantics

  Stable IDs solve location drift, but not stale intent.

  For each mutation, decide:

  - Does the request include the document version/state vector that the agent read? if the agent's read is stale, the tool call can not execute the edit and tell agent so. the MCP works as a tool call, so we communicate to agent clearly and include useful info so the agent can correct next time
  - What happens if a human edits the target block before the agent submits?
  - Does the sidecar reject, rebase, or apply the operation to the latest content?
  - What if the target was deleted or moved?
  - Can multiple agent edits run concurrently? yes
  - Are retries idempotent?
  - Is a compound edit applied as one Yjs/ProseMirror transaction? yes
