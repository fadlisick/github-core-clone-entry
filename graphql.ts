// GitHub GraphQL v4: a small hand-rolled executor for exactly the documents
// gh and github-mcp-server send (viewer, repository, node, issues, pull
// requests, the five mutations, __type introspection, batched operations).
// Shares the store with REST/git/MCP, so mutations are visible everywhere.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, parseCommit, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { authOk, isRecord, jsonError, parseJson, readBody, sendJson } from './http.ts';
import { doMerge } from './rest.ts';

// ---------------------------------------------------------------- global ids

export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function ungid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const idx = text.indexOf(':');
    if (idx <= 0) return null;
    return { kind: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return gid('Repository', String(repo.id));
}

function issueGid(repo: Repo, issue: Issue): string {
  return gid('Issue', `${repo.id}:${issue.number}`);
}

function pullGid(repo: Repo, pull: Pull): string {
  return gid('PullRequest', `${repo.id}:${pull.number}`);
}

function findRepoById(store: Store, id: string): Repo | null {
  const dec = ungid(id);
  if (dec === null || dec.kind !== 'Repository') return null;
  const dbid = parseInt(dec.key, 10);
  for (const r of store.repos.values()) if (r.id === dbid) return r;
  return null;
}

function findIssueById(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const dec = ungid(id);
  if (dec === null || dec.kind !== 'Issue') return null;
  const [repoId, num] = dec.key.split(':');
  const repo = [...store.repos.values()].find((r) => r.id === parseInt(repoId ?? '', 10));
  if (repo === undefined) return null;
  const issue = repo.issues.find((i) => i.number === parseInt(num ?? '', 10));
  if (issue === undefined) return null;
  return { repo, issue };
}

function findPullById(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const dec = ungid(id);
  if (dec === null || dec.kind !== 'PullRequest') return null;
  const [repoId, num] = dec.key.split(':');
  const repo = [...store.repos.values()].find((r) => r.id === parseInt(repoId ?? '', 10));
  if (repo === undefined) return null;
  const pull = repo.pulls.find((p) => p.number === parseInt(num ?? '', 10));
  if (pull === undefined) return null;
  return { repo, pull };
}

// ---------------------------------------------------------------- lexer/parser

