// Deterministic reproduction of the competition's seeded scenario. The checks and this forge
// derive every name, path, blob and message from SCENARIO_SEED alone, so no clock or randomness is
// involved. Kept deliberately dependency-free so node's TypeScript stripping can run it directly.

export const SEED = 0x6a09e667f3bcc909n;
export const MASK = 0xffffffffffffffffn;
const EPOCH = 1_735_689_600;

const FIRST_NAMES = ['ada','bram','cora','dmitri','elena','felix','greta','hugo','iris','jonas','kira','lars','mira','nico','olga','pavel','quinn','rosa','sven','tess','ulla','vito','wren','yara','zane'];
const LAST_NAMES = ['anders','bauer','costa','dahl','eriksen','fischer','garcia','holm','iversen','jansen','keller','lind','moreau','novak','olsen','peters','quist','rossi','sato','turi','ulrich','vega','weber','xu','yilmaz','zimmer'];
const ADJECTIVES = ['amber','brisk','calm','crisp','eager','faint','gentle','happy','idle','jolly','keen','lively','mellow','nimble','open','plain','quick','quiet','rapid','soft','steady','tidy','upbeat','vivid','warm','witty','young','zesty'];
const NOUNS = ['acorn','badger','canyon','cedar','comet','coral','delta','ember','falcon','glade','harbor','indigo','juniper','kettle','lantern','meadow','nebula','orchid','pebble','quartz','raven','saffron','thistle','umber','violet','willow','yarrow','zephyr'];
const DESCRIPTIONS = ['a small service with a sharp edge','notes and experiments, kept until they are not','the tooling behind the thing','a reference implementation, for reading','what the prototype became','fixtures, generators and the odd benchmark','the parts that must not break','a sandbox for the next idea'];
const PATH_SEGMENTS = ['src','lib','docs','test','scripts','api','core','util','config','data','web','cli','pkg','internal','examples','assets','build','tools','server','client'];
const FILE_STEMS = ['index','request','response','server','client','schema','parser','router','config','store','clock','queue','render','format','validate','session','token','event','stream','cache'];
const FILE_EXTS = ['ts','js','json','md','txt','yml','toml','css','html','sql'];
const BLOB_WORDS = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet','kilo','lima','mike','november','oscar','papa','quebec','romeo','sierra','tango','uniform','victor','whiskey','xray','yankee','zulu','amber','basalt','cobalt','drift','ember','frost','granite','hollow','ivory','jasper','kelp','lichen','moss','nickel'];
const COMMIT_VERBS = ['Add','Fix','Refactor','Document','Test','Tidy','Speed up','Simplify','Handle','Extract','Inline','Rename','Guard','Wire','Drop'];
const COMMIT_OBJECTS = ['the request parser','repo lookup','issue pagination','the merge path','token checks','the clone endpoint','packfile handling','error bodies','branch listing','the GraphQL node query','MCP tool dispatch','rate limit headers','the upload pack','the ref advertisement','commit ancestry'];
const ISSUE_ADJECTIVES = ['Broken','Slow','Missing','Confusing','Unexpected','Flaky','Incorrect','Unclear','Stale','Noisy'];
const ISSUE_SUBJECTS = ['clone over HTTP','push report-status','issue pagination','merge button','GraphQL node ids','MCP tool list','shallow fetch','tag listing','repo creation','content update','branch deletion','commit listing'];
const PULL_VERBS = ['Add','Fix','Improve','Simplify','Document','Refactor','Speed up','Harden'];
const PULL_SUBJECTS = ['shallow fetch support','push report status checks','issue label validation','merge conflict detection','GraphQL cursor pagination','MCP tool schemas','packfile delta reuse','conditional requests','repo pagination','branch protection stubs'];
const SENTENCE_STARTS = ['Steps to reproduce are below','This showed up after the last change','The expected behaviour is clear','A minimal case is attached','It works on a fresh repository','The same flow works over the API'];
const SENTENCE_ENDS = ['and the server answers with a JSON error','but the second request fails','and nothing is written to the log','while the reply body stays empty','and the status is wrong for the method','so the client gives up'];
const ISSUE_LABELS = ['bug','enhancement','documentation','question','good first issue','help wanted'];
const DEFAULT_BRANCHES = ['main','develop','release/1.0'];
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function fnv1a64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) h = ((h ^ BigInt(s.charCodeAt(i))) * 0x100000001b3n) & MASK;
  return h;
}
function mix64(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}
class Rng {
  state: bigint;
  constructor(seed: bigint) {
    const m = seed & MASK;
    this.state = m === 0n ? SEED : m;
  }
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & MASK;
    x = (x ^ (x << 25n)) & MASK;
    x = (x ^ (x >> 27n)) & MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK;
  }
  nextU32(): number { return Number(this.nextU64() >> 32n); }
  nextInt(max: number): number {
    const range = 4294967296;
    const limit = range - (range % max);
    for (;;) { const v = this.nextU32(); if (v < limit) return v % max; }
  }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)]!; }
  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) { const j = this.nextInt(i + 1); const s = copy[i]!; copy[i] = copy[j]!; copy[j] = s; }
    return copy;
  }
  chance(p: number): boolean { return this.nextU32() / 4294967296 < p; }
  hex(n: number): string { let out = ''; while (out.length < n) out += '0123456789abcdef'[this.nextInt(16)]; return out; }
}
function rng(label: string): Rng { return new Rng(mix64(SEED ^ fnv1a64(label))); }

