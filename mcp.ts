// Model Context Protocol over streamable HTTP: modern server/discover
// (revision 2026-07-28) plus the legacy initialize handshake, tools/list and
// tools/call over the same store as REST and GraphQL.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { authOk, isRecord, jsonError, parseJson, readBody, sendJson } from './http.ts';
import { doMerge } from './rest.ts';
import { gid } from './graphql.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

function toolList(): ToolDef[] {
  return [
    {
      name: 'create_repo',
      description: 'Create a new repository owned by the viewer.',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository' },
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
      },
      required: ['name'],
    },
    {
      name: 'get_repo',
      description: 'Get a repository by owner and name.',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository.',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository.',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request in a repository.',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request with a squash merge.',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  ];
}

// The tools/list answer, built once so two calls are byte-for-byte identical.
const TOOLS_LIST_RESULT = {
  tools: toolList().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.properties, required: t.required },
  })),
};

function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | null {
  const want = normName(name);
  for (const t of toolList()) {
    const have = normName(t.name);
    if (have === want || want.endsWith(have)) return t;
  }
  return null;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((n) => ({ name: n })),
    user: { login: VIEWER_LOGIN },
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merge_commit_sha: pull.merged ? pull.mergeSha : null,
  };
}

function toolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? (args.owner as string) : '';
  let repo = typeof args.repo === 'string' ? (args.repo as string) : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0] as string;
      if (repo === '') repo = parts[1] as string;
    }
  }
  if (owner === '') owner = VIEWER_LOGIN;
  return { owner, repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (tool === null) throw { code: -32601, message: `Method not found: ${name}` };
  // Required-argument check: missing required args are a JSON-RPC -32602.
  for (const req of tool.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      // full_name can stand in for owner+repo
      if ((req === 'owner' || req === 'repo') && typeof args.full_name === 'string' && (args.full_name as string).includes('/')) continue;
      throw { code: -32602, message: `Missing required argument: ${req}` };
    }
  }
  const { owner, repo: repoName } = splitFullName(args);
  switch (tool.name) {
    case 'create_repo': {
      const rname = String(args.name ?? repoName);
      if (rname === '') throw { code: -32602, message: 'Missing required argument: name' };
      const existing = store.getRepo(owner, rname);
      if (existing !== undefined) return toolResult(repoJson(existing));
      const repo = store.createRepo(owner, rname, args.private === true, typeof args.description === 'string' ? (args.description as string) : '');
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined || owner !== VIEWER_LOGIN) throw { code: -32602, message: 'Repository not found' };
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined || owner !== VIEWER_LOGIN) throw { code: -32602, message: 'Repository not found' };
      repo.seq += 1;
      const issue: Issue = {
        id: store.nextGlobalId,
        number: repo.seq,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? (args.body as string) : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: repo.seq,
      };
      store.nextGlobalId += 1;
      repo.issues.push(issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined || owner !== VIEWER_LOGIN) throw { code: -32602, message: 'Repository not found' };
      const state = typeof args.state === 'string' ? (args.state as string) : 'open';
      const items = repo.issues.filter((i) => state === 'all' || i.state === state).map((i) => issueJson(repo, i));
      return toolResult({ issues: items });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined || owner !== VIEWER_LOGIN) throw { code: -32602, message: 'Repository not found' };
      const headSha = store.resolveRef(repo, String(args.head ?? ''));
      const baseSha = store.resolveRef(repo, String(args.base ?? ''));
      if (headSha === null || baseSha === null) return toolError('head or base branch not found');
      repo.seq += 1;
      const pull: Pull = {
        id: store.nextGlobalId,
        number: repo.seq,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? (args.body as string) : '',
        state: 'open',
        headRef: String(args.head ?? ''),
        baseRef: String(args.base ?? ''),
        headSha,
        baseSha,
        merged: false,
        mergedAt: '',
        mergeSha: '',
        seq: repo.seq,
      };
      store.nextGlobalId += 1;
      repo.pulls.push(pull);
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined || owner !== VIEWER_LOGIN) throw { code: -32602, message: 'Repository not found' };
      const num = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === num);
      if (pull === undefined) return toolError('pull request not found');
      const merged = doMerge(store, repo, pull);
      if (merged.status !== 200) return toolError(merged.message);
      return toolResult(pullJson(repo, pull));
    }
    default:
      throw { code: -32601, message: `Method not found: ${name}` };
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const err: Record<string, unknown> = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  // DELETE closes a session; best-effort, always fine.
  if (req.method === 'DELETE') {
    sendJson(store, res, 200, {});
    return true;
  }
  if (req.method !== 'POST') {
    jsonError(store, res, 404, 'Not Found');
    return true;
  }
  if (!authOk(req)) {
    // A call with no Authorization header answers 401.
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': store.nextRequestId() });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return true;
  }
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  const parsed = parseJson(raw);
  if (parsed === null) {
    // Non-JSON body: HTTP 400 with JSON-RPC -32700. Recover the id if present.
    let id: unknown = null;
    const m = /"id"\s*:\s*("[^"]*"|\d+)/.exec(text);
    if (m !== null) {
      const v = m[1] as string;
      id = v.startsWith('"') ? v.slice(1, -1) : parseInt(v, 10);
    }
    sendJson(store, res, 400, rpcError(id, -32700, 'Parse error'));
    return true;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(store, res, 400, rpcError(isRecord(parsed) ? (parsed.id ?? null) : null, -32600, 'Invalid Request'));
    return true;
  }
  const id = parsed.id ?? null;
  const method = parsed.method as string;
  const params = isRecord(parsed.params) ? (parsed.params as Record<string, unknown>) : {};

  // Notifications (no id) need no response body.
  if (method === 'notifications/initialized') {
    res.writeHead(202, { 'x-github-request-id': store.nextRequestId() });
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    sendJson(store, res, 200, rpcResult(id, {
      supportedVersions: [MODERN_REVISION, '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return true;
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : MODERN_REVISION;
    sendJson(store, res, 200, rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return true;
  }

  if (method === 'tools/list') {
    sendJson(store, res, 200, rpcResult(id, TOOLS_LIST_RESULT));
    return true;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? (params.name as string) : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    try {
      const result = callTool(store, toolName, args);
      sendJson(store, res, 200, rpcResult(id, result));
    } catch (err) {
      if (isRecord(err) && typeof err.code === 'number') {
        sendJson(store, res, 200, rpcError(id, err.code as number, String(err.message ?? 'error')));
      } else {
        sendJson(store, res, 200, rpcError(id, -32603, err instanceof Error ? err.message : 'Internal error'));
      }
    }
    return true;
  }

  sendJson(store, res, 200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}

export { gid };
