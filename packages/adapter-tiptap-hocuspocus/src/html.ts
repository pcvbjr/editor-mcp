import { Buffer } from 'node:buffer';

import { DOMParser as ProseMirrorDomParser, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { JSDOM } from 'jsdom';

import {
  canonicalizeDocument,
  isAllowedHref,
  isUuid,
  resolveResourceLimits,
  validateDocument,
} from './canonical.js';
import { readAttr } from './attrs.js';
import { AdapterValidationError } from './errors.js';
import { assignBlockIds } from './ids.js';
import { projectDocument } from './review.js';
import { mvpSchema } from './schema.js';
import type {
  BlockDiffKind,
  HtmlParseOptions,
  HtmlSerializeOptions,
  InlineDiffKind,
  ProjectionMode,
  ResourceLimits,
} from './types.js';

type HtmlSource = 'agent' | 'review';

const voidTags = new Set(['br', 'hr']);
const blockTags = new Set([
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'ol',
  'p',
  'pre',
  'table',
  'ul',
]);
const inlineTags = new Set(['a', 'b', 'br', 'code', 'em', 'i', 's', 'span', 'strike', 'strong']);
const allowedTags = new Set([
  ...blockTags,
  ...inlineTags,
  'li',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
]);
const addressableTags = new Set([...blockTags, 'li', 'td', 'th', 'tr']);
const blockDiffKinds = new Set<BlockDiffKind>(['delete', 'insert', 'modify']);
const inlineDiffKinds = new Set<InlineDiffKind>(['delete', 'format', 'insert']);

interface SourceFrame {
  readonly tag: string;
  readonly childTags: string[];
  hasNonWhitespaceText: boolean;
}

interface ParsedStartTag {
  readonly attrs: ReadonlyMap<string, string>;
  readonly selfClosing: boolean;
  readonly tag: string;
}

function invalidHtml(message: string): never {
  throw new AdapterValidationError('INVALID_HTML', message);
}

function invalidNesting(message: string): never {
  throw new AdapterValidationError('INVALID_NESTING', message);
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  invalidHtml('HTML contains an unterminated tag');
}

function parseStartTag(source: string): ParsedStartTag {
  let index = 0;
  while (/\s/u.test(source[index] ?? '')) {
    index += 1;
  }
  const tagMatch = /^[a-z][a-z\d-]*/iu.exec(source.slice(index));
  if (tagMatch === null) {
    invalidHtml('HTML contains an invalid opening tag');
  }
  const tag = tagMatch[0].toLowerCase();
  index += tagMatch[0].length;
  const attrs = new Map<string, string>();
  let selfClosing = false;

  while (index < source.length) {
    while (/\s/u.test(source[index] ?? '')) {
      index += 1;
    }
    if (index >= source.length) {
      break;
    }
    if (source[index] === '/') {
      if (source.slice(index + 1).trim().length !== 0) {
        invalidHtml('Self-closing slash must end the opening tag');
      }
      selfClosing = true;
      break;
    }
    const nameMatch = /^[^\s=/>]+/u.exec(source.slice(index));
    if (nameMatch === null) {
      invalidHtml('HTML contains an invalid attribute name');
    }
    const name = nameMatch[0].toLowerCase();
    index += nameMatch[0].length;
    if (attrs.has(name)) {
      throw new AdapterValidationError(
        'UNSUPPORTED_ATTRIBUTE',
        'Duplicate HTML attributes are rejected',
        { attribute: name },
      );
    }
    while (/\s/u.test(source[index] ?? '')) {
      index += 1;
    }
    if (source[index] !== '=') {
      throw new AdapterValidationError(
        'UNSUPPORTED_ATTRIBUTE',
        'Boolean HTML attributes are not part of the MVP allowlist',
        { attribute: name },
      );
    }
    index += 1;
    while (/\s/u.test(source[index] ?? '')) {
      index += 1;
    }
    const quote = source[index];
    let value: string;
    if (quote === '"' || quote === "'") {
      index += 1;
      const end = source.indexOf(quote, index);
      if (end < 0) {
        invalidHtml('HTML contains an unterminated attribute value');
      }
      value = source.slice(index, end);
      index = end + 1;
    } else {
      const valueMatch = /^[^\s"'=<>`]+/u.exec(source.slice(index));
      if (valueMatch === null) {
        invalidHtml('HTML contains an invalid unquoted attribute value');
      }
      value = valueMatch[0];
      index += valueMatch[0].length;
    }
    attrs.set(name, value);
  }

  return { attrs, selfClosing, tag };
}

function isInlineContainer(tag: string): boolean {
  return /^h[1-6]$/u.test(tag) || tag === 'p' || inlineTags.has(tag);
}

function isBlockChild(tag: string): boolean {
  return blockTags.has(tag);
}

function assertAllowedChild(parent: string, child: string): void {
  if (parent === '#root' || parent === 'blockquote' || parent === 'td' || parent === 'th') {
    if (!isBlockChild(child)) {
      invalidNesting(`Element <${child}> is not a block allowed inside <${parent}>`);
    }
    return;
  }
  if (parent === 'ul' || parent === 'ol') {
    if (child !== 'li') {
      invalidNesting('Lists may contain only list items');
    }
    return;
  }
  if (parent === 'li') {
    if (!isBlockChild(child)) {
      invalidNesting('List items must contain block nodes');
    }
    return;
  }
  if (parent === 'table') {
    if (!['tbody', 'tfoot', 'thead', 'tr'].includes(child)) {
      invalidNesting('Tables may contain only rows or table section wrappers');
    }
    return;
  }
  if (parent === 'tbody' || parent === 'tfoot' || parent === 'thead') {
    if (child !== 'tr') {
      invalidNesting('Table sections may contain only rows');
    }
    return;
  }
  if (parent === 'tr') {
    if (child !== 'td' && child !== 'th') {
      invalidNesting('Table rows may contain only cells');
    }
    return;
  }
  if (parent === 'pre') {
    if (child !== 'code') {
      invalidNesting('Code blocks may contain only a code wrapper');
    }
    return;
  }
  if (isInlineContainer(parent)) {
    if (!inlineTags.has(child)) {
      invalidNesting(`Block element <${child}> cannot occur inside inline content`);
    }
    return;
  }
  invalidNesting(`Element <${parent}> cannot contain child elements`);
}

function assertCompleteFrame(frame: SourceFrame): void {
  const { childTags, tag } = frame;
  if ((tag === 'ul' || tag === 'ol') && childTags.length === 0) {
    invalidNesting('Lists must contain at least one list item');
  }
  if (tag === 'li' && childTags[0] !== 'p') {
    invalidNesting('A list item must begin with a paragraph');
  }
  if ((tag === 'blockquote' || tag === 'td' || tag === 'th') && childTags.length === 0) {
    invalidNesting(`Element <${tag}> must contain at least one block`);
  }
  if (tag === 'tr' && childTags.length === 0) {
    invalidNesting('A table row must contain at least one cell');
  }
  if ((tag === 'tbody' || tag === 'tfoot' || tag === 'thead') && childTags.length === 0) {
    invalidNesting('A table section must contain at least one row');
  }
  if (
    tag === 'table' &&
    !childTags.some((child) => child === 'tr' || ['tbody', 'tfoot', 'thead'].includes(child))
  ) {
    invalidNesting('A table must contain at least one row');
  }
}

function validateSourceStructure(html: string, limits: ResourceLimits): void {
  const frames: SourceFrame[] = [{ tag: '#root', childTags: [], hasNonWhitespaceText: false }];
  let cursor = 0;

  while (cursor < html.length) {
    const open = html.indexOf('<', cursor);
    if (open < 0) {
      validateText(html.slice(cursor), frames);
      break;
    }
    validateText(html.slice(cursor, open), frames);
    const close = findTagEnd(html, open + 1);
    const source = html.slice(open + 1, close);
    if (/^\s*[!?]/u.test(source)) {
      invalidHtml('Comments, doctypes, and processing instructions are not supported');
    }
    const closingMatch = /^\s*\/\s*([a-z][a-z\d-]*)\s*$/iu.exec(source);
    if (closingMatch !== null) {
      const tag = closingMatch[1]?.toLowerCase();
      if (tag === undefined || voidTags.has(tag)) {
        invalidNesting('Void elements cannot have closing tags');
      }
      const frame = frames.pop();
      if (frame?.tag !== tag) {
        invalidNesting('HTML tags must be explicitly and correctly nested');
      }
      assertCompleteFrame(frame);
    } else {
      const parsed = parseStartTag(source);
      if (!allowedTags.has(parsed.tag)) {
        throw new AdapterValidationError(
          'UNSUPPORTED_ELEMENT',
          'HTML contains an element outside the MVP allowlist',
          { element: parsed.tag },
        );
      }
      const parent = frames.at(-1);
      if (parent === undefined) {
        invalidNesting('HTML has no document root');
      }
      const grandparent = frames.at(-2);
      if (parent.tag === 'code' && grandparent?.tag === 'pre') {
        invalidNesting('Code-block text cannot contain inline markup');
      }
      if (parsed.tag === 'a' && frames.some((frame) => frame.tag === 'a')) {
        invalidNesting('Links cannot be nested');
      }
      if (parsed.tag === 'span' && frames.some((frame) => frame.tag === 'span')) {
        throw new AdapterValidationError(
          'INVALID_TRACKING',
          'Inline diffChange marks cannot overlap',
        );
      }
      assertAllowedChild(parent.tag, parsed.tag);
      parent.childTags.push(parsed.tag);
      if (parsed.selfClosing && !voidTags.has(parsed.tag)) {
        invalidHtml('Only void MVP elements may use self-closing syntax');
      }
      if (!voidTags.has(parsed.tag)) {
        frames.push({ tag: parsed.tag, childTags: [], hasNonWhitespaceText: false });
        if (frames.length - 1 > limits.maxDepth) {
          throw new AdapterValidationError(
            'RESOURCE_LIMIT',
            'HTML nesting exceeds the configured maximum depth',
            { limit: limits.maxDepth, resource: 'maxDepth' },
          );
        }
      }
    }
    cursor = close + 1;
  }

  if (frames.length !== 1) {
    invalidNesting('HTML contains an unclosed element');
  }
  const root = frames[0];
  if (root === undefined || root.childTags.length === 0) {
    invalidNesting('A document must contain at least one block');
  }
}

function validateText(text: string, frames: SourceFrame[]): void {
  if (text.length === 0) {
    return;
  }
  const frame = frames.at(-1);
  if (frame === undefined) {
    invalidNesting('HTML text has no parent');
  }
  if (text.trim().length === 0) {
    return;
  }
  if (!isInlineContainer(frame.tag) && frame.tag !== 'pre') {
    invalidNesting(`Text is not allowed directly inside <${frame.tag}>`);
  }
  frame.hasNonWhitespaceText = true;
}

function allowedAttrsForTag(tag: string): ReadonlySet<string> {
  const attrs = new Set<string>();
  if (addressableTags.has(tag)) {
    attrs.add('data-block-id');
    attrs.add('data-diff-change-id');
    attrs.add('data-diff-change-kind');
  }
  if (tag === 'span') {
    attrs.add('data-diff-change-id');
    attrs.add('data-diff-change-kind');
  }
  if (tag === 'a') {
    attrs.add('href');
    attrs.add('title');
  }
  if (tag === 'ol') {
    attrs.add('start');
  }
  if (tag === 'pre') {
    attrs.add('data-language');
  }
  if (tag === 'td' || tag === 'th') {
    attrs.add('colspan');
    attrs.add('rowspan');
    attrs.add('data-colwidth');
  }
  return attrs;
}

function validateDom(document: Document, source: HtmlSource): void {
  const elements = [...document.body.querySelectorAll('*')];
  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (!allowedTags.has(tag)) {
      throw new AdapterValidationError(
        'UNSUPPORTED_ELEMENT',
        'HTML contains an element outside the MVP allowlist',
        { element: tag },
      );
    }
    const allowedAttrs = allowedAttrsForTag(tag);
    for (const attribute of [...element.attributes]) {
      if (!allowedAttrs.has(attribute.name)) {
        throw new AdapterValidationError(
          'UNSUPPORTED_ATTRIBUTE',
          'HTML contains an attribute outside the MVP allowlist',
          { attribute: attribute.name, element: tag },
        );
      }
      if (source === 'agent' && attribute.name === 'data-block-id') {
        throw new AdapterValidationError(
          'MODEL_SUPPLIED_ID',
          'Agent HTML cannot supply server-owned block IDs',
        );
      }
      if (
        source === 'agent' &&
        (attribute.name === 'data-diff-change-id' || attribute.name === 'data-diff-change-kind')
      ) {
        throw new AdapterValidationError(
          'UNSUPPORTED_ATTRIBUTE',
          'Agent HTML cannot create trusted change tracking',
          { attribute: attribute.name },
        );
      }
    }
    validateElementAttrs(element, tag, source);
  }
}

function validateElementAttrs(element: Element, tag: string, source: HtmlSource): void {
  if (tag === 'a') {
    const href = element.getAttribute('href');
    if (href === null || !isAllowedHref(href)) {
      throw new AdapterValidationError('UNSAFE_LINK', 'Link href is missing or unsafe');
    }
  }
  if (tag === 'ol') {
    assertPositiveIntegerAttr(element, 'start', false);
  }
  if (tag === 'td' || tag === 'th') {
    const colspan = assertPositiveIntegerAttr(element, 'colspan', false) ?? 1;
    assertPositiveIntegerAttr(element, 'rowspan', false);
    const rawWidths = element.getAttribute('data-colwidth');
    if (rawWidths !== null) {
      const widths = rawWidths.split(',');
      if (
        widths.length !== colspan ||
        !widths.every((width) => /^[1-9]\d*$/u.test(width) && Number.isSafeInteger(Number(width)))
      ) {
        throw new AdapterValidationError(
          'INVALID_HTML',
          'data-colwidth must contain one positive integer per spanned column',
        );
      }
    }
  }

  const blockId = element.getAttribute('data-block-id');
  const changeId = element.getAttribute('data-diff-change-id');
  const changeKind = element.getAttribute('data-diff-change-kind');
  if (source === 'review' && addressableTags.has(tag)) {
    if (blockId === null) {
      throw new AdapterValidationError(
        'MISSING_BLOCK_ID',
        'Review HTML requires a block ID on every addressable element',
        { element: tag },
      );
    }
    if (!isUuid(blockId)) {
      throw new AdapterValidationError('INVALID_BLOCK_ID', 'Review HTML block ID must be a UUID');
    }
  }
  if ((changeId === null) !== (changeKind === null)) {
    throw new AdapterValidationError(
      'INVALID_TRACKING',
      'Tracking ID and kind must be supplied together',
    );
  }
  if (changeId !== null) {
    if (changeId.length === 0) {
      throw new AdapterValidationError('INVALID_TRACKING', 'Tracking ID cannot be empty');
    }
    const allowed = tag === 'span' ? inlineDiffKinds : blockDiffKinds;
    if (changeKind === null || !allowed.has(changeKind as never)) {
      throw new AdapterValidationError('INVALID_TRACKING', 'Tracking kind is invalid');
    }
  }
  if (tag === 'span' && changeId === null) {
    throw new AdapterValidationError(
      'UNSUPPORTED_ELEMENT',
      'The MVP span element is reserved for inline change tracking',
    );
  }
}

function assertPositiveIntegerAttr(
  element: Element,
  name: string,
  required: boolean,
): number | undefined {
  const value = element.getAttribute(name);
  if (value === null) {
    if (required) {
      invalidHtml(`Attribute ${name} is required`);
    }
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    invalidHtml(`Attribute ${name} must be a positive integer`);
  }
  return Number(value);
}

function parseHtml(html: string, source: HtmlSource, options: HtmlParseOptions): ProseMirrorNode {
  const limits = resolveResourceLimits(options.limits);
  if (Buffer.byteLength(html, 'utf8') > limits.maxHtmlBytes) {
    throw new AdapterValidationError('RESOURCE_LIMIT', 'HTML exceeds the configured byte limit', {
      limit: limits.maxHtmlBytes,
      resource: 'maxHtmlBytes',
    });
  }
  validateSourceStructure(html, limits);

  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    contentType: 'text/html',
  });
  try {
    const document = dom.window.document;
    validateDom(document, source);
    const parsed = ProseMirrorDomParser.fromSchema(mvpSchema).parse(document.body, {
      preserveWhitespace: false,
    });
    const withIds = source === 'agent' ? assignBlockIds(parsed, options.idFactory, limits) : parsed;
    validateDocument(withIds, limits);
    return canonicalizeDocument(withIds, limits);
  } catch (error) {
    if (error instanceof AdapterValidationError) {
      throw error;
    }
    throw new AdapterValidationError(
      'INVALID_HTML',
      'HTML cannot be parsed losslessly',
      {},
      {
        cause: error,
      },
    );
  } finally {
    dom.window.close();
  }
}