type Tok =
  | { k: 'name'; v: string }
  | { k: 'int'; v: number }
  | { k: 'string'; v: string }
  | { k: 'punct'; v: string }
  | { k: 'spread' };

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ k: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():$![]=|&'.includes(c)) {
      toks.push({ k: 'punct', v: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1] as string;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      toks.push({ k: 'string', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && /^-?[0-9]/.test(src.slice(i, i + 2))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      toks.push({ k: 'int', v: parseInt(src.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j] as string)) j += 1;
      toks.push({ k: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return toks;
}

export type GqlValue =
  | { t: 'var'; name: string }
  | { t: 'string'; v: string }
  | { t: 'int'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'enum'; v: string }
  | { t: 'list'; items: GqlValue[] }
  | { t: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface Selection {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selections: Selection[];
  fragmentType: string | null; // for inline fragments: ... on Type { ... }
}

export interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

class Parser {
  toks: Tok[];
  pos = 0;
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  next(): Tok {
    const t = this.toks[this.pos] as Tok;
    this.pos += 1;
    return t;
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.k !== 'punct' || t.v !== v) throw new Error(`expected ${v}`);
  }
  expectName(): string {
    const t = this.next();
    if (t.k !== 'name') throw new Error('expected name');
    return t.v;
  }
  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.toks.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }
  parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t !== undefined && t.k === 'name' && (t.v === 'query' || t.v === 'mutation')) {
      this.next();
      type = t.v;
      const n = this.peek();
      if (n !== undefined && n.k === 'name') {
        name = this.next().v as string;
      }
    }
    // variable definitions: ($x: Type!, ...)
    if (this.peek()?.k === 'punct' && (this.peek() as { v: string }).v === '(') {
      this.skipParens();
    }
    const selections = this.parseSelectionSet();
    return { type, name, selections };
  }
  skipParens(): void {
    let depth = 0;
    while (this.pos < this.toks.length) {
      const t = this.next();
      if (t.k === 'punct' && t.v === '(') depth += 1;
      else if (t.k === 'punct' && t.v === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }
  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (true) {
      const t = this.peek();
      if (t === undefined) throw new Error('unterminated selection set');
      if (t.k === 'punct' && t.v === '}') {
        this.next();
        return sels;
      }
      sels.push(this.parseSelection());
    }
  }
  parseSelection(): Selection {
    const t = this.peek();
    if (t !== undefined && t.k === 'spread') {
      this.next();
      const n = this.peek();
      if (n !== undefined && n.k === 'name' && n.v === 'on') {
        this.next();
        const typeName = this.expectName();
        const selections = this.parseSelectionSet();
        return { alias: null, name: '__fragment', args: [], selections, fragmentType: typeName };
      }
      // named fragment spread: not used by the suite; skip its selection set if any
      const fragName = this.expectName();
      void fragName;
      return { alias: null, name: '__fragment', args: [], selections: [], fragmentType: null };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    const c = this.peek();
    if (c !== undefined && c.k === 'punct' && c.v === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    const p = this.peek();
    if (p !== undefined && p.k === 'punct' && p.v === '(') {
      this.next();
      while (true) {
        const q = this.peek();
        if (q !== undefined && q.k === 'punct' && q.v === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selections: Selection[] = [];
    const s = this.peek();
    if (s !== undefined && s.k === 'punct' && s.v === '{') {
      selections = this.parseSelectionSet();
    }
    return { alias, name, args, selections, fragmentType: null };
  }
  parseValue(): GqlValue {
    const t = this.next();
    if (t.k === 'punct' && t.v === '$') return { t: 'var', name: this.expectName() };
    if (t.k === 'string') return { t: 'string', v: t.v };
    if (t.k === 'int') return { t: 'int', v: t.v };
    if (t.k === 'name') {
      if (t.v === 'true') return { t: 'bool', v: true };
      if (t.v === 'false') return { t: 'bool', v: false };
      if (t.v === 'null') return { t: 'null' };
      return { t: 'enum', v: t.v };
    }
    if (t.k === 'punct' && t.v === '[') {
      const items: GqlValue[] = [];
      while (true) {
        const q = this.peek();
        if (q !== undefined && q.k === 'punct' && q.v === ']') {
          this.next();
          return { t: 'list', items };
        }
        items.push(this.parseValue());
      }
    }
    if (t.k === 'punct' && t.v === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (true) {
        const q = this.peek();
        if (q !== undefined && q.k === 'punct' && q.v === '}') {
          this.next();
          return { t: 'object', fields };
        }
        const fname = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fname, value: this.parseValue() });
      }
    }
    throw new Error('unexpected value token');
  }
}

function evalValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.t) {
    case 'var':
      return variables[v.name] ?? null;
    case 'string':
      return v.v;
    case 'int':
      return v.v;
    case 'bool':
      return v.v;
    case 'null':
      return null;
    case 'enum':
      return v.v;
    case 'list':
      return v.items.map((i) => evalValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

function argMap(sel: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of sel.args) out[a.name] = evalValue(a.value, variables);
  return out;
}

// ---------------------------------------------------------------- introspection tables

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'LABEL', 'WIKI'];

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

type GqlObj =
  | { __type: 'Query' }
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'ChangedFileConnection'; files: Array<{ path: string }> }
  | { __type: 'ChangedFile'; path: string }
  | { __type: 'Ref'; name: string }
  | { __type: '__Type'; name: string }
  | { __type: 'Mutation' }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'AddCommentPayload'; comment: { id: number; body: string } }
  | { __type: 'CommentEdge'; comment: { id: number; body: string } }
  | { __type: 'Comment'; comment: { id: number; body: string } };

const FIELD_TABLES: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['id', 'login', 'name', 'email']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'repository']),
  PullRequest: new Set(['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'repository']),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  ChangedFileConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  ChangedFile: new Set(['path', 'additions', 'deletions', 'changeType']),
  Ref: new Set(['name', 'target']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'comment', 'clientMutationId']),
  CommentEdge: new Set(['node', 'cursor']),
  Comment: new Set(['id', 'body', 'author', 'createdAt', 'updatedAt']),
};

function executeSelections(ctx: Ctx, obj: GqlObj, selections: Selection[], path: Array<string | number>): Record<string, unknown> | null {
  if (obj === null) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.name === '__fragment') {
      // Inline fragment: applies only when the object type matches.
      if (sel.fragmentType !== null && sel.fragmentType !== obj.__type) continue;
      const sub = executeSelections(ctx, obj, sel.selections, path);
      if (sub !== null) Object.assign(out, sub);
      continue;
    }
    const key = sel.alias ?? sel.name;
    const table = FIELD_TABLES[obj.__type];
    if (table !== undefined && !table.has(sel.name) && !sel.name.startsWith('__')) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${obj.__type}".`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    try {
      out[key] = resolveField(ctx, obj, sel, [...path, key]);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
      out[key] = null;
    }
  }
  return out;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64url');
}

