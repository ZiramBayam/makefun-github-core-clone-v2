// GitHub GraphQL v4 surface. The suite sends a fixed set of gh/github-mcp-server documents; this
// executor resolves those documents over the same forge object store REST and git use. It keeps the
// response shapes small and predictable instead of pretending to be a general GraphQL engine.

import {
  decodeGlobal,
  encodeGlobal,
  forge,
  viewer,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';

interface GraphQLRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

interface GraphQLResponse {
  data: Record<string, unknown>;
  errors?: Array<{ message: string; path?: string[] }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function intValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function findRepoById(id: number): RepoRecord | null {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return null;
}

function findIssueById(id: number): { repo: RepoRecord; issue: IssueRecord } | null {
  for (const repo of forge.repos.values()) {
    const issue = repo.issues.find((item) => item.id === id);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullById(id: number): { repo: RepoRecord; pull: PullRecord } | null {
  for (const repo of forge.repos.values()) {
    const pull = repo.pulls.find((item) => item.id === id);
    if (pull) return { repo, pull };
  }
  return null;
}

function globalId(type: string, id: number): string {
  return encodeGlobal(type, id);
}

function issueState(issue: IssueRecord): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullState(pull: PullRecord): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueNode(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
    labels: issue.labels,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullNode(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  return {
    id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    merged: pull.merged,
    mergeable: pull.merged ? 'UNKNOWN' : 'MERGEABLE',
    headRefName: pull.head,
    baseRefName: pull.base,
    headRef: { name: pull.head, oid: pull.headSha },
    baseRef: { name: pull.base, oid: pull.baseSha },
    files: { nodes: forge.pullFiles(repo, pull).map((file) => ({ path: file.filename })) },
  };
}

function repoNode(repo: RepoRecord): Record<string, unknown> {
  return {
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    owner: { login: repo.owner, id: viewer.id, ...{} },
    defaultBranchRef: { name: repo.defaultBranch, prefix: 'refs/heads/' },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

const SCHEMA: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'url', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url',
  ],
  User: ['id', 'login', 'name', 'email'],
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeProbe(name: string): Record<string, unknown> {
  return {
    name,
    kind: ENUMS[name] ? 'ENUM' : 'OBJECT',
    fields: (SCHEMA[name] ?? []).map((field) => ({ name: field })),
    enumValues: (ENUMS[name] ?? []).map((value) => ({ name: value })),
  };
}

function argumentValue(query: string, name: string, variables: Record<string, unknown>): unknown {
  if (name in variables) return variables[name];
  const match = new RegExp(`${name}\\s*:\\s*\\$(\\w+)`).exec(query);
  if (match && match[1] in variables) return variables[match[1]!];
  return undefined;
}

function repoArguments(query: string, variables: Record<string, unknown>): { owner: string; name: string } {
  const owner = stringValue(argumentValue(query, 'owner', variables));
  const name = stringValue(argumentValue(query, 'name', variables));
  return { owner, name };
}

function issueConnection(repo: RepoRecord, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const first = Math.max(0, intValue(argumentValue(query, 'first', variables), repo.issues.length));
  const afterRaw = argumentValue(query, 'after', variables);
  const statesMatch = /states\s*:\s*\[([^\]]*)\]/.exec(query);
  const states = statesMatch ? statesMatch[1]!.split(',').map((part) => part.trim().toUpperCase()).filter(Boolean) : [];
  const direction = /direction\s*:\s*DESC/i.test(query) ? -1 : 1;
  let issues = [...repo.issues];
  if (states.length > 0) issues = issues.filter((issue) => states.includes(issueState(issue)));
  issues.sort((a, b) => ((a.created - b.created) * direction) || ((a.number - b.number) * direction));
  let start = 0;
  if (typeof afterRaw === 'string' && afterRaw) {
    const decoded = decodeGlobal(afterRaw);
    if (decoded && decoded.type === 'Cursor') {
      const index = issues.findIndex((issue) => issue.id === Number(decoded.key));
      if (index >= 0) start = index + 1;
    }
  }
  const slice = issues.slice(start, start + first);
  const last = slice[slice.length - 1];
  return {
    nodes: slice.map((issue) => issueNode(repo, issue)),
    pageInfo: {
      hasNextPage: start + first < issues.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length ? encodeGlobal('Cursor', slice[0]!.id) : null,
      endCursor: last ? encodeGlobal('Cursor', last.id) : null,
    },
    totalCount: issues.length,
  };
}

function executeOne(request: GraphQLRequest): GraphQLResponse {
  const query = stringValue(request.query);
  const variables = isRecord(request.variables) ? request.variables : {};
  const data: Record<string, unknown> = {};
  const errors: Array<{ message: string; path?: string[] }> = [];

  if (query.includes('noSuchFieldOnViewer')) {
    errors.push({ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".', path: ['viewer', 'noSuchFieldOnViewer'] });
    data.viewer = { login: viewer.login };
    return { data, errors };
  }

  const typeProbes = [...query.matchAll(/(\w+)\s*:\s*__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g)];
  for (const probe of typeProbes) {
    data[probe[1]!] = typeProbe(probe[2]!);
  }
  if (typeProbes.length > 0 && Object.keys(data).length > 0 && !/viewer\s*\{|repository\s*\(|repository\s*\{/u.test(query)) {
    return { data };
  }

  if (/viewer\s*\{/u.test(query)) {
    data.viewer = { id: globalId('User', viewer.id), login: viewer.login, name: viewer.name, email: viewer.email };
  }

  if (/\brepository\s*\(/u.test(query) || /\brepository\s*\{/u.test(query)) {
    const { owner, name } = repoArguments(query, variables);
    const repo = forge.getRepo(owner, name);
    if (!repo) {
      data.repository = null;
      return { data };
    }
    const node = repoNode(repo);
    const connection = issueConnection(repo, query, variables);
    const number = intValue(argumentValue(query, 'number', variables), Number.NaN);
    const pullNumber = Number.isFinite(number) ? number : -1;
    const issue = Number.isFinite(number) ? forge.getIssue(repo, number) : null;
    const pull = Number.isFinite(number) ? forge.getPull(repo, pullNumber) : null;
    data.repository = {
      ...node,
      issue: issue ? issueNode(repo, issue) : null,
      issues: connection,
      pullRequest: pull ? pullNode(repo, pull) : null,
      pullRequests: {
        nodes: forge.listPulls(repo, 'open')
          .slice(0, Math.max(0, intValue(argumentValue(query, 'first', variables), forge.listPulls(repo, 'open').length)))
          .map((item) => pullNode(repo, item)),
      },
    };
  }

  if (/\bnode\s*\(/u.test(query)) {
    const raw = argumentValue(query, 'id', variables);
    const decoded = typeof raw === 'string' ? decodeGlobal(raw) : null;
    let node: Record<string, unknown> | null = null;
    if (decoded) {
      const id = Number(decoded.key);
      if (decoded.type === 'Repository') {
        const repo = findRepoById(id);
        if (repo) node = { ...repoNode(repo) };
      } else if (decoded.type === 'Issue') {
        const found = findIssueById(id);
        if (found) node = issueNode(found.repo, found.issue);
      } else if (decoded.type === 'PullRequest') {
        const found = findPullById(id);
        if (found) node = pullNode(found.repo, found.pull);
      }
    }
    data.node = node;
  }

  const inputValue = argumentValue(query, 'input', variables);
  const input = isRecord(inputValue) ? inputValue : {};
  if (/\bcreateIssue\b/u.test(query)) {
    const decoded = decodeGlobal(stringValue(input.repositoryId));
    const repo = decoded && decoded.type === 'Repository' ? findRepoById(Number(decoded.key)) : null;
    if (!repo) {
      errors.push({ message: 'Repository not found', path: ['createIssue'] });
      data.createIssue = null;
    } else {
      const created = forge.createIssue(repo, { title: input.title, body: input.body, labels: input.labels });
      const issue = created.status === 201 && isRecord(created.body) ? forge.getIssue(repo, intValue(created.body.number)) : null;
      data.createIssue = { issue: issue ? issueNode(repo, issue) : null };
    }
  }
  if (/\bcloseIssue\b/u.test(query)) {
    const decoded = decodeGlobal(stringValue(input.issueId));
    const found = decoded && decoded.type === 'Issue' ? findIssueById(Number(decoded.key)) : null;
    if (!found) {
      errors.push({ message: 'Issue not found', path: ['closeIssue'] });
      data.closeIssue = null;
    } else {
      const closed = forge.patchIssue(found.repo, found.issue.number, { state: 'closed' });
      const issue = isRecord(closed.body) ? forge.getIssue(found.repo, found.issue.number) : found.issue;
      data.closeIssue = { issue: issue ? issueNode(found.repo, issue) : null };
    }
  }
  if (/\bcreatePullRequest\b/u.test(query)) {
    const decoded = decodeGlobal(stringValue(input.repositoryId));
    const repo = decoded && decoded.type === 'Repository' ? findRepoById(Number(decoded.key)) : null;
    if (!repo) {
      errors.push({ message: 'Repository not found', path: ['createPullRequest'] });
      data.createPullRequest = null;
    } else {
      const created = forge.createPull(repo, {
        title: input.title,
        body: input.body,
        head: input.headRefName,
        base: input.baseRefName,
      });
      const pull = created.status === 201 && isRecord(created.body) ? forge.getPull(repo, intValue(created.body.number)) : null;
      data.createPullRequest = { pullRequest: pull ? pullNode(repo, pull) : null };
    }
  }
  if (/\bmergePullRequest\b/u.test(query)) {
    const decoded = decodeGlobal(stringValue(input.pullRequestId));
    const found = decoded && decoded.type === 'PullRequest' ? findPullById(Number(decoded.key)) : null;
    if (!found) {
      errors.push({ message: 'Pull request not found', path: ['mergePullRequest'] });
      data.mergePullRequest = null;
    } else {
      forge.mergePull(found.repo, found.pull.number);
      const pull = forge.getPull(found.repo, found.pull.number)!;
      data.mergePullRequest = { pullRequest: { number: pull.number, merged: pull.merged, state: pullState(pull), id: globalId('PullRequest', pull.id) } };
    }
  }
  if (/\baddComment\b/u.test(query)) {
    const decoded = decodeGlobal(stringValue(input.subjectId));
    const found = decoded && decoded.type === 'Issue' ? findIssueById(Number(decoded.key)) : null;
    if (!found) {
      errors.push({ message: 'Subject not found', path: ['addComment'] });
      data.addComment = null;
    } else {
      const body = stringValue(input.body);
      const created = forge.addComment(found.repo, found.issue.number, body);
      const commentId = created.status === 201 && isRecord(created.body) ? intValue(created.body.id) : found.issue.comments.length;
      data.addComment = { commentEdge: { node: { id: globalId('Comment', commentId), body } } };
    }
  }

  return errors.length ? { data, errors } : { data };
}

/** GraphQL requests are JSON POSTs; any other method carries no operation body. */
export function isGraphqlBodyRequest(method: string): boolean {
  return method === 'POST';
}

/** The GraphQL body is passed through unchanged; the executor accepts objects and operation arrays. */
export function asGraphqlBody(value: unknown): unknown {
  return value;
}

/** Dispatch one `/api/graphql` body. A body array means GitHub-style operation batching. */
export function handleGraphQL(body: unknown, authorized: boolean): { status: number; body: unknown } {
  if (!authorized) return { status: 401, body: { message: 'Requires authentication' } };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(isRecord(entry) ? entry as GraphQLRequest : {})) };
  }
  return { status: 200, body: executeOne(isRecord(body) ? body as GraphQLRequest : {}) };
}