/**
 * Parse untrusted agent HTML. Internal IDs and review attributes are rejected;
 * all addressable node IDs are generated by the supplied server-owned factory.
 */
export function parseAgentHtml(html: string, options: HtmlParseOptions = {}): ProseMirrorNode {
  return parseHtml(html, 'agent', options);
}

/**
 * Parse trusted persisted/review HTML. Every addressable block must already
 * carry a valid, unique UUID and tracking attributes are retained.
 */
export function parseReviewHtml(html: string, options: HtmlParseOptions = {}): ProseMirrorNode {
  return parseHtml(html, 'review', options);
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

function attrsToHtml(attrs: Readonly<Record<string, string>>): string {
  return Object.keys(attrs)
    .sort()
    .map((name) => ` ${name}="${escapeAttr(attrs[name] ?? '')}"`)
    .join('');
}

function trackedAttrs(
  node: ProseMirrorNode,
  mode: ProjectionMode,
  includeBlockIds: boolean,
): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (includeBlockIds) {
    attrs['data-block-id'] = String(readAttr(node.attrs, 'blockId'));
  }
  const changeId = readAttr(node.attrs, 'diffChangeId');
  if (mode === 'review' && typeof changeId === 'string') {
    attrs['data-diff-change-id'] = changeId;
    attrs['data-diff-change-kind'] = String(readAttr(node.attrs, 'diffChangeKind'));
  }
  return attrs;
}