function cursorToNumber(cursor: string | null): number | null {
  if (cursor === null || cursor === undefined) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function resolveField(ctx: Ctx, obj: GqlObj, sel: Selection, path: Array<string | number>): unknown {
  const args = argMap(sel, ctx.variables);
  const store = ctx.store;
  switch (obj.__type) {
    case 'Query': {
      if (sel.name === 'viewer') {
        const user: GqlObj = { __type: 'User', login: VIEWER_LOGIN };
        return executeSelections(ctx, user, sel.selections, path);
      }
      if (sel.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = store.getRepo(owner, name);
        if (repo === undefined) return null;
        return executeSelections(ctx, { __type: 'Repository', repo }, sel.selections, path);
      }
      if (sel.name === 'node') {
        const id = String(args.id ?? '');
        const dec = ungid(id);
        if (dec === null) return null;
        if (dec.kind === 'Repository') {
          const repo = findRepoById(store, id);
          if (repo === null) return null;
          return executeSelections(ctx, { __type: 'Repository', repo }, sel.selections, path);
        }
        if (dec.kind === 'Issue') {
          const found = findIssueById(store, id);
          if (found === null) return null;
          return executeSelections(ctx, { __type: 'Issue', repo: found.repo, issue: found.issue }, sel.selections, path);
        }
        if (dec.kind === 'PullRequest') {
          const found = findPullById(store, id);
          if (found === null) return null;
          return executeSelections(ctx, { __type: 'PullRequest', repo: found.repo, pull: found.pull }, sel.selections, path);
        }
        return null;
      }
      if (sel.name === '__type') {
        const name = String(args.name ?? '');
        return executeSelections(ctx, { __type: '__Type', name }, sel.selections, path);
      }
      return null;
    }
    case 'Mutation': {
      if (sel.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoById(store, String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('repository not found');
        repo.seq += 1;
        const issue: Issue = {
          id: store.nextGlobalId,
          number: repo.seq,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          comments: [],
          seq: repo.seq,
        };
        store.nextGlobalId += 1;
        repo.issues.push(issue);
        return executeSelections(ctx, { __type: 'CreateIssuePayload', repo, issue }, sel.selections, path);
      }
      if (sel.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueById(store, String(input.issueId ?? ''));
        if (found === null) throw new Error('issue not found');
        found.issue.state = 'closed';
        return executeSelections(ctx, { __type: 'CloseIssuePayload', repo: found.repo, issue: found.issue }, sel.selections, path);
      }
      if (sel.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoById(store, String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('repository not found');
        const headSha = store.resolveRef(repo, String(input.headRefName ?? ''));
        const baseSha = store.resolveRef(repo, String(input.baseRefName ?? ''));
        if (headSha === null || baseSha === null) throw new Error('head or base branch not found');
        repo.seq += 1;
        const pull: Pull = {
          id: store.nextGlobalId,
          number: repo.seq,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          headRef: String(input.headRefName ?? ''),
          baseRef: String(input.baseRefName ?? ''),
          headSha,
          baseSha,
          merged: false,
          mergedAt: '',
          mergeSha: '',
          seq: repo.seq,
        };
        store.nextGlobalId += 1;
        repo.pulls.push(pull);
        return executeSelections(ctx, { __type: 'CreatePullRequestPayload', repo, pull }, sel.selections, path);
      }
      if (sel.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findPullById(store, String(input.pullRequestId ?? ''));
        if (found === null) throw new Error('pull request not found');
        const merged = doMerge(store, found.repo, found.pull);
        if (merged.status !== 200) throw new Error(merged.message);
        return executeSelections(ctx, { __type: 'MergePullRequestPayload', repo: found.repo, pull: found.pull }, sel.selections, path);
      }
      if (sel.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueById(store, String(input.subjectId ?? ''));
        if (found === null) throw new Error('subject not found');
        const comment = { id: store.nextGlobalId, body: String(input.body ?? '') };
        store.nextGlobalId += 1;
        found.issue.comments.push(comment);
        return executeSelections(ctx, { __type: 'AddCommentPayload', comment }, sel.selections, path);
      }
      return null;
    }
    case 'User': {
      if (sel.name === 'login') return obj.login;
      if (sel.name === 'id') return gid('User', obj.login);
      if (sel.name === 'name') return 'ada iversen';
      if (sel.name === 'email') return 'adaiversen@example.invalid';
      return null;
    }
    case 'Repository': {
      const repo = obj.repo;
      if (sel.name === 'id') return repoGid(repo);
      if (sel.name === 'databaseId') return repo.id;
      if (sel.name === 'name') return repo.name;
      if (sel.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (sel.name === 'description') return repo.description;
      if (sel.name === 'isPrivate') return repo.private;
      if (sel.name === 'owner') return executeSelections(ctx, { __type: 'User', login: repo.owner }, sel.selections, path);
      if (sel.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return executeSelections(ctx, { __type: 'Ref', name: repo.defaultBranch }, sel.selections, path);
      }
      if (sel.name === 'viewerPermission') return 'ADMIN';
      if (sel.name === 'hasIssuesEnabled') return true;
      if (sel.name === 'issue') {
        const number = Number(args.number);
        const issue = repo.issues.find((i) => i.number === number);
        if (issue === undefined) return null;
        return executeSelections(ctx, { __type: 'Issue', repo, issue }, sel.selections, path);
      }
      if (sel.name === 'issues') {
        return executeSelections(ctx, issuesConnection(ctx, repo, args), sel.selections, path);
      }
      if (sel.name === 'pullRequests') {
        const first = typeof args.first === 'number' ? (args.first as number) : 100;
        const pulls = repo.pulls.slice().sort((a, b) => a.number - b.number).slice(0, first);
        return executeSelections(ctx, { __type: 'PullRequestConnection', repo, pulls }, sel.selections, path);
      }
      if (sel.name === 'pullRequest') {
        const number = Number(args.number);
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) return null;
        return executeSelections(ctx, { __type: 'PullRequest', repo, pull }, sel.selections, path);
      }
      return null;
    }
    case 'Issue': {
      const issue = obj.issue;
      if (sel.name === 'id') return issueGid(obj.repo, issue);
      if (sel.name === 'number') return issue.number;
      if (sel.name === 'title') return issue.title;
      if (sel.name === 'state') return issueState(issue);
      if (sel.name === 'body') return issue.body;
      return null;
    }
    case 'PullRequest': {
      const pull = obj.pull;
      if (sel.name === 'id') return pullGid(obj.repo, pull);
      if (sel.name === 'number') return pull.number;
      if (sel.name === 'title') return pull.title;
      if (sel.name === 'state') return prState(pull);
      if (sel.name === 'body') return pull.body;
      if (sel.name === 'headRefName') return pull.headRef;
      if (sel.name === 'baseRefName') return pull.baseRef;
      if (sel.name === 'merged') return pull.merged;
      if (sel.name === 'mergeable') return pull.merged ? 'UNKNOWN' : 'MERGEABLE';
      if (sel.name === 'files') {
        const baseCommit = obj.repo.objects.get(pull.baseSha);
        const headCommit = obj.repo.objects.get(pull.headSha);
        const baseTree = baseCommit !== undefined && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : null;
        const headTree = headCommit !== undefined && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : null;
        const files = store.diffTrees(obj.repo, baseTree, headTree).map((f) => ({ path: f.filename }));
        const first = typeof args.first === 'number' ? (args.first as number) : 100;
        return executeSelections(ctx, { __type: 'ChangedFileConnection', files: files.slice(0, first) }, sel.selections, path);
      }
      return null;
    }
    case 'IssueConnection': {
      if (sel.name === 'nodes') {
        return obj.issues.map((issue) => executeSelections(ctx, { __type: 'Issue', repo: obj.repo, issue }, sel.selections, path));
      }
      if (sel.name === 'pageInfo') {
        return executeSelections(ctx, { __type: 'PageInfo', hasNextPage: obj.pageInfo.hasNextPage, endCursor: obj.pageInfo.endCursor }, sel.selections, path);
      }
      if (sel.name === 'totalCount') return obj.issues.length;
      return null;
    }
    case 'PullRequestConnection': {
      if (sel.name === 'nodes') {
        return obj.pulls.map((pull) => executeSelections(ctx, { __type: 'PullRequest', repo: obj.repo, pull }, sel.selections, path));
      }
      if (sel.name === 'pageInfo') {
        return executeSelections(ctx, { __type: 'PageInfo', hasNextPage: false, endCursor: null }, sel.selections, path);
      }
      if (sel.name === 'totalCount') return obj.pulls.length;
      return null;
    }
    case 'PageInfo': {
      if (sel.name === 'hasNextPage') return obj.hasNextPage;
      if (sel.name === 'hasPreviousPage') return false;
      if (sel.name === 'endCursor') return obj.endCursor;
      if (sel.name === 'startCursor') return null;
      return null;
    }
    case 'ChangedFileConnection': {
      if (sel.name === 'nodes') {
        return obj.files.map((f) => executeSelections(ctx, { __type: 'ChangedFile', path: f.path }, sel.selections, path));
      }
      if (sel.name === 'pageInfo') {
        return executeSelections(ctx, { __type: 'PageInfo', hasNextPage: false, endCursor: null }, sel.selections, path);
      }
      if (sel.name === 'totalCount') return obj.files.length;
      return null;
    }
    case 'ChangedFile': {
      if (sel.name === 'path') return obj.path;
      return null;
    }
    case 'Ref': {
      if (sel.name === 'name') return obj.name;
      return null;
    }
    case '__Type': {
      if (sel.name === 'name') return obj.name;
      if (sel.name === 'fields') {
        const names = TYPE_FIELDS[obj.name] ?? [];
        return names.map((n) => ({ name: n }));
      }
      if (sel.name === 'enumValues') {
        if (obj.name === 'SearchType') return SEARCH_TYPE_VALUES.map((n) => ({ name: n }));
        return null;
      }
      return null;
    }
    case 'CreateIssuePayload': {
      if (sel.name === 'issue') return executeSelections(ctx, { __type: 'Issue', repo: obj.repo, issue: obj.issue }, sel.selections, path);
      return null;
    }
    case 'CloseIssuePayload': {
      if (sel.name === 'issue') return executeSelections(ctx, { __type: 'Issue', repo: obj.repo, issue: obj.issue }, sel.selections, path);
      return null;
    }
    case 'CreatePullRequestPayload': {
      if (sel.name === 'pullRequest') return executeSelections(ctx, { __type: 'PullRequest', repo: obj.repo, pull: obj.pull }, sel.selections, path);
      return null;
    }
    case 'MergePullRequestPayload': {
      if (sel.name === 'pullRequest') return executeSelections(ctx, { __type: 'PullRequest', repo: obj.repo, pull: obj.pull }, sel.selections, path);
      return null;
    }
    case 'AddCommentPayload': {
      if (sel.name === 'commentEdge') return executeSelections(ctx, { __type: 'CommentEdge', comment: obj.comment }, sel.selections, path);
      if (sel.name === 'comment') return executeSelections(ctx, { __type: 'Comment', comment: obj.comment }, sel.selections, path);
      return null;
    }
    case 'CommentEdge': {
      if (sel.name === 'node') return executeSelections(ctx, { __type: 'Comment', comment: obj.comment }, sel.selections, path);
      if (sel.name === 'cursor') return cursorFor(obj.comment.id);
      return null;
    }
    case 'Comment': {
      if (sel.name === 'id') return gid('Comment', String(obj.comment.id));
      if (sel.name === 'body') return obj.comment.body;
      return null;
    }
  }
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): GqlObj {
  let issues = repo.issues.slice();
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    issues = issues.filter((i) => wanted.has(issueState(i)));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  let desc = false;
  if (orderBy !== undefined && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') desc = true;
  issues.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const afterNum = cursorToNumber(typeof args.after === 'string' ? (args.after as string) : null);
  if (afterNum !== null) {
    issues = issues.filter((i) => (desc ? i.number < afterNum : i.number > afterNum));
  }
  const first = typeof args.first === 'number' ? (args.first as number) : 100;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > first;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  return { __type: 'IssueConnection', repo, issues: page, pageInfo: { hasNextPage, endCursor } };
}

// ---------------------------------------------------------------- HTTP entry

function runOperation(store: Store, op: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { store, variables, errors: [] };
  const root: GqlObj = op.type === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  let data: Record<string, unknown> | null = null;
  try {
    data = executeSelections(ctx, root, op.selections, []);
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    data = null;
  }
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export async function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!authOk(req)) {
    jsonError(store, res, 401, 'Requires authentication');
    return true;
  }
  if (req.method !== 'POST') {
    jsonError(store, res, 404, 'Not Found');
    return true;
  }
  const raw = await readBody(req);
  const parsed = parseJson(raw);
  if (parsed === null) {
    jsonError(store, res, 400, 'Problems parsing JSON');
    return true;
  }
  if (Array.isArray(parsed)) {
    const results: unknown[] = [];
    for (const entry of parsed) {
      results.push(runOne(store, entry));
    }
    sendJson(store, res, 200, results);
    return true;
  }
  sendJson(store, res, 200, runOne(store, parsed));
  return true;
}

function runOne(store: Store, entry: unknown): Record<string, unknown> {
  if (!isRecord(entry) || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'Invalid GraphQL request: query must be a string' }] };
  }
  const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
  let ops: Operation[];
  try {
    ops = new Parser(lex(entry.query as string)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (ops.length === 0) return { data: null, errors: [{ message: 'Empty GraphQL document' }] };
  // Multiple operations in one document: run the first (the suite sends one
  // operation per document except the batch array, handled above).
  return runOperation(store, ops[0] as Operation, variables);
}
