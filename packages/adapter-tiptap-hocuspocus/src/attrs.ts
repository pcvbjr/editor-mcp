import type { Attrs } from '@tiptap/pm/model';

/**
 * ProseMirror exposes attribute values as `any` for schema extensibility. The
 * certified adapter immediately narrows every value from `unknown` instead.
 */
export function readAttr(attrs: Attrs, name: string): unknown {
  return (attrs as Readonly<Record<string, unknown>>)[name];
}
