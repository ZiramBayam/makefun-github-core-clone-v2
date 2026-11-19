// One in-memory forge behind every surface. Repositories are created through REST; commits, refs,
// issues, pull requests and comments live here and are shared by REST, GraphQL, MCP and smart HTTP.

import { buildScenario, type Scenario } from './scenario.ts';
import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
} from './git.ts';

export interface UserRecord {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Set<string>;
  issues: IssueRecord[];
  pulls: PullRecord[];
  comments: Map<number, CommentRecord[]>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

export interface IssueRecord {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  created: number;
  comments: CommentRecord[];
}

export interface CommentRecord {
  id: number;
  body: string;
  created: number;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRecord {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  baseFiles: Map<string, string>;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  created: number;
}

export interface Result {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const scenario: Scenario = buildScenario();
export const viewer: UserRecord = {
  id: scenario.viewer.id,
  login: scenario.viewer.login,
  name: scenario.viewer.name,
  email: scenario.viewer.email,
};

function nowStamp(index: number): number {
  return 1_735_689_600 + index * 60;
}

export function encodeGlobal(type: string, id: number | string): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

export function decodeGlobal(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export class Forge {
  readonly repos = new Map<string, RepoRecord>();
  readonly seed: Scenario;
  private nextRepoId = 5000;
  private nextObjectId = 100000;
  private commitCounter = 0;

  constructor(seed: Scenario = scenario) {
    this.seed = seed;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRecord | null {
    if (owner !== viewer.login) return null;
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  createRepo(input: Record<string, unknown>): Result {
    const name = typeof input.name === 'string' ? input.name : '';
    if (!name) return { status: 422, body: { message: 'Repository name is required' } };
    if (this.getRepo(viewer.login, name)) return { status: 422, body: { message: 'Repository already exists' } };
    const repo: RepoRecord = {
      id: this.nextRepoId++,
      owner: viewer.login,
      name,
      description: typeof input.description === 'string' ? input.description : '',
      private: input.private !== false,
      defaultBranch: typeof input.default_branch === 'string' && input.default_branch ? input.default_branch : 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Set(),
      issues: [],
      pulls: [],
      comments: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.repos.set(this.key(repo.owner, repo.name), repo);
    return { status: 201, body: this.repoJson(repo) };
  }

  listRepos(): RepoRecord[] {
    return [...this.repos.values()].filter((repo) => repo.owner === viewer.login);
  }

  deleteRepo(repo: RepoRecord): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  repoJson(repo: RepoRecord): Record<string, unknown> {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: viewer.id, type: 'User' },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      has_issues: true,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: RepoRecord, type: GitObjectType, data: Uint8Array): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data: Buffer.from(data) });
    return oid;
  }

  resolveRef(repo: RepoRecord, name: string): string | null {
    if (!name || name === 'HEAD') name = `refs/heads/${repo.defaultBranch}`;
    if (/^[0-9a-f]{40}$/i.test(name)) return name.toLowerCase();
    const full = name.startsWith('refs/') ? name : `refs/heads/${name}`;
    return repo.refs.get(full) ?? repo.refs.get(name) ?? null;
  }

  setRef(repo: RepoRecord, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: RepoRecord, ref: string): void {
    repo.refs.delete(ref);
  }

  listBranches(repo: RepoRecord): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    if (!out.some((branch) => branch.name === repo.defaultBranch)) {
      const sha = this.resolveRef(repo, repo.defaultBranch);
      if (sha) out.unshift({ name: repo.defaultBranch, sha });
    }
    return out;
  }

  /** Flatten a tree into path -> blob oid. */
  treeFiles(repo: RepoRecord, treeOid: string, prefix = ''): Map<string, string> {
    const files = new Map<string, string>();
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return files;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        for (const [childPath, oid] of this.treeFiles(repo, entry.oid, path)) files.set(childPath, oid);
      } else if (entry.mode !== '160000') {
        files.set(path, entry.oid);
      }
    }
    return files;
  }

  filesAt(repo: RepoRecord, ref?: string): Map<string, string> {
    const commitOid = this.resolveRef(repo, ref ?? repo.defaultBranch);
    if (!commitOid) return new Map();
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return new Map();
    return this.treeFiles(repo, parseCommit(commit.data).tree);
  }

