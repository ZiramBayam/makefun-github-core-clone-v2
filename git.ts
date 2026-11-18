// Dependency-free git plumbing: object ids, trees, packfiles and pkt-lines. The forge stores real
// git objects so REST contents, GraphQL branch data and smart-HTTP clones all read the same bytes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const ZERO_OID = '0'.repeat(40);

export function sha1(bytes: Uint8Array | string): string {
  return createHash('sha1').update(bytes).digest('hex');
}

export function looseBytes(type: GitObjectType, data: Uint8Array): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return Buffer.concat([header, Buffer.from(data)]);
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  return sha1(looseBytes(type, data));
}

export function parseLoose(bytes: Uint8Array): GitObject {
  const buffer = Buffer.from(bytes);
  const space = buffer.indexOf(0x20);
  const nul = space < 0 ? -1 : buffer.indexOf(0x00, space + 1);
  if (space < 0 || nul < 0) throw new Error('bad loose object header');
  const type = buffer.subarray(0, space).toString('ascii') as GitObjectType;
  if (!(type in TYPE_CODES)) throw new Error(`unknown object type ${type}`);
  return { type, data: buffer.subarray(nul + 1) };
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(left, right);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : buffer.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > buffer.length) throw new Error('bad tree entry');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  headers: Array<[string, string]>;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const header = buffer.subarray(0, blank < 0 ? buffer.length : blank).toString('utf8');
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'), headers: [] };
  for (const line of header.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
    else view.headers.push([key, value]);
  }
  return view;
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const who = `${fields.author ?? 'GitHub Core Clone <forge@example.invalid>'} ${fields.timestamp ?? 0} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${fields.committer ?? who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const header = buffer.subarray(0, blank < 0 ? buffer.length : blank).toString('utf8');
  const map = new Map<string, string>();
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space >= 0) map.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: map.get('object') ?? '',
    type: map.get('type') ?? '',
    tag: map.get('tag') ?? '',
    tagger: map.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
}): Buffer {
  const tagger = `${fields.tagger ?? 'GitHub Core Clone <forge@example.invalid>'} ${fields.timestamp ?? 0} +0000`;
  return Buffer.from(`object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`, 'utf8');
}

/** Every object reachable from the roots. Missing objects throw unless allowMissing is set. */
export function reachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (allowMissing) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Commits from a tip back through first parents, limited by depth when given. */
export function commitChain(tip: string, lookup: (oid: string) => GitObject | undefined, depth?: number): string[] {
  const out: string[] = [];
  let current = tip;
  const limit = depth === undefined ? Number.POSITIVE_INFINITY : Math.max(0, depth);
  while (current && out.length < limit) {
    const object = lookup(current);
    if (!object || object.type !== 'commit') break;
    out.push(current);
    const parents = parseCommit(object.data).parents;
    current = parents[0] ?? '';
  }
  return out;
}

/** Objects needed for a set of commits, including their trees and blobs. */
export function objectsForCommits(
  commits: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  for (const oid of reachable(commits, lookup)) {
    const object = lookup(oid);
    if (object) out.set(oid, object);
  }
  return out;
}

// ---------------------------------------------------------------------------
// packfiles

function packHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 15);
  let remaining = Math.floor(size / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packHeader(TYPE_CODES[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

function readVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let byte = buffer[offset];
  let value = byte & 0x7f;
  let shift = 7;
  let next = offset + 1;
  while (byte & 0x80) {
    byte = buffer[next++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { value, next };
}

/** Find the end of a zlib stream by binary search, using the pack's declared uncompressed size. */
function inflateAt(buffer: Buffer, start: number, expectedSize: number): { data: Buffer; next: number } {
  let low = start + 1;
  let high = buffer.length;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    try {
      const data = inflateSync(buffer.subarray(start, middle));
      if (data.length === expectedSize) {
        found = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    } catch {
      low = middle + 1;
    }
  }
  if (found < 0) throw new Error('could not decode a pack object');
  return { data: inflateSync(buffer.subarray(start, found)), next: found };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const baseSize = readVarint(delta, offset);
  offset = baseSize.next;
  const resultSize = readVarint(delta, offset);
  offset = resultSize.next;
  if (baseSize.value !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) copyOffset |= delta[offset++] << (bit * 8);
      for (let bit = 0; bit < 3; bit += 1) if (op & (1 << (4 + bit))) copySize |= delta[offset++] << ((bit + 4) * 8);
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('reserved delta opcode');
    }
  }
  const result = Buffer.concat(parts);
  if (result.length !== resultSize.value) throw new Error('delta result size mismatch');
  return result;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

export function readPack(pack: Uint8Array, supplied: ReadonlyMap<string, GitObject> = new Map()): Map<string, GitObject> {
  const buffer = Buffer.from(pack);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  const raw: RawPackEntry[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    const first = buffer[offset++];
    const typeCode = (first >> 4) & 7;
    const sizeHeader = readVarint(buffer, offset - 1);
    let size = first & 15;
    let shift = 4;
    let byte = first;
    let cursor = offset;
    while (byte & 0x80) {
      byte = buffer[cursor++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    offset = sizeHeader.next;
    const entry: RawPackEntry = { offset: start, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readVarint(buffer, offset);
      entry.baseOffset = start - base.value;
      offset = base.next;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(buffer, offset, size);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
  }
  const objects = new Map<string, GitObject>(supplied);
  const byOffset = new Map(raw.map((entry) => [entry.offset, entry]));
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): GitObject => {
    const direct = CODE_TYPES[entry.typeCode];
    let type: GitObjectType;
    let data: Buffer;
    if (direct) {
      type = direct;
      data = entry.data;
    } else {
      if (resolving.has(entry.offset)) throw new Error('delta cycle');
      resolving.add(entry.offset);
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset ?? -1);
        if (!baseEntry) throw new Error('missing ofs-delta base');
        base = resolve(baseEntry);
      } else if (entry.typeCode === 7) {
        base = objects.get(entry.baseOid ?? '');
        if (!base) {
          const baseEntry = raw.find((candidate) => hashObject(candidate.typeCode === 6 ? 'blob' : (CODE_TYPES[candidate.typeCode] ?? 'blob'), candidate.data) === entry.baseOid);
          if (baseEntry) base = resolve(baseEntry);
        }
      }
      if (!base) throw new Error('missing delta base');
      type = base.type;
      data = applyDelta(base.data, entry.data);
      resolving.delete(entry.offset);
    }
    const object = { type, data };
    objects.set(hashObject(type, data), object);
    return object;
  };
  for (const entry of raw) resolve(entry);
  return objects;
}

// ---------------------------------------------------------------------------
// pkt-lines

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface PktLine {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(payload: Uint8Array | string): Buffer {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const length = bytes.length + 4;
  if (length > 65520) throw new Error('pkt-line too large');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), bytes]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function decodePktLines(buffer: Uint8Array): PktLine[] {
  const bytes = Buffer.from(buffer);
  const out: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const token = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(token)) break;
    const length = Number.parseInt(token, 16);
    offset += 4;
    if (length === 0) out.push({ kind: 'flush', payload: Buffer.alloc(0) });
    else if (length === 1) out.push({ kind: 'delim', payload: Buffer.alloc(0) });
    else if (length === 2) out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
    else {
      if (length > 65520 || offset + length - 4 > bytes.length) break;
      out.push({ kind: 'data', payload: bytes.subarray(offset, offset + length - 4) });
      offset += length - 4;
    }
  }
  return out;
}

/** Split a receive-pack request into its pkt-line prefix and the packfile that follows. */
export function splitPktPrefix(buffer: Uint8Array): { packets: PktLine[]; body: Buffer } {
  const bytes = Buffer.from(buffer);
  const packets: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const token = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(token)) break;
    const length = Number.parseInt(token, 16);
    offset += 4;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      break;
    }
    if (length === 1 || length === 2) continue;
    if (length > 65520 || offset + length - 4 > bytes.length) break;
    packets.push({ kind: 'data', payload: bytes.subarray(offset, offset + length - 4) });
    offset += length - 4;
  }
  return { packets, body: bytes.subarray(offset) };
}