function wrapMarks(node: ProseMirrorNode, content: string, mode: ProjectionMode): string {
  let result = content;
  for (let index = node.marks.length - 1; index >= 0; index -= 1) {
    const mark = node.marks[index];
    if (mark === undefined) {
      continue;
    }
    switch (mark.type.name) {
      case 'bold':
        result = `<strong>${result}</strong>`;
        break;
      case 'italic':
        result = `<em>${result}</em>`;
        break;
      case 'strike':
        result = `<s>${result}</s>`;
        break;
      case 'code':
        result = `<code>${result}</code>`;
        break;
      case 'link': {
        const attrs: Record<string, string> = { href: String(readAttr(mark.attrs, 'href')) };
        const title = readAttr(mark.attrs, 'title');
        if (typeof title === 'string') {
          attrs['title'] = title;
        }
        result = `<a${attrsToHtml(attrs)}>${result}</a>`;
        break;
      }
      case 'diffChange':
        if (mode === 'review') {
          result = `<span${attrsToHtml({
            'data-diff-change-id': String(readAttr(mark.attrs, 'changeId')),
            'data-diff-change-kind': String(readAttr(mark.attrs, 'kind')),
          })}>${result}</span>`;
        }
        break;
    }
  }
  return result;
}

function serializeChildren(
  node: ProseMirrorNode,
  mode: ProjectionMode,
  includeBlockIds: boolean,
): string {
  let result = '';
  for (let index = 0; index < node.childCount; index += 1) {
    result += serializeNode(node.child(index), mode, includeBlockIds);
  }
  return result;
}