function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0, b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0;
    const t = (b0 << 16) | (b1 << 8) | b2;
    out += B64[(t >> 18) & 63]; out += B64[(t >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(t >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[t & 63] : '=';
  }
  return out;
}
export function textToBase64(text: string): string { return base64(new TextEncoder().encode(text)); }
export function base64ToText(value: string): string {
  const clean = value.replace(/\s/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i] ?? '='), b = B64.indexOf(clean[i + 1] ?? '='), c = B64.indexOf(clean[i + 2] ?? '='), d = B64.indexOf(clean[i + 3] ?? '=');
    bytes.push(((a << 2) | (b >> 4)) & 255);
    if (c >= 0) bytes.push(((b << 4) | (c >> 2)) & 255);
    if (d >= 0) bytes.push(((c << 6) | d) & 255);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

interface User { id: number; login: string; name: string; email: string; }
interface Repo { id: number; owner: string; name: string; fullName: string; description: string; private: boolean; defaultBranch: string; }
interface Blob { path: string; content: string; base64: string; }
interface Commit { message: string; author: User; epochSec: number; iso: string; }
interface Issue { title: string; body: string; labels: string[]; }
interface Pull { title: string; body: string; head: string; base: string; }

export interface Scenario {
  seed: string; viewer: User; teammate: User; stranger: User; users: User[];
  org: string; repos: Repo[]; orgRepos: Repo[]; strangerRepos: Repo[];
  labels: string[]; branches: string[]; filePaths: string[]; blobs: Blob[];
  commits: Commit[]; issues: Issue[]; pulls: Pull[];
}

function users(r: Rng, count: number): User[] {
  const used = new Set<string>(); const out: User[] = [];
  for (let i = 0; i < count; i++) {
    const first = r.pick(FIRST_NAMES), last = r.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base, suffix = 2;
    while (used.has(login)) login = `${base}-${suffix++}`;
    used.add(login);
    out.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return out;
}
function repos(r: Rng, owner: string, count: number, firstId: number): Repo[] {
  const used = new Set<string>(); const out: Repo[] = [];
  for (let i = 0; i < count; i++) {
    const base = `${r.pick(ADJECTIVES)}-${r.pick(NOUNS)}`;
    let name = base, suffix = 2;
    while (used.has(name)) name = `${base}-${suffix++}`;
    used.add(name);
    out.push({ id: firstId + i, owner, name, fullName: `${owner}/${name}`, description: r.pick(DESCRIPTIONS), private: i % 7 === 3, defaultBranch: 'main' });
  }
  return out;
}
function paths(r: Rng, count: number): string[] {
  const used = new Set<string>(); const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const depth = r.nextInt(3) === 0 ? 0 : 1 + r.nextInt(2);
    const dirs = depth === 0 ? [] : r.shuffle(PATH_SEGMENTS).slice(0, depth);
    const base = [...dirs, `${r.pick(FILE_STEMS)}.${r.pick(FILE_EXTS)}`].join('/');
    let path = base, suffix = 2;
    while (used.has(path)) { path = [...dirs, `${suffix}-${base.split('/').pop()}`].join('/'); suffix++; }
    used.add(path); out.push(path);
  }
  return out;
}
function blobText(r: Rng, size: number): string {
  let out = '';
  while (out.length < size) { out += r.pick(BLOB_WORDS); if (out.length < size) out += r.chance(0.14) ? '\n' : ' '; }
  return out.slice(0, size);
}
function sentence(r: Rng): string { return `${r.pick(SENTENCE_STARTS)} ${r.pick(SENTENCE_ENDS)}.`; }
function body(r: Rng): string { const n = 1 + r.nextInt(3); const out: string[] = []; for (let i = 0; i < n; i++) out.push(sentence(r)); return out.join(' '); }
function branchName(r: Rng): string {
  const kind = r.pick(['feature', 'fix', 'perf', 'docs', 'chore']);
  const subject = r.pick(PULL_SUBJECTS).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${kind}/${subject}`;
}

let cached: Scenario | null = null;
export function buildScenario(): Scenario {
  if (cached) return cached;
  const allUsers = users(rng('users'), 12);
  const viewer = allUsers[0]!, teammate = allUsers[1]!, stranger = allUsers[2]!;
  const orgR = rng('org');
  const org = `${orgR.pick(ADJECTIVES)}-${orgR.pick(NOUNS)}-org`;
  const branchR = rng('branches');
  const branchSet = new Set(DEFAULT_BRANCHES);
  for (let i = 0; i < 8; i++) {
    let b = branchName(branchR), suffix = 2;
    while (branchSet.has(b)) { b = `${branchName(branchR)}-${suffix++}`; }
    branchSet.add(b);
  }
  const filePaths = paths(rng('paths'), 60);
  const blobR = rng('blobs');
  const blobs: Blob[] = filePaths.slice(0, 24).map((path) => {
    const content = blobText(blobR, 64 + blobR.nextInt(4033));
    return { path, content, base64: textToBase64(content) };
  });
  const commitR = rng('commits');
  const commits: Commit[] = [];
  for (let i = 0; i < 60; i++) {
    const msgHead = `${commitR.pick(COMMIT_VERBS)} ${commitR.pick(COMMIT_OBJECTS)}`;
    const message = commitR.chance(0.35) ? `${msgHead}\n\n${sentence(commitR)}` : msgHead;
    const epochSec = EPOCH + commitR.nextInt(90 * 24 * 60 * 60);
    commits.push({ message, author: commitR.pick(allUsers), epochSec, iso: new Date(epochSec * 1000).toISOString() });
  }
  const issueR = rng('issues');
  const issues: Issue[] = [];
  for (let i = 0; i < 60; i++) issues.push({ title: `${issueR.pick(ISSUE_ADJECTIVES)} ${issueR.pick(ISSUE_SUBJECTS)}`, body: body(issueR), labels: issueR.chance(0.5) ? [issueR.pick(ISSUE_LABELS)] : [] });
  const pullR = rng('pulls');
  const pulls: Pull[] = [];
  for (let i = 0; i < 30; i++) pulls.push({ title: `${pullR.pick(PULL_VERBS)} ${pullR.pick(PULL_SUBJECTS)}`, body: body(pullR), head: branchName(pullR), base: 'main' });
  cached = {
    seed: '6a09e667f3bcc909', viewer, teammate, stranger, users: allUsers, org,
    repos: repos(rng('repos.viewer'), viewer.login, 30, 5000),
    orgRepos: repos(rng('repos.org'), org, 6, 6000),
    strangerRepos: repos(rng('repos.stranger'), stranger.login, 3, 7000),
    labels: ISSUE_LABELS, branches: [...branchSet], filePaths, blobs, commits, issues, pulls,
  };
  return cached;
}
