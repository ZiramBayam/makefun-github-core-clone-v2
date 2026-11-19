// Standalone entry point: construct the shared forge, expose all four surfaces on one ephemeral
// HTTP listener, register the chosen port with the suite, then poll its done signal and exit.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Result } from './store.ts';
import { forge } from './store.ts';
import { handleRest, restRequestId, isJsonBodyRequest, asBody } from './rest.ts';
import { handleGraphQL, isGraphqlBodyRequest, asGraphqlBody } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit, parseGitRoute } from './git-http.ts';

const authToken = process.env['MAKEFUN_SHOP_TOKEN'] ?? '';
const envUrl = process.env['MAKEFUN_ENV_URL'] ?? '';
let requestSequence = 0;

function rawBody(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendResult(res: ServerResponse, result: Result, requestId: string, scopes: string): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    'x-oauth-scopes': scopes,
    'x-accepted-oauth-scopes': scopes,
    'cache-control': 'no-store',
    ...(result.headers ?? {}),
  };
  let body: string;
  if (result.body === undefined || result.body === '') {
    body = '';
  } else if (typeof result.body === 'string') {
    body = result.body;
  } else {
    body = JSON.stringify(result.body);
  }
  headers['content-length'] = String(Buffer.byteLength(body, 'utf8'));
  res.writeHead(result.status, headers);
  res.end(body);
}

function jsonParseError(res: ServerResponse, requestId: string): void {
  sendResult(res, { status: 400, body: { message: 'Invalid JSON request body' } }, requestId, 'repo, read:org, write:org');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  requestSequence += 1;
  const requestId = restRequestId(requestSequence);
  const url = new URL(req.url ?? '/', 'http://entry.local');
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const origin = `${url.protocol}//${url.host}`;
  const scopes = 'repo, read:org, write:org';

  if (pathname === '/healthz' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': '11' });
    res.end('{"ok":true}');
    return;
  }

  const authorized = authToken === '' || req.headers.authorization === `Bearer ${authToken}`;

  if (pathname === '/mcp') {
    const raw = await rawBody(req);
    await handleMcp(req, res, raw, authorized, authToken);
    return;
  }

  const gitRoute = parseGitRoute(pathname, req.headers['git-protocol'] as string | undefined);
  if (gitRoute) {
    const raw = method === 'POST' ? await rawBody(req) : Buffer.alloc(0);
    handleGit(gitRoute, res, url.searchParams, raw, method);
    return;
  }

  if (pathname === '/api/graphql' || pathname === '/api/graphql/') {
    if (!authorized) {
      sendResult(res, { status: 401, body: { message: 'Requires authentication' } }, requestId, scopes);
      return;
    }
    const raw = isGraphqlBodyRequest(method) ? await rawBody(req) : Buffer.alloc(0);
    let body: ReturnType<typeof asGraphqlBody>;
    try {
      body = asGraphqlBody(raw.length > 0 ? JSON.parse(raw.toString('utf8')) : undefined);
    } catch {
      jsonParseError(res, requestId);
      return;
    }
    sendResult(res, handleGraphQL(body, authorized), requestId, scopes);
    return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const raw = isJsonBodyRequest(method) ? await rawBody(req) : Buffer.alloc(0);
    let body: Record<string, unknown> = {};
    if (raw.length > 0) {
      try {
        body = asBody(JSON.parse(raw.toString('utf8')));
      } catch {
        jsonParseError(res, requestId);
        return;
      }
    }
    sendResult(res, handleRest({ method, path: pathname, query: url.searchParams, body, origin, authorized }), requestId, scopes);
    return;
  }

  sendResult(res, { status: 404, body: { message: 'Not Found' } }, requestId, scopes);
}

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"message":"Internal Server Error"}');
    } else {
      res.end();
    }
  });
});

// Node's HTTP/1.1 keep-alive is on by default; make the pool's behaviour explicit for benchmark clients.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.requestTimeout = 120_000;

function register(port: number): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}/register`;
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  }).then((response) => {
    if (!response.ok) throw new Error(`register failed: HTTP ${response.status}`);
  });
}

async function waitForDone(): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}/done`;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const response = await fetch(url);
    if (!response.ok) continue;
    const body = (await response.json()) as { done?: unknown };
    if (body.done === true) return;
  }
}

server.listen(0, '0.0.0.0', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind an ephemeral port');
  register(address.port)
    .then(() => waitForDone())
    .then(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    })
    .catch((error: unknown) => {
      process.stderr.write(`entry lifecycle failure: ${String(error)}\n`);
      server.close(() => process.exit(1));
      setTimeout(() => process.exit(1), 1000).unref();
    });
});

// The shared store is constructed eagerly by importing ./store.ts above.
void forge;
void randomUUID;