function serializeNode(
  node: ProseMirrorNode,
  mode: ProjectionMode,
  includeBlockIds: boolean,
): string {
  if (node.isText) {
    return wrapMarks(node, escapeText(node.text ?? ''), mode);
  }
  if (node.type.name === 'hardBreak') {
    return wrapMarks(node, '<br>', mode);
  }
  if (node.type.name === 'doc') {
    return serializeChildren(node, mode, includeBlockIds);
  }

  const tracked = trackedAttrs(node, mode, includeBlockIds);
  const children = serializeChildren(node, mode, includeBlockIds);
  switch (node.type.name) {
    case 'paragraph':
      return `<p${attrsToHtml(tracked)}>${children}</p>`;
    case 'heading':
      return `<h${String(readAttr(node.attrs, 'level'))}${attrsToHtml(
        tracked,
      )}>${children}</h${String(readAttr(node.attrs, 'level'))}>`;
    case 'blockquote':
      return `<blockquote${attrsToHtml(tracked)}>${children}</blockquote>`;
    case 'bulletList':
      return `<ul${attrsToHtml(tracked)}>${children}</ul>`;
    case 'orderedList': {
      const attrs = { ...tracked };
      const start = readAttr(node.attrs, 'start');
      if (start !== 1) {
        attrs['start'] = String(start);
      }
      return `<ol${attrsToHtml(attrs)}>${children}</ol>`;
    }
    case 'listItem':
      return `<li${attrsToHtml(tracked)}>${children}</li>`;
    case 'codeBlock': {
      const attrs = { ...tracked };
      const language = readAttr(node.attrs, 'language');
      if (typeof language === 'string') {
        attrs['data-language'] = language;
      }
      return `<pre${attrsToHtml(attrs)}><code>${escapeText(node.textContent)}</code></pre>`;
    }
    case 'horizontalRule':
      return `<hr${attrsToHtml(tracked)}>`;
    case 'table':
      return `<table${attrsToHtml(tracked)}><tbody>${children}</tbody></table>`;
    case 'tableRow':
      return `<tr${attrsToHtml(tracked)}>${children}</tr>`;
    case 'tableHeader':
    case 'tableCell': {
      const attrs = { ...tracked };
      const colspan = readAttr(node.attrs, 'colspan');
      const rowspan = readAttr(node.attrs, 'rowspan');
      const colwidth = readAttr(node.attrs, 'colwidth');
      if (colspan !== 1) {
        attrs['colspan'] = String(colspan);
      }
      if (rowspan !== 1) {
        attrs['rowspan'] = String(rowspan);
      }
      if (Array.isArray(colwidth)) {
        attrs['data-colwidth'] = colwidth.join(',');
      }
      const tag = node.type.name === 'tableHeader' ? 'th' : 'td';
      return `<${tag}${attrsToHtml(attrs)}>${children}</${tag}>`;
    }
    default:
      throw new AdapterValidationError(
        'INVALID_DOCUMENT',
        'Cannot serialize an unsupported node type',
        { nodeType: node.type.name },
      );
  }
}

export function serializeHtml(
  document: ProseMirrorNode,
  options: HtmlSerializeOptions = {},
): string {
  const canonical = canonicalizeDocument(document);
  const mode = options.mode ?? 'review';
  const projected = projectDocument(canonical, mode, {
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.unresolvedCleanPolicy === undefined
      ? {}
      : { unresolvedCleanPolicy: options.unresolvedCleanPolicy }),
  });
  return serializeNode(projected, mode, options.includeBlockIds ?? true);
}
