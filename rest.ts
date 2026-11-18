// GitHub REST v3 surface. Every reply is JSON (or an empty 204 carrying a JSON content type),
// every reply carries a request id, and every repository is looked up under the token's login.

import type { IncomingMessage } from 'node:http';
import { forge, viewer, type Result } from './store.ts';

interface RestContext {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  origin: string;
  authorized: boolean;
}

function result(status: number, body: unknown = '', headers: Record<string, string> = {}): Result {
  return { status, body, headers };
}

function message(status: number, text: string): Result {
  return result(status, { message: text });
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repoOf(owner: string, name: string): Result | null {
  const repo = forge.getRepo(owner, name);
  return repo ? null : message(404, 'Not Found');
}

function pageNumber(query: URLSearchParams): number {
  const value = Number.parseInt(query.get('page') ?? '1', 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function perPage(query: URLSearchParams): number {
  const value = Number.parseInt(query.get('per_page') ?? '30', 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 100) : 30;
}

/** Dispatch one `/api/v3` request. The app supplies parsed JSON and auth state. */
export function handleRest(ctx: RestContext): Result {
  if (!ctx.authorized) return message(401, 'Requires authentication');
  const parts = segments(ctx.path);
  // parts[0] === 'api', parts[1] === 'v3'
  const route = parts.slice(2);

  if (route.length === 0 || (route.length === 1 && route[0] === '')) {
    return result(200, { current_user_url: `${ctx.origin}/api/v3/user`, repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}` });
  }
  if (route[0] === 'meta' && route.length === 1) {
    return result(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (route[0] === 'user' && route[1] === 'repos' && route.length === 2 && ctx.method === 'POST') {
    return forge.createRepo(ctx.body);
  }
  if (route[0] === 'user' && route[1] === 'repos' && route.length === 2 && ctx.method === 'GET') {
    const all = forge.listRepos();
    const size = perPage(ctx.query);
    const page = pageNumber(ctx.query);
    const start = (page - 1) * size;
    const items = all.slice(start, start + size).map((repo) => forge.repoJson(repo));
    const headers: Record<string, string> = {};
    if (start + size < all.length) {
      const next = new URL(`${ctx.origin}/api/v3/user/repos`);
      next.searchParams.set('per_page', String(size));
      next.searchParams.set('page', String(page + 1));
      headers.Link = `<${next.toString()}>; rel="next"`;
    }
    return result(200, items, headers);
  }
  if (route[0] === 'user' && route.length === 1 && ctx.method === 'GET') {
    return result(200, {
      id: viewer.id,
      login: viewer.login,
      name: viewer.name,
      email: viewer.email,
      type: 'User',
      html_url: `https://github.com/${viewer.login}`,
    });
  }
  if (route[0] !== 'repos' || route.length < 3) return message(404, 'Not Found');
  const owner = route[1]!;
  const name = route[2]!;
  const missing = repoOf(owner, name);
  if (missing) return missing;
  const repo = forge.getRepo(owner, name)!;
  const tail = route.slice(3);

  if (tail.length === 0) {
    if (ctx.method === 'GET') return result(200, forge.repoJson(repo));
    if (ctx.method === 'PATCH') {
      if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
      if (typeof ctx.body.default_branch === 'string' && ctx.body.default_branch) repo.defaultBranch = ctx.body.default_branch;
      return result(200, forge.repoJson(repo));
    }
    if (ctx.method === 'DELETE') {
      forge.deleteRepo(repo);
      return result(204, '');
    }
    return message(404, 'Not Found');
  }

  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2 && ctx.method === 'POST') {
    const ref = typeof ctx.body.ref === 'string' ? ctx.body.ref : '';
    const oidValue = isRecord(ctx.body.object) ? ctx.body.object.sha : ctx.body.sha;
    const sha = typeof oidValue === 'string' ? oidValue : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) return message(422, 'Invalid ref or sha');
    if (repo.refs.has(ref)) return message(422, 'Reference already exists');
    forge.setRef(repo, ref, sha);
    return result(201, { ref, object: { sha, type: 'commit' } });
  }

  if (tail[0] === 'branches' && tail.length === 1 && ctx.method === 'GET') {
    const branches = forge.listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } }));
    return result(200, branches);
  }

  if (tail[0] === 'commits' && tail.length === 1 && ctx.method === 'GET') {
    const ref = ctx.query.get('sha') ?? undefined;
    return result(200, forge.commitList(repo, ref));
  }

  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (!path) return message(404, 'Not Found');
    if (ctx.method === 'GET') return forge.contentJson(repo, path, ctx.query.get('ref') ?? undefined);
    if (ctx.method === 'PUT') {
      const content = typeof ctx.body.content === 'string' ? Buffer.from(ctx.body.content.replace(/\s+/g, ''), 'base64').toString('utf8') : '';
      const commitMessage = typeof ctx.body.message === 'string' ? ctx.body.message : 'Update file';
      const branch = typeof ctx.body.branch === 'string' ? ctx.body.branch : undefined;
      const sha = typeof ctx.body.sha === 'string' ? ctx.body.sha : undefined;
      return forge.putContent(repo, path, content, commitMessage, branch, sha);
    }
    if (ctx.method === 'DELETE') {
      const commitMessage = typeof ctx.body.message === 'string' ? ctx.body.message : 'Delete file';
      const sha = typeof ctx.body.sha === 'string' ? ctx.body.sha : undefined;
      return forge.deleteContent(repo, path, commitMessage, sha);
    }
    return message(404, 'Not Found');
  }

  if (tail[0] === 'labels' && tail.length === 1 && ctx.method === 'POST') {
    const name = typeof ctx.body.name === 'string' ? ctx.body.name : '';
    const color = typeof ctx.body.color === 'string' ? ctx.body.color : 'ededed';
    return forge.addLabel(repo, name, color);
  }

  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (ctx.method === 'POST') return forge.createIssue(repo, ctx.body);
      if (ctx.method === 'GET') return result(200, forge.listIssues(repo, ctx.query).map((issue) => forge.issueJson(repo, issue)));
    }
    const issueNumber = Number.parseInt(tail[1] ?? '', 10);
    if (Number.isFinite(issueNumber) && tail.length >= 2) {
      if (tail.length === 2) {
        if (ctx.method === 'GET') {
          const issue = forge.getIssue(repo, issueNumber);
          return issue ? result(200, forge.issueJson(repo, issue)) : message(404, 'Not Found');
        }
        if (ctx.method === 'PATCH') return forge.patchIssue(repo, issueNumber, ctx.body);
      }
      if (tail[2] === 'comments' && tail.length === 3) {
        if (ctx.method === 'POST') {
          return forge.addComment(repo, issueNumber, typeof ctx.body.body === 'string' ? ctx.body.body : '');
        }
        if (ctx.method === 'GET') {
          const issue = forge.getIssue(repo, issueNumber);
          if (!issue) return message(404, 'Not Found');
          return result(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: '2025-01-01T00:00:00Z' })));
        }
      }
    }
    return message(404, 'Not Found');
  }

  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (ctx.method === 'POST') return forge.createPull(repo, ctx.body);
      if (ctx.method === 'GET') return result(200, forge.listPulls(repo, ctx.query.get('state') ?? 'open').map((pull) => forge.pullJson(repo, pull)));
    }
    const pullNumber = Number.parseInt(tail[1] ?? '', 10);
    if (Number.isFinite(pullNumber) && tail.length >= 2) {
      if (tail.length === 2 && ctx.method === 'GET') {
        const pull = forge.getPull(repo, pullNumber);
        return pull ? result(200, forge.pullJson(repo, pull)) : message(404, 'Not Found');
      }
      if (tail[2] === 'files' && tail.length === 3 && ctx.method === 'GET') {
        const pull = forge.getPull(repo, pullNumber);
        return pull ? result(200, forge.pullFiles(repo, pull)) : message(404, 'Not Found');
      }
      if (tail[2] === 'merge' && tail.length === 3 && ctx.method === 'PUT') return forge.mergePull(repo, pullNumber);
    }
    return message(404, 'Not Found');
  }

  return message(404, 'Not Found');
}

export function restRequestId(sequence: number): string {
  return `req_${sequence.toString(16).padStart(12, '0')}`;
}

export function isJsonBodyRequest(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

export function asBody(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
