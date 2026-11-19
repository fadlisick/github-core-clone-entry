// Forge store: in-memory repositories, git objects, issues, pull requests.
// Single process, no persistence: every trial starts from an empty forge and
// the suite creates everything through the forge's own surfaces.
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** Deterministic clock: never Date.now() in a response (replay must match). */
export const TRIAL_EPOCH: number = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  return 1735689600; // 2025-01-01T00:00:00Z
})();
export const NOW_ISO: string = new Date(TRIAL_EPOCH * 1000).toISOString();

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git tree sort: byte order of name, directories compared as if ending in '/'. */
export function compareTreeNames(a: string, aIsDir: boolean, b: string, bIsDir: boolean): number {
  const an = aIsDir ? `${a}/` : a;
  const bn = bIsDir ? `${b}/` : b;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export interface CommitParsed {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitParsed {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], message: string, epochSec: number, name = VIEWER_NAME, email = VIEWER_EMAIL): Buffer {
  const ident = `${name} <${email}> ${epochSec} +0000`;
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${ident}\ncommitter ${ident}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return Buffer.from(out, 'utf8');
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string;
  mergeSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  seq: number; // per-repo issue+PR number counter
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextGlobalId = 10000;
  nextCommitEpoch = TRIAL_EPOCH;
  reqCounter = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      seq: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Store an object verbatim; returns its oid. */
  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Replace/add one path in the tree at rootOid (null = empty tree). Returns new root tree oid. */
  setPath(repo: Repo, rootOid: string | null, path: string, blobOid: string): string {
    const parts = path.split('/').filter((p) => p !== '');
    return this.setPathRec(repo, rootOid, parts, blobOid);
  }

  private setPathRec(repo: Repo, rootOid: string | null, parts: string[], blobOid: string): string {
    const name = parts[0] as string;
    let entries: TreeEntry[] = [];
    if (rootOid !== null) {
      const obj = repo.objects.get(rootOid);
      if (obj !== undefined && obj.type === 'tree') entries = parseTree(obj.data);
    }
    const isLast = parts.length === 1;
    const idx = entries.findIndex((e) => e.name === name);
    if (isLast) {
      const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    } else {
      const childOid = idx >= 0 ? entries[idx]?.oid ?? null : null;
      const newChild = this.setPathRec(repo, childOid, parts.slice(1), blobOid);
      const entry: TreeEntry = { mode: '40000', name, oid: newChild };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    }
    entries.sort((a, b) => compareTreeNames(a.name, a.mode === '40000', b.name, b.mode === '40000'));
    const data = buildTree(entries);
    return this.putObject(repo, 'tree', data);
  }

  /** Remove one path from the tree at rootOid. Returns new root tree oid (or null if empty). */
  removePath(repo: Repo, rootOid: string | null, path: string): string | null {
    const parts = path.split('/').filter((p) => p !== '');
    return this.removePathRec(repo, rootOid, parts);
  }

  private removePathRec(repo: Repo, rootOid: string | null, parts: string[]): string | null {
    if (rootOid === null) return null;
    const obj = repo.objects.get(rootOid);
    if (obj === undefined || obj.type !== 'tree') return rootOid;
    let entries = parseTree(obj.data);
    const name = parts[0] as string;
    const idx = entries.findIndex((e) => e.name === name);
    if (idx < 0) return rootOid;
    if (parts.length === 1) {
      entries = entries.filter((_, i) => i !== idx);
    } else {
      const child = this.removePathRec(repo, entries[idx]?.oid ?? null, parts.slice(1));
      if (child === null) entries = entries.filter((_, i) => i !== idx);
      else entries[idx] = { mode: '40000', name, oid: child };
    }
    if (entries.length === 0) return null;
    return this.putObject(repo, 'tree', buildTree(entries));
  }

  /** Flatten a tree to path -> {oid, mode}. */
  flattenTree(repo: Repo, rootOid: string | null, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (rootOid === null) return out;
    const obj = repo.objects.get(rootOid);
    if (obj === undefined || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') {
        for (const [k, v] of this.flattenTree(repo, e.oid, p)) out.set(k, v);
      } else {
        out.set(p, { oid: e.oid, mode: e.mode });
      }
    }
    return out;
  }

  /** Diff two trees (old -> new). Returns changed files. */
  diffTrees(repo: Repo, oldRoot: string | null, newRoot: string | null): PullFile[] {
    const oldMap = this.flattenTree(repo, oldRoot);
    const newMap = this.flattenTree(repo, newRoot);
    const files: PullFile[] = [];
    const all = new Set([...oldMap.keys(), ...newMap.keys()]);
    for (const path of [...all].sort()) {
      const o = oldMap.get(path);
      const n = newMap.get(path);
      if (o !== undefined && n !== undefined && o.oid === n.oid) continue;
      if (o === undefined && n !== undefined) {
        const lines = countLines(repo, n.oid);
        files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (o !== undefined && n === undefined) {
        const lines = countLines(repo, o.oid);
        files.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (o !== undefined && n !== undefined) {
        const a = countChangedLines(repo, o.oid, n.oid);
        files.push({ filename: path, status: 'modified', additions: Math.max(1, a.add), deletions: a.del, changes: Math.max(1, a.add + a.del) });
      }
    }
    return files;
  }

  /** Walk commits from tip (newest first), following all parents. */
  walkCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.push(oid);
      const parsed = parseCommit(obj.data);
      for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i] as string);
    }
    return out;
  }

  /** True when ancestorOid is reachable from oid (or equal). */
  isAncestor(repo: Repo, ancestorOid: string, oid: string): boolean {
    if (ancestorOid === oid) return true;
    return this.walkCommits(repo, oid).includes(ancestorOid);
  }

  /** Resolve a ref name or branch name or oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    const head = `refs/heads/${ref}`;
    if (repo.refs.has(head)) return repo.refs.get(head) as string;
    if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref.toLowerCase())) return ref.toLowerCase();
    return null;
  }

  /** Create a commit on a branch for a contents change; returns commit oid. */
  commitContents(repo: Repo, branch: string, message: string, changes: Array<{ path: string; blobOid: string | null }>): string {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    let treeOid: string | null = null;
    const parents: string[] = [];
    if (tip !== null) {
      const obj = repo.objects.get(tip);
      if (obj !== undefined && obj.type === 'commit') {
        treeOid = parseCommit(obj.data).tree;
        parents.push(tip);
      }
    }
    for (const ch of changes) {
      if (ch.blobOid === null) treeOid = this.removePath(repo, treeOid, ch.path);
      else treeOid = this.setPath(repo, treeOid, ch.path, ch.blobOid);
    }
    if (treeOid === null) treeOid = this.putObject(repo, 'tree', Buffer.alloc(0));
    this.nextCommitEpoch += 1;
    const commitOid = this.putObject(repo, 'commit', buildCommit(treeOid, parents, message, this.nextCommitEpoch));
    repo.refs.set(ref, commitOid);
    return commitOid;
  }

  nextRequestId(): string {
    this.reqCounter += 1;
    return `req-${this.reqCounter.toString(16).padStart(8, '0')}`;
  }
}

export function countLines(repo: Repo, blobOid: string): number {
  const obj = repo.objects.get(blobOid);
  if (obj === undefined) return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function countChangedLines(repo: Repo, oldOid: string, newOid: string): { add: number; del: number } {
  const oldObj = repo.objects.get(oldOid);
  const newObj = repo.objects.get(newOid);
  const oldLines = oldObj === undefined ? [] : oldObj.data.toString('utf8').split('\n');
  const newLines = newObj === undefined ? [] : newObj.data.toString('utf8').split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  let add = 0;
  for (const l of newLines) if (!oldSet.has(l)) add += 1;
  let del = 0;
  for (const l of oldLines) if (!newSet.has(l)) del += 1;
  return { add, del };
}

/** Deflate helper kept here so pack code shares it. */
export function deflate(data: Buffer): Buffer {
  return deflateSync(data);
}
