// Git smart HTTP surface: upload-pack (protocol v2 and v0) and receive-pack (v0). The suite speaks
// these with an in-process client; everything here is pkt-lines, packfiles and real git objects held
// in the same forge the REST, GraphQL and MCP surfaces use.

import type { ServerResponse } from 'node:http';
import { forge, type RepoRecord } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  commitChain,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  splitPktPrefix,
  writePack,
  type GitObject,
  type PktLine,
} from './git.ts';

const AGENT = 'github-core-forge/1.0';
const MAX_PKT_PAYLOAD = 65_515; // 1 sideband byte + 65,514 pack bytes, under pkt-line's 65,520 limit.

export interface GitRoute {
  readonly service: 'git-upload-pack' | 'git-receive-pack';
  readonly action: 'info-refs' | 'post';
  readonly owner: string;
  readonly name: string;
  readonly v2: boolean;
}

/** Match `/{owner}/{repo}.git/info/refs` or `/{owner}/{repo}.git/{service}`. */
export function parseGitRoute(pathname: string, headerProtocol: string | undefined): GitRoute | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (!match) return null;
  const [, owner, name, tail] = match as unknown as [string, string, string, string];
  const v2 = /(?:^|,)version=2(?:,|$)/i.test(headerProtocol ?? '') || /version=2/i.test(headerProtocol ?? '');
  if (tail === 'info/refs') {
    return { service: 'git-upload-pack', action: 'info-refs', owner, name, v2 };
  }
  const service = tail === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
  return { service, action: 'post', owner, name, v2: service === 'git-upload-pack' && v2 };
}

