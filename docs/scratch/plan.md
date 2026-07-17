
# Agent-Native Editing for Live Collaborative Documents

## Background

One of the hardest engineering problems we encountered while building AI agents wasn't generating documents—it was **editing them**.

Modern LLMs are surprisingly good at writing long-form text. They are much worse at making **small, precise edits inside a live collaborative rich-text document**.

For our product, users weren't interacting with a chatbot. They were collaborating with an AI inside a rich-text editor similar to Google Docs. The AI needed to behave like another editor on the document, making localized edits that users could review through tracked changes.

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

At the time we evaluated it, the experience felt clunky and still immature.

It wasn't capable of the fast, native editing experience we wanted.

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

Instead every editable block received a stable ID.

Example:

```html
<h2 block-id="study-objectives">

Study Objectives

</h2>
```

The agent could then say:

```
Insert after

study-objectives
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

# General Design Pattern

The biggest lesson wasn't about ProseMirror.

It was about **building AI-friendly abstractions**.

Instead of exposing internal application data structures directly to an LLM,

create an interface that matches how models naturally think.

For us that looked like:

```
ProseMirror

↓

HTML

↓

Stable block IDs

↓

Localized edit operations

↓

Deterministic adapter

↓

Collaborative document
```

I think this pattern applies far beyond document editing.

The same philosophy could be used for:

- spreadsheets
- slide decks
- design tools
- CAD software
- project management tools
- IDEs
- workflow builders

Rather than asking an LLM to manipulate a complex internal representation, expose a semantic interface with stable identifiers and a small set of high-level operations. The model focuses on reasoning and content generation, while deterministic software translates those operations into the application's native data model.

---

## Looking back

One thing I'd add, now that I've heard the whole story, is that I think the interesting innovation **wasn't the Hocuspocus sidecar itself**. It was recognizing that **AI agents need their own application layer**, just like humans do. Human users edit through a GUI; your agents edited through an API designed around semantic operations rather than editor internals. That's the architectural idea I'd emphasize in interviews, because it's applicable well beyond ProseMirror.