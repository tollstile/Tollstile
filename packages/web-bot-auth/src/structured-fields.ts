import { decodeBase64, encodeBase64 } from './base64';

// RFC 8941 Structured Field Values, limited to what HTTP message signatures read: Dictionaries,
// Items, and Inner Lists. Parsing is strict: any deviation fails the whole field (§4.2).

export type BareItem =
  | { readonly type: 'integer'; readonly value: number }
  | { readonly type: 'decimal'; readonly value: number }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'token'; readonly value: string }
  | { readonly type: 'bytes'; readonly value: Uint8Array<ArrayBuffer> }
  | { readonly type: 'boolean'; readonly value: boolean };

export type Parameters = ReadonlyMap<string, BareItem>;
export type Item = { readonly kind: 'item'; readonly value: BareItem; readonly parameters: Parameters };
export type InnerList = { readonly kind: 'inner-list'; readonly items: readonly Item[]; readonly parameters: Parameters };
export type Member = Item | InnerList;
export type Dictionary = ReadonlyMap<string, Member>;

type Cursor = { readonly text: string; position: number };

const KEY_START = /[a-z*]/;
const KEY_CHAR = /[a-z0-9_\-.*]/;
const TOKEN_START = /[A-Za-z*]/;
const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/;
const DIGIT = /[0-9]/;

export function parseDictionary(text: string): Dictionary | undefined {
  const cursor: Cursor = { text, position: 0 };
  skipSpaces(cursor);
  const dictionary = new Map<string, Member>();
  while (cursor.position < text.length) {
    const key = parseKey(cursor);
    if (key === undefined) return undefined;
    let member: Member | undefined;
    if (peek(cursor) === '=') {
      cursor.position += 1;
      member = parseMember(cursor);
    } else {
      const parameters = parseParameters(cursor);
      member = parameters && { kind: 'item', value: { type: 'boolean', value: true }, parameters };
    }
    if (member === undefined) return undefined;
    dictionary.set(key, member);
    skipWhitespace(cursor);
    if (cursor.position === text.length) break;
    if (peek(cursor) !== ',') return undefined;
    cursor.position += 1;
    skipWhitespace(cursor);
    if (cursor.position === text.length) return undefined;
  }
  return dictionary;
}

export function parseItem(text: string): Item | undefined {
  const cursor: Cursor = { text, position: 0 };
  skipSpaces(cursor);
  const item = parseParameterizedItem(cursor);
  skipSpaces(cursor);
  return cursor.position === text.length ? item : undefined;
}

export function serializeMember(member: Member): string {
  if (member.kind === 'item') return serializeBareItem(member.value) + serializeParameters(member.parameters);
  return `(${member.items.map(serializeMember).join(' ')})${serializeParameters(member.parameters)}`;
}

function parseMember(cursor: Cursor): Member | undefined {
  if (peek(cursor) !== '(') return parseParameterizedItem(cursor);
  cursor.position += 1;
  const items: Item[] = [];
  for (;;) {
    skipSpaces(cursor);
    if (peek(cursor) === ')') {
      cursor.position += 1;
      const parameters = parseParameters(cursor);
      return parameters && { kind: 'inner-list', items, parameters };
    }
    const item = parseParameterizedItem(cursor);
    if (item === undefined) return undefined;
    items.push(item);
    const next = peek(cursor);
    if (next !== ' ' && next !== ')') return undefined;
  }
}

function parseParameterizedItem(cursor: Cursor): Item | undefined {
  const value = parseBareItem(cursor);
  const parameters = value && parseParameters(cursor);
  return value && parameters && { kind: 'item', value, parameters };
}

function parseParameters(cursor: Cursor): Parameters | undefined {
  const parameters = new Map<string, BareItem>();
  while (peek(cursor) === ';') {
    cursor.position += 1;
    skipSpaces(cursor);
    const key = parseKey(cursor);
    if (key === undefined) return undefined;
    let value: BareItem | undefined = { type: 'boolean', value: true };
    if (peek(cursor) === '=') {
      cursor.position += 1;
      value = parseBareItem(cursor);
    }
    if (value === undefined) return undefined;
    parameters.set(key, value);
  }
  return parameters;
}

function parseKey(cursor: Cursor): string | undefined {
  if (!KEY_START.test(peek(cursor))) return undefined;
  const start = cursor.position;
  while (KEY_CHAR.test(peek(cursor))) cursor.position += 1;
  return cursor.text.slice(start, cursor.position);
}

function parseBareItem(cursor: Cursor): BareItem | undefined {
  const first = peek(cursor);
  if (first === '-' || DIGIT.test(first)) return parseNumber(cursor);
  if (first === '"') return parseString(cursor);
  if (first === ':') return parseBytes(cursor);
  if (first === '?') return parseBoolean(cursor);
  if (TOKEN_START.test(first)) return parseToken(cursor);
  return undefined;
}

function parseNumber(cursor: Cursor): BareItem | undefined {
  const match = /^(-?)(\d{1,15})(?:\.(\d{1,3}))?/.exec(cursor.text.slice(cursor.position));
  if (match === null) return undefined;
  const [whole, , integer = '', fraction] = match;
  if (fraction !== undefined && integer.length > 12) return undefined;
  const next = cursor.text[cursor.position + whole.length];
  // A 16th integer digit or a fourth fraction digit is out of range, not the start of the next token.
  if (next !== undefined && (DIGIT.test(next) || (fraction === undefined && next === '.'))) return undefined;
  cursor.position += whole.length;
  return fraction === undefined ? { type: 'integer', value: Number(whole) } : { type: 'decimal', value: Number(whole) };
}

function parseString(cursor: Cursor): BareItem | undefined {
  cursor.position += 1;
  let value = '';
  while (cursor.position < cursor.text.length) {
    const character = cursor.text.charAt(cursor.position);
    cursor.position += 1;
    if (character === '"') return { type: 'string', value };
    if (character === '\\') {
      const escaped = cursor.text.charAt(cursor.position);
      if (escaped !== '"' && escaped !== '\\') return undefined;
      value += escaped;
      cursor.position += 1;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) return undefined;
    value += character;
  }
  return undefined;
}

function parseToken(cursor: Cursor): BareItem {
  const start = cursor.position;
  cursor.position += 1;
  while (TOKEN_CHAR.test(peek(cursor))) cursor.position += 1;
  return { type: 'token', value: cursor.text.slice(start, cursor.position) };
}

function parseBytes(cursor: Cursor): BareItem | undefined {
  const end = cursor.text.indexOf(':', cursor.position + 1);
  if (end === -1) return undefined;
  const value = decodeBase64(cursor.text.slice(cursor.position + 1, end));
  cursor.position = end + 1;
  return value && { type: 'bytes', value };
}

function parseBoolean(cursor: Cursor): BareItem | undefined {
  const digit = cursor.text.charAt(cursor.position + 1);
  if (digit !== '0' && digit !== '1') return undefined;
  cursor.position += 2;
  return { type: 'boolean', value: digit === '1' };
}

function serializeBareItem(item: BareItem): string {
  switch (item.type) {
    case 'integer':
      return item.value.toString();
    case 'decimal': {
      const rounded = Math.round(item.value * 1000) / 1000;
      return Number.isInteger(rounded) ? rounded.toFixed(1) : rounded.toString();
    }
    case 'string':
      return `"${item.value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
    case 'token':
      return item.value;
    case 'bytes':
      return `:${encodeBase64(item.value)}:`;
    case 'boolean':
      return item.value ? '?1' : '?0';
  }
}

function serializeParameters(parameters: Parameters): string {
  let serialized = '';
  for (const [key, value] of parameters) {
    serialized += value.type === 'boolean' && value.value ? `;${key}` : `;${key}=${serializeBareItem(value)}`;
  }
  return serialized;
}

function peek(cursor: Cursor): string {
  return cursor.text.charAt(cursor.position);
}

function skipSpaces(cursor: Cursor): void {
  while (peek(cursor) === ' ') cursor.position += 1;
}

function skipWhitespace(cursor: Cursor): void {
  while (peek(cursor) === ' ' || peek(cursor) === '\t') cursor.position += 1;
}