  blobText(repo: RepoRecord, oid: string): string {
    const object = repo.objects.get(oid);
    return object && object.type === 'blob' ? object.data.toString('utf8') : '';
  }

  private treeFromFiles(repo: RepoRecord, files: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of files) {
      const parts = path.split('/').filter(Boolean);
      let node = root;
      for (let index = 0; index < parts.length - 1; index += 1) {
        const name = parts[index]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(parts[parts.length - 1]!, oid);
    }
    const build = (node: Node): string => {
      const entries = [
        ...[...node.files].map(([name, oid]) => ({ mode: '100644', name, oid })),
        ...[...node.dirs].map(([name, child]) => ({ mode: '40000', name, oid: build(child) })),
      ];
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Commit a whole file map and move a branch; used by contents, merges and branches. */
  commitFiles(repo: RepoRecord, branch: string, files: Map<string, string>, message: string, parents: string[] = []): string {
    const tree = this.treeFromFiles(repo, files);
    this.commitCounter += 1;
    const data = buildCommit({
      tree,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: `${viewer.name} <${viewer.email}> ${nowStamp(this.commitCounter)} +0000`,
    });
    const oid = this.putObject(repo, 'commit', data);
    this.setRef(repo, branch.startsWith('refs/') ? branch : `refs/heads/${branch}`, oid);
    return oid;
  }

  commitList(repo: RepoRecord, ref?: string): Array<{ sha: string; commit: Record<string, unknown> }> {
    const tip = this.resolveRef(repo, ref ?? repo.defaultBranch);
    const out: Array<{ sha: string; commit: Record<string, unknown> }> = [];
    let current = tip;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') break;
      const parsed = parseCommit(object.data);
      out.push({ sha: current, commit: { message: parsed.message.trimEnd(), author: { name: viewer.name, email: viewer.email } } });
      current = parsed.parents[0] ?? null;
    }
    return out;
  }

  // ---------------------------------------------------------------- contents

  contentJson(repo: RepoRecord, path: string, ref?: string): Result {
    const files = this.filesAt(repo, ref);
    const oid = files.get(path);
    if (!oid) {
      const candidates = [...files.keys()].filter((candidate) => candidate.startsWith(`${path}/`));
      if (candidates.length === 0) return { status: 404, body: { message: 'Not Found' } };
      const root = this.treeFromFiles(repo, new Map(candidates.map((candidate) => [candidate.slice(path.length + 1), files.get(candidate)!])));
      return {
        status: 200,
        body: candidates.map((candidate) => {
          const relative = candidate.slice(path.length + 1);
          const name = relative.split('/')[0]!;
          const isDir = relative.includes('/');
          const prefix = `${path}/${name}`;
          const childOid = isDir
            ? this.treeFromFiles(repo, new Map(candidates.filter((item) => item.startsWith(`${prefix}/`)).map((item) => [item.slice(prefix.length + 1), files.get(item)!])))
            : files.get(prefix)!;
          return { type: isDir ? 'dir' : 'file', name, path: prefix, sha: childOid, size: isDir ? 0 : this.blobText(repo, childOid).length };
        }),
      };
    }
    const text = this.blobText(repo, oid);
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        size: Buffer.byteLength(text, 'utf8'),
        name: path.split('/').pop(),
        path,
        sha: oid,
        content: Buffer.from(text, 'utf8').toString('base64'),
      },
    };
  }

  putContent(repo: RepoRecord, path: string, content: string, message: string, branch?: string, sha?: string): Result {
    const target = branch && branch.startsWith('refs/') ? branch : `refs/heads/${branch ?? repo.defaultBranch}`;
    const files = this.filesAt(repo, branch ?? repo.defaultBranch);
    const existing = files.get(path);
    if (sha !== undefined && (!existing || existing !== sha.replace(/\s/g, ''))) {
      return { status: 409, body: { message: 'sha argument does not match the current file' } };
    }
    const blobOid = this.putObject(repo, 'blob', Buffer.from(content, 'utf8'));
    files.set(path, blobOid);
    const parent = this.resolveRef(repo, branch ?? repo.defaultBranch);
    const commit = this.commitFiles(repo, target, files, message, parent ? [parent] : []);
    return {
      status: existing ? 200 : 201,
      body: {
        content: { name: path.split('/').pop(), path, sha: blobOid, encoding: 'base64', size: Buffer.byteLength(content, 'utf8'), content: Buffer.from(content, 'utf8').toString('base64') },
        commit: { sha: commit, message },
      },
    };
  }

  deleteContent(repo: RepoRecord, path: string, message: string, sha?: string): Result {
    const files = this.filesAt(repo, repo.defaultBranch);
    const existing = files.get(path);
    if (!existing) return { status: 404, body: { message: 'Not Found' } };
    if (sha !== undefined && existing !== sha.replace(/\s/g, '')) return { status: 409, body: { message: 'sha argument does not match the current file' } };
    files.delete(path);
    const parent = this.resolveRef(repo, repo.defaultBranch);
    const commit = this.commitFiles(repo, repo.defaultBranch, files, message, parent ? [parent] : []);
    return { status: 200, body: { commit: { sha: commit, message } } };
  }

  // ---------------------------------------------------------------- issues

  addLabel(repo: RepoRecord, name: string, color: string): Result {
    if (!name) return { status: 422, body: { message: 'Label name is required' } };
    repo.labels.add(name);
    return { status: 201, body: { id: repo.labels.size, name, color, default: false } };
  }

  issueJson(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
      comments: issue.comments.length,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  createIssue(repo: RepoRecord, input: Record<string, unknown>): Result {
    const labels = Array.isArray(input.labels) ? input.labels.filter((item): item is string => typeof item === 'string') : [];
    const unknown = labels.find((label) => !repo.labels.has(label));
    if (unknown) return { status: 422, body: { message: `Label ${unknown} does not exist` } };
    const number = repo.nextIssue++;
    const issue: IssueRecord = {
      number,
      id: this.nextObjectId++,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [...new Set(labels)],
      created: repo.issues.length,
      comments: [],
    };
    repo.issues.push(issue);
    repo.comments.set(number, issue.comments);
    return { status: 201, body: this.issueJson(repo, issue) };
  }

  getIssue(repo: RepoRecord, number: number): IssueRecord | null {
    return repo.issues.find((issue) => issue.number === number) ?? null;
  }

  listIssues(repo: RepoRecord, query: URLSearchParams): IssueRecord[] {
    const state = query.get('state') ?? 'open';
    let issues = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
    const sort = query.get('sort');
    if (sort === 'created') {
      issues = [...issues].sort((a, b) => (a.created - b.created) * (query.get('direction') === 'desc' ? -1 : 1));
    }
    return issues;
  }

  patchIssue(repo: RepoRecord, number: number, input: Record<string, unknown>): Result {
    const issue = this.getIssue(repo, number);
    if (!issue) return { status: 404, body: { message: 'Not Found' } };
    if (typeof input.state === 'string') issue.state = input.state === 'closed' ? 'closed' : 'open';
    if (typeof input.title === 'string') issue.title = input.title;
    if (typeof input.body === 'string') issue.body = input.body;
    return { status: 200, body: this.issueJson(repo, issue) };
  }

  addComment(repo: RepoRecord, number: number, body: string): Result {
    const issue = this.getIssue(repo, number);
    if (!issue) return { status: 404, body: { message: 'Not Found' } };
    const comment: CommentRecord = { id: repo.nextComment++, body, created: issue.comments.length };
    issue.comments.push(comment);
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    return { status: 201, body: { id: comment.id, body: comment.body, created_at: '2025-01-01T00:00:00Z' } };
  }

  // ---------------------------------------------------------------- pull requests

  pullFiles(repo: RepoRecord, pull: PullRecord): PullFile[] {
    const base = pull.baseFiles;
    const head = this.filesAt(repo, `refs/heads/${pull.head}`);
    const out: PullFile[] = [];
    for (const path of new Set([...base.keys(), ...head.keys()])) {
      const before = base.get(path);
      const after = head.get(path);
      if (before === after) continue;
      const afterText = after ? this.blobText(repo, after) : '';
      const beforeText = before ? this.blobText(repo, before) : '';
      const additions = after ? afterText.split('\n').length : 0;
      const deletions = before ? beforeText.split('\n').length : 0;
      out.push({
        filename: path,
        status: !before ? 'added' : !after ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return out;
  }

  pullJson(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
    return {
      id: pull.id,
      number: pull.number,
      state: pull.state,
      title: pull.title,
      body: pull.body,
      head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
      base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    };
  }

  createPull(repo: RepoRecord, input: Record<string, unknown>): Result {
    const head = typeof input.head === 'string' ? input.head : '';
    const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
    const headSha = this.resolveRef(repo, head);
    const baseSha = this.resolveRef(repo, base);
    if (!headSha || !baseSha) return { status: 422, body: { message: 'The head or base branch does not exist' } };
    const number = repo.nextPull++;
    const pull: PullRecord = {
      number,
      id: this.nextObjectId++,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      baseFiles: this.filesAt(repo, base),
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      created: repo.pulls.length,
    };
    repo.pulls.push(pull);
    return { status: 201, body: this.pullJson(repo, pull) };
  }

  getPull(repo: RepoRecord, number: number): PullRecord | null {
    return repo.pulls.find((pull) => pull.number === number) ?? null;
  }

  listPulls(repo: RepoRecord, state: string): PullRecord[] {
    if (state === 'all') return [...repo.pulls];
    return repo.pulls.filter((pull) => pull.state === state);
  }

  mergePull(repo: RepoRecord, number: number): Result {
    const pull = this.getPull(repo, number);
    if (!pull) return { status: 404, body: { message: 'Not Found' } };
    if (pull.merged) return { status: 405, body: { message: 'Pull request is already merged' } };
    const currentBase = this.filesAt(repo, pull.base);
    const headFiles = this.filesAt(repo, `refs/heads/${pull.head}`);
    for (const [path, headOid] of headFiles) {
      const original = pull.baseFiles.get(path);
      const current = currentBase.get(path);
      if (original !== headOid && current !== undefined && current !== original && current !== headOid) {
        return { status: 405, body: { message: 'Pull request has conflicts' } };
      }
    }
    const merged = new Map(currentBase);
    for (const [path, oid] of headFiles) merged.set(path, oid);
    const parent = this.resolveRef(repo, pull.base);
    const sha = this.commitFiles(repo, pull.base, merged, `Merge pull request #${pull.number} from ${pull.head}`, parent ? [parent] : []);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = '2025-01-01T00:00:00Z';
    pull.mergeCommitSha = sha;
    return { status: 200, body: { sha, merged: true, message: `Squashed and merged pull request #${pull.number}` } };
  }

  findPullByHead(repo: RepoRecord, head: string): PullRecord | null {
    return [...repo.pulls].reverse().find((pull) => pull.head === head && pull.state === 'open') ?? null;
  }

  /** Used by the GraphQL fixture adapter: push one commit onto a branch. */
  pushFixtureBranch(repoName: string, branch: string, from: string | undefined, path: string, content: string, message: string): string | null {
    const repo = this.getRepo(viewer.login, repoName);
    if (!repo) return `repository ${viewer.login}/${repoName} does not exist`;
    const files = this.filesAt(repo, from ?? (this.resolveRef(repo, branch) ? branch : undefined));
    const blob = this.putObject(repo, 'blob', Buffer.from(content, 'utf8'));
    files.set(path, blob);
    const parent = this.resolveRef(repo, from ?? branch);
    this.commitFiles(repo, branch, files, message, parent ? [parent] : []);
    return null;
  }

  peel(repo: RepoRecord, oid: string): string {
    let current = oid;
    for (let index = 0; index < 8; index += 1) {
      const object = repo.objects.get(current);
      if (!object) return current;
      if (object.type === 'tag') current = parseTag(object.data).object;
      else return current;
    }
    return current;
  }

  headRef(repo: RepoRecord): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  emptyOid(): string {
    return ZERO_OID;
  }
}

export const forge = new Forge();
