// Model Context Protocol surface. The suite speaks Streamable HTTP at /mcp with JSON-RPC 2.0.
// This implementation serves the current 2026-07-28 revision (discover, no handshake) and also
// answers the older initialize handshake, so either client negotiation path works.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { forge, viewer, type RepoRecord } from './store.ts';

const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_REVISIONS = [
  PREFERRED_REVISION,
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
const SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' } as const;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_PARSE_ERROR = -32700;

type JsonRpcId = string | number | null;

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, names: readonly string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string') return value;
  }
  return '';
}

function numberArg(args: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

function boolArg(args: Record<string, unknown>, names: readonly string[]): boolean | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

const property = (description: string, type: 'string' | 'boolean' | 'integer' = 'string'): Record<string, unknown> => ({ type, description });

// Stable order and stable fields: tools/list is compared byte for byte between two calls.
const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a new repository in the forge and return its canonical JSON object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: property('Repository name'),
        description: property('Repository description'),
        private: property('Whether the repository is private', 'boolean'),
        owner: property('Owning login'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('Owning login'),
        repo: property('Repository name'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('Owning login'),
        repo: property('Repository name'),
        title: property('Issue title'),
        body: property('Issue body'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('Owning login'),
        repo: property('Repository name'),
        state: property('Issue state: open, closed, or all'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('Owning login'),
        repo: property('Repository name'),
        title: property('Pull request title'),
        body: property('Pull request body'),
        head: property('Head branch name'),
        base: property('Base branch name'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('Owning login'),
        repo: property('Repository name'),
        pull_number: property('Pull request number', 'integer'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text, 'utf8'),
  });
  res.end(text);
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    structuredContent: payload,
  };
  if (isError) result.isError = true;
  return result;
}

function repoOrError(owner: string, repo: string): { repo: RepoRecord } | { error: Record<string, unknown> } {
  const record = forge.getRepo(owner, repo);
  return record ? { repo: record } : { error: toolResult({ message: `Repository ${owner}/${repo} not found` }, true) };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return rpcError(null, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);

  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
  const missing = required.filter((key) => !(key in args));
  if (missing.length > 0) {
    return rpcError(null, JSON_RPC_INVALID_PARAMS, `Missing required arguments: ${missing.join(', ')}`);
  }

  const owner = stringArg(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'login']);
  const repoName = stringArg(args, ['repo', 'repository', 'repo_name', 'repository_name', 'name']);

  switch (name) {
    case 'create_repo': {
      const nameValue = stringArg(args, ['name', 'repo', 'repository', 'repo_name', 'repository_name']);
      const description = stringArg(args, ['description', 'about', 'summary', 'body']);
      const isPrivate = boolArg(args, ['private', 'is_private']);
      const created = forge.createRepo({ name: nameValue, description, private: isPrivate ?? true });
      if (created.status !== 201) return toolResult(created.body ?? { message: 'Could not create repository' }, true);
      return toolResult(created.body);
    }
    case 'get_repo': {
      const found = repoOrError(owner, repoName);
      return 'error' in found ? found.error : toolResult(forge.repoJson(found.repo));
    }
    case 'create_issue': {
      const found = repoOrError(owner, repoName);
      if ('error' in found) return found.error;
      const created = forge.createIssue(found.repo, {
        title: stringArg(args, ['title', 'issue_title', 'subject']),
        body: stringArg(args, ['body', 'issue_body', 'content', 'text']),
      });
      if (created.status !== 201) return toolResult(created.body ?? { message: 'Could not create issue' }, true);
      return toolResult(created.body);
    }
    case 'list_issues': {
      const found = repoOrError(owner, repoName);
      if ('error' in found) return found.error;
      const state = stringArg(args, ['state', 'status']) || 'open';
      const query = new URLSearchParams({ state });
      const issues = forge.listIssues(found.repo, query).map((issue) => forge.issueJson(found.repo, issue));
      return toolResult(issues);
    }
    case 'create_pull_request': {
      const found = repoOrError(owner, repoName);
      if ('error' in found) return found.error;
      const created = forge.createPull(found.repo, {
        title: stringArg(args, ['title', 'pull_request_title', 'pr_title']),
        body: stringArg(args, ['body', 'pull_request_body', 'pr_body', 'description']),
        head: stringArg(args, ['head', 'head_ref', 'head_branch', 'source_branch']),
        base: stringArg(args, ['base', 'base_ref', 'base_branch', 'target_branch']),
      });
      if (created.status !== 201) return toolResult(created.body ?? { message: 'Could not create pull request' }, true);
      return toolResult(created.body);
    }
    case 'merge_pull_request': {
      const found = repoOrError(owner, repoName);
      if ('error' in found) return found.error;
      const number = numberArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number']);
      if (number === null) return rpcError(null, JSON_RPC_INVALID_PARAMS, 'pull_number is required');
      const merged = forge.mergePull(found.repo, number);
      if (merged.status !== 200) return toolResult(merged.body ?? { message: 'Could not merge pull request' }, true);
      return toolResult(merged.body);
    }
    default:
      return rpcError(null, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
  }
}

/** Dispatch one MCP POST. `authorized` is false only when the configured bearer token is absent. */
export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  raw: Buffer,
  authorized: boolean,
  _authToken: string,
): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, rpcError(null, JSON_RPC_METHOD_NOT_FOUND, 'MCP requires POST'));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error'));
    return;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error'));
    return;
  }

  const request = parsed as RpcRequest;
  const id: JsonRpcId =
    typeof request.id === 'string' || typeof request.id === 'number' ? request.id : request.id === null ? null : null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  if (request.jsonrpc !== '2.0' || method === '') {
    sendJson(res, 400, rpcError(id, JSON_RPC_INVALID_PARAMS, 'Invalid JSON-RPC request'));
    return;
  }

  // Notifications have no id and get no JSON-RPC answer.
  if (request.id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (!authorized) {
    sendJson(res, 401, rpcError(id, JSON_RPC_INVALID_PARAMS, 'Requires authentication'));
    return;
  }

  switch (method) {
    case 'server/discover':
      sendJson(res, 200, rpcResult(id, {
        resultType: 'server/discover',
        supportedVersions: [...SUPPORTED_REVISIONS],
        capabilities: { tools: {} },
        instructions: 'Use tools/list and tools/call to operate on the forge.',
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      }));
      return;
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : PREFERRED_REVISION;
      sendJson(res, 200, rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      }));
      return;
    }
    case 'tools/list':
      sendJson(res, 200, rpcResult(id, { tools: TOOLS.map((tool) => ({ ...tool })) }));
      return;
    case 'tools/call': {
      if (typeof params.name !== 'string') {
        sendJson(res, 200, rpcError(id, JSON_RPC_INVALID_PARAMS, 'tools/call requires a tool name'));
        return;
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      const answer = callTool(params.name, args);
      // A tool result must be carried inside its JSON-RPC response; errors already are envelopes.
      // callTool builds errors with a null id, so re-issue them under the caller's id.
      if (isRecord(answer.error)) {
        const code = typeof answer.error.code === 'number' ? answer.error.code : JSON_RPC_INVALID_PARAMS;
        const message = typeof answer.error.message === 'string' ? answer.error.message : 'Tool call failed';
        sendJson(res, 200, rpcError(id, code, message, answer.error.data));
      } else {
        sendJson(res, 200, rpcResult(id, answer));
      }
      return;
    }
    case 'ping':
      sendJson(res, 200, rpcResult(id, {}));
      return;
    default:
      sendJson(res, 200, rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`));
  }
}

// Keep the viewer import meaningful: MCP tools operate on the same viewer-scoped store as REST.
void viewer;