/** The service advertised on GET info/refs comes from the query string, not the path. */
export function serviceFromQuery(query: URLSearchParams): 'git-upload-pack' | 'git-receive-pack' {
  return query.get('service') === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendNotFound(res: ServerResponse): void {
  const body = Buffer.from(`${JSON.stringify({ message: 'Not Found' })}\n`, 'utf8');
  send(res, 404, 'application/json; charset=utf-8', body);
}

function contentTypeFor(route: GitRoute): string {
  return route.action === 'info-refs'
    ? `application/x-${route.service}-advertisement`
    : `application/x-${route.service}-result`;
}

function refList(repo: RepoRecord): Array<{ oid: string; name: string }> {
  const out: Array<{ oid: string; name: string }> = [];
  const tip = forge.resolveRef(repo, repo.defaultBranch);
  out.push({ oid: tip ?? ZERO_OID, name: 'HEAD' });
  for (const [name, oid] of repo.refs) out.push({ oid, name });
  const branch = `refs/heads/${repo.defaultBranch}`;
  if (tip && !repo.refs.has(branch)) out.push({ oid: tip, name: branch });
  return out;
}

function isEmptyRepo(repo: RepoRecord): boolean {
  if (repo.refs.size > 0) return false;
  return forge.resolveRef(repo, repo.defaultBranch) === null;
}

function capabilitiesV0(repo: RepoRecord, service: GitRoute['service']): string {
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (service === 'git-receive-pack') {
    return [
      'report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'quiet',
      symref, `agent=${AGENT}`, 'object-format=sha1',
    ].join(' ');
  }
  return [
    'multi_ack_detailed', 'no-done', 'side-band-64k', 'thin-pack', 'ofs-delta',
    'shallow', 'filter', symref, `agent=${AGENT}`, 'object-format=sha1',
  ].join(' ');
}

/** v0 advertisement: optional service preamble, refs (capabilities on the first line), flush. */
function advertisementV0(repo: RepoRecord, service: GitRoute['service']): Buffer {
  const caps = capabilitiesV0(repo, service);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (isEmptyRepo(repo)) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const refs = refList(repo);
    refs.forEach((ref, index) => {
      parts.push(pktLine(index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 upload-pack advertisement: service preamble, `version 2` and capability lines. */
function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ]);
}

/** The data payloads of a parsed pkt-line stream. A delim separates command metadata from arguments; both are useful. */
function commandLines(packets: readonly PktLine[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Find the `command=<name>` line in a v2 request (it may follow agent/object-format lines). */
function v2Command(packets: readonly PktLine[]): string {
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) return line.slice('command='.length);
    if (line === 'delim' || line === 'flush') break;
  }
  return '';
}

/** v2 `ls-refs`. Applies ref prefixes server-side, and peel/symrefs/unborn as requested. */
function handleLsRefs(repo: RepoRecord, packets: readonly PktLine[]): Buffer {
  const lines = commandLines(packets);
  const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const peel = lines.includes('peel');
  const symrefs = lines.includes('symrefs');
  const unborn = lines.includes('unborn');
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const parts: Buffer[] = [];
  const empty = isEmptyRepo(repo);
  if (empty && unborn && keep('HEAD')) {
    // Git advertises only the unborn HEAD, with its symref target — not a synthetic branch ref.
    parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  } else if (!empty) {
    for (const ref of refList(repo)) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (symrefs && ref.name === 'HEAD') line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      if (peel && ref.name.startsWith('refs/tags/')) {
        const object = repo.objects.get(ref.oid);
        if (object?.type === 'tag') line += ` peeled:${forge.peel(repo, ref.oid)}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface Selection {
  objects: GitObject[];
  shallow: string[];
}

/**
 * Reachable objects, but traversal stops at the client's shallow boundaries: a boundary itself is
 * held by the client, everything older than it is not. This is what makes `have third` safe when
 * deepening a clone that was shallow at `third`.
 */
function reachableStopping(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  boundaries: ReadonlySet<string>,
  allowMissing: boolean,
): Set<string> {
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
    if (boundaries.has(oid)) continue;
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

function selectObjects(
  repo: RepoRecord,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | undefined,
): Selection {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const boundaries = new Set(shallowBoundaries);
  const haveSet = new Set<string>();
  for (const have of haves) {
    for (const oid of reachableStopping([have], lookup, boundaries, true)) haveSet.add(oid);
  }
  const chosen = new Map<string, GitObject>();
  const add = (oid: string): void => {
    if (haveSet.has(oid)) return;
    const object = lookup(oid);
    if (object) chosen.set(oid, object);
  };
  const shallow: string[] = [];
  for (const want of wants) {
    if (depth === undefined) {
      for (const oid of reachableStopping([want], lookup, boundaries, false)) add(oid);
      continue;
    }
    // `deepen` deliberately walks past the client's shallow boundary; the boundary only limits
    // which of the client's `have` objects are assumed to carry their history.
    const chain: string[] = [];
    let current = want;
    while (current && chain.length < Math.max(0, depth)) {
      const object = lookup(current);
      if (!object || object.type !== 'commit') break;
      chain.push(current);
      current = parseCommit(object.data).parents[0] ?? '';
    }
    for (let index = 0; index < chain.length; index += 1) {
      const oid = chain[index]!;
      add(oid);
      const object = lookup(oid);
      if (object?.type === 'commit') {
        const commit = parseCommit(object.data);
        for (const treeOid of reachableStopping([commit.tree], lookup, boundaries, false)) add(treeOid);
        if (index === chain.length - 1 && commit.parents.length > 0) shallow.push(oid);
      }
    }
  }
  return { objects: [...chosen.values()], shallow };
}

function packPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += MAX_PKT_PAYLOAD) {
    const chunk: Uint8Array = pack.subarray(offset, offset + MAX_PKT_PAYLOAD);
    out.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(chunk)])));
  }
  return out;
}

function ackPackets(repo: RepoRecord, haves: readonly string[]): Buffer[] {
  const known = haves.filter((have) => repo.objects.has(have));
  if (known.length === 0) return [pktLine('NAK\n')];
  return known.map((have) => pktLine(`ACK ${have}\n`));
}

/** v2 `fetch`: acknowledgments, optional shallow-info, then a sideband-framed packfile section. */
function handleFetchV2(repo: RepoRecord, packets: readonly PktLine[]): Buffer {
  // A v2 fetch request puts command/agent before the delim and wants/haves/deepen after it, so
  // collect every data packet rather than stopping at the delimiter.
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const parsed = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(parsed)) depth = parsed;
    }
  }
  const selection = selectObjects(repo, wants, haves, shallowBoundaries, depth);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), ...ackPackets(repo, haves), PKT_FLUSH];
  if (selection.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...packPackets(writePack(selection.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v0 fetch report: plain ACK/NAK/shallow lines followed by sideband-framed pack data. */
function handleFetchV0(repo: RepoRecord, packets: readonly PktLine[]): Buffer {
  // The v0 body has a wants section, a flush, then a haves/done section. Reading all data packets
  // in order is enough: wants, haves, shallow and deepen lines all carry their own keyword.
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.split(/\s+/)[1] ?? '');
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const parsed = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(parsed)) depth = parsed;
    }
  }
  const selection = selectObjects(repo, wants, haves, shallowBoundaries, depth);
  const parts: Buffer[] = [...ackPackets(repo, haves)];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  parts.push(...packPackets(writePack(selection.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function isFastForward(repo: RepoRecord, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID || oldOid === newOid) return true;
  return commitChain(newOid, (oid) => repo.objects.get(oid)).includes(oldOid);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** v0 receive-pack: ingest the pack, then report one ok/ng line per ref. */
function handleReceivePack(repo: RepoRecord, body: Buffer): Buffer {
  const { packets, body: pack } = splitPktPrefix(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    if (nul >= 0) text = text.slice(0, nul);
    const fields = text.split(' ');
    if (fields.length < 3) continue;
    commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields.slice(2).join(' ') });
  }

  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, repo.objects);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: Buffer.from(object.data) });
      }
    } catch {
      unpackDetail = 'error';
    }
  }

  const report: string[] = [`unpack ${unpackDetail}\n`];
  for (const command of commands) {
    let reason = '';
    if (unpackDetail !== 'ok') {
      reason = 'unpack-error';
    } else if (command.newOid === ZERO_OID) {
      if (repo.refs.get(command.ref) === command.oldOid || !repo.refs.has(command.ref)) forge.deleteRef(repo, command.ref);
    } else if (!repo.objects.has(command.newOid)) {
      reason = 'missing-object';
    } else if (!isFastForward(repo, command.oldOid, command.newOid)) {
      reason = 'non-fast-forward';
    } else {
      forge.setRef(repo, command.ref, command.newOid);
    }
    report.push(reason === '' ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
  }

  // report-status pkt-lines carried inside sideband band 1.
  const parts: Buffer[] = [];
  for (const line of report) parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(line)])));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Dispatch one already-authenticated git request. Returns null when the path is not a git route. */
export function handleGit(
  route: GitRoute,
  res: ServerResponse,
  query: URLSearchParams,
  body: Buffer,
  method: string,
): void {
  const service = route.action === 'info-refs' ? serviceFromQuery(query) : route.service;
  if (service === 'git-receive-pack' && route.v2) {
    // receive-pack is v0 only; the client never asks for v2, but answer v0 if it does.
  }
  const repo = forge.getRepo(route.owner, route.name);
  if (!repo) {
    sendNotFound(res);
    return;
  }
  if (route.action === 'info-refs') {
    if (method !== 'GET') {
      sendNotFound(res);
      return;
    }
    const payload = service === 'git-upload-pack' && route.v2 ? advertisementV2() : advertisementV0(repo, service);
    send(res, 200, `application/x-${service}-advertisement`, payload);
    return;
  }
  if (method !== 'POST') {
    sendNotFound(res);
    return;
  }
  let payload: Buffer;
  try {
    if (service === 'git-receive-pack') {
      payload = handleReceivePack(repo, body);
    } else {
      const { packets } = splitPktPrefix(body);
      const command = route.v2 ? v2Command(packets) : '';
      if (route.v2 && command === 'ls-refs') payload = handleLsRefs(repo, packets);
      else if (route.v2 && command === 'fetch') payload = handleFetchV2(repo, packets);
      else payload = handleFetchV0(repo, packets);
    }
  } catch {
    // A malformed service body must not take the server down: answer a well-formed empty report.
    const line = service === 'git-receive-pack' ? 'unpack error\n' : 'NAK\n';
    payload = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), pktLine(line)])), PKT_FLUSH]);
  }
  send(res, 200, `application/x-${service}-result`, payload);
}
