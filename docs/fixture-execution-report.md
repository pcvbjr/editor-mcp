# Fixture execution report

Generated from the executable catalog and the production-backed fixture integration test.

## Result

- 42 catalog fixtures were inspected.
- All 42 mutation requests use `changeMode: "suggest"`.
- 41 fixtures apply successfully, publish tracked Proposed content, and pass accept/reject materialization against the canonical JSON expectations.
- 1 fixture is an intentional conflict contract: overlapping inline formatting is rejected atomically with `INVALID_CONTENT`; it publishes no partial Proposed state.
- No fixture uses direct mode as an agent capability. Direct mode remains available only to human/service-controlled internal paths (for example, review resolution and existing human-mode compatibility tests). Agent direct requests are rejected before mutation.

The historical `-direct` suffix on several fixture IDs is retained for stable URLs and does not describe the request mode.

## Per-fixture observations

| Fixture | Operation(s) | Request mode | Observed result | Proposed tracking |
| --- | --- | --- | --- | --- |
| replace-block-direct-type-change | replace_block | suggest | applied + accept/reject | yes |
| replace-block-suggest-blocks | replace_block | suggest | applied + accept/reject | yes |
| delete-block-suggest-blockquote | delete_block | suggest | applied + accept/reject | yes |
| insert-table-row-suggest | insert_table_row | suggest | applied + accept/reject | yes |
| insert-block-before-direct | insert_before | suggest | applied + accept/reject | yes |
| insert-block-after-suggest | insert_after | suggest | applied + accept/reject | yes |
| insert-text-direct-emoji-end-boundary | insert_text | suggest | applied + accept/reject | yes |
| insert-text-suggest-multiscript-start-boundary | insert_text | suggest | applied + accept/reject | yes |
| delete-text-direct-bidirectional-range | delete_text | suggest | applied + accept/reject | yes |
| delete-text-suggest-special-whitespace | delete_text | suggest | applied + accept/reject | yes |
| replace-text-direct-emoji-with-cjk | replace_text | suggest | applied + accept/reject | yes |
| replace-text-suggest-combining-normalization | replace_text | suggest | applied + accept/reject | yes |
| format-text-suggest-add-bold | format_text | suggest | applied + accept/reject | yes |
| format-text-direct-overlapping-marks | format_text | suggest | conflict: `INVALID_CONTENT` (no partial proposal) | no |
| format-text-direct-remove-adjacent-marks | format_text | suggest | applied + accept/reject | yes |
| replace-text-direct-adjacent-batch | replace_text | suggest | applied + accept/reject | yes |
| structure-ordered-list-insert-middle-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-ordered-list-delete-item-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-ordered-list-reorder-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-ordered-list-start-value-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-unordered-list-insert-hard-break-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-unordered-list-reorder-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-unordered-list-delete-item-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-deeply-nested-mixed-lists-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-ordered-to-unordered-list-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-unordered-to-ordered-list-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-nested-mixed-list-reparent-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-heading-level-and-text-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-heading-to-empty-paragraph-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-paragraph-to-heading-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-blockquote-to-code-block-direct | replace_block | suggest | applied + accept/reject | yes |
| structure-code-block-to-horizontal-rule-direct | replace_block | suggest | applied + accept/reject | yes |
| table-row-reorder-with-content-change-direct | replace_block | suggest | applied + accept/reject | yes |
| table-column-shaped-replacement-direct | replace_block | suggest | applied + accept/reject | yes |
| table-cell-paragraph-replacement-direct | replace_block | suggest | applied + accept/reject | yes |
| table-header-body-transition-direct | replace_block | suggest | applied + accept/reject | yes |
| table-colspan-rowspan-replacement-direct | replace_block | suggest | applied + accept/reject | yes |
| table-nested-marked-cell-content-direct | replace_block | suggest | applied + accept/reject | yes |
| table-insert-row-after-last-boundary-direct | insert_table_row | suggest | applied + accept/reject | yes |
| table-delete-first-row-boundary-direct | delete_table_row | suggest | applied + accept/reject | yes |
| table-insert-column-after-last-boundary-direct | insert_table_column | suggest | applied + accept/reject | yes |
| table-delete-first-column-boundary-direct | delete_table_column | suggest | applied + accept/reject | yes |

## What is not implemented

ProseMirror's schema permits only one `diffChange` mark on a text node. The service therefore rejects a second suggested inline operation whose range overlaps an existing pending inline change. The overlapping-marks fixture records that behavior as an atomic conflict instead of fabricating invalid canonical JSON or a partial proposal. Adjacent (non-overlapping) formatting and replacement operations are executable and pass.

The canonical JSON tests validate every before/Proposed/Accepted/Rejected state byte-for-byte. The production integration test additionally executes the states through the adapter and durable Yjs runtime, including the conflict assertion above.
