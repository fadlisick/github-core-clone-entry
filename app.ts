// The forge: one Node http server serving git smart HTTP, REST v3,
// GraphQL v4 and MCP from a single in-memory store. No dependencies.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { authOk, jsonError, readBody, sendBuffer, sendJson } from './http.ts';
import { applyPush, fetchResponse, lsRefsResponse, parseReceivePack, parseV2Request, pushReport, v0Advertisement, v0FetchResponse, v2Advertisement } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const store = new Store();

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err) => {
      try {
        console.error('[entry-error]', err instanceof Error ? err.stack : String(err));
        jsonError(store, res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      } catch {
        // response already gone; nothing to do
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const query = queryOf(req);

  // Boot probe: no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(store, res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (gitMatch !== null) {
    await handleGit(req, res, gitMatch[1] as string, gitMatch[2] as string, gitMatch[3] as string, query);
    return;
  }

  // REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
    const segments = restPath === '' ? [] : restPath.split('/').map((s) => decodeURIComponent(s));
    const handled = await handleRest({ store, req, res, method, segments, query });
    if (handled) return;
  }

  // GraphQL v4
  if (path === '/api/graphql') {
    await handleGraphQL(store, req, res);
    return;
  }

  // MCP
  if (path === '/mcp') {
    await handleMcp(store, req, res);
    return;
  }

  // Anything else: GitHub's 404 body, JSON, never HTML.
  jsonError(store, res, 404, 'Not Found');
}

async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, tail: string, query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  const repo = owner === VIEWER_LOGIN ? (store.getRepo(owner, repoName) ?? null) : null;

  if (method === 'GET' && tail === 'info/refs') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      jsonError(store, res, 404, 'Not Found');
      return;
    }
    if (repo === null) {
      jsonError(store, res, 404, 'Not Found');
      return;
    }
    if (!authOk(req)) {
      jsonError(store, res, 401, 'Requires authentication');
      return;
    }
    if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2') {
      sendBuffer(store, res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      return;
    }
    const ad = v0Advertisement(repo, service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack');
    sendBuffer(store, res, 200, ad, service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement');
    return;
  }

  if (method === 'POST' && tail === 'git-upload-pack') {
    if (repo === null) {
      jsonError(store, res, 404, 'Not Found');
      return;
    }
    if (!authOk(req)) {
      jsonError(store, res, 401, 'Requires authentication');
      return;
    }
    const body = await readBody(req);
    // A body that is not pkt-line framed at all is malformed: survive it.
    if (body.length < 4 || !/^[0-9a-fA-F]{4}$/.test(body.subarray(0, 4).toString('ascii'))) {
      jsonError(store, res, 400, 'Bad request: not a pkt-line stream');
      return;
    }
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const parsed = parseV2Request(body);
    if (isV2 || parsed !== null) {
      if (parsed === null) {
        jsonError(store, res, 400, 'Bad request: unknown v2 command');
        return;
      }
      if (parsed.command === 'ls-refs') {
        sendBuffer(store, res, 200, lsRefsResponse(repo, parsed.req), 'application/x-git-upload-pack-result');
        return;
      }
      if (parsed.command === 'fetch') {
        sendBuffer(store, res, 200, fetchResponse(repo, parsed.req), 'application/x-git-upload-pack-result');
        return;
      }
      jsonError(store, res, 400, 'Bad request: unknown v2 command');
      return;
    }
    // v0 fetch
    sendBuffer(store, res, 200, v0FetchResponse(repo, body), 'application/x-git-upload-pack-result');
    return;
  }

  if (method === 'POST' && tail === 'git-receive-pack') {
    if (repo === null) {
      jsonError(store, res, 404, 'Not Found');
      return;
    }
    if (!authOk(req)) {
      jsonError(store, res, 401, 'Requires authentication');
      return;
    }
    const body = await readBody(req);
    if (body.length < 4 || !/^[0-9a-fA-F]{4}$/.test(body.subarray(0, 4).toString('ascii'))) {
      jsonError(store, res, 400, 'Bad request: not a pkt-line stream');
      return;
    }
    const useSideband = body.toString('utf8').includes('side-band-64k');
    const { commands, pack } = parseReceivePack(body);
    const result = applyPush(store, repo, commands, pack);
    sendBuffer(store, res, 200, pushReport(result, useSideband), 'application/x-git-receive-pack-result');
    return;
  }

  jsonError(store, res, 404, 'Not Found');
}
