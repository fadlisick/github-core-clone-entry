// GitHub REST v3 API: repositories, branches, commits, contents, issues,
// comments, labels, pull requests, files and merges. One store shared with
// the git, GraphQL and MCP surfaces.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_BRANCH, NOW_ISO, VIEWER_LOGIN, buildCommit, parseCommit, parseTree, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { authOk, isRecord, jsonError, linkHeader, parseJson, readBody, sendJson, viewerUser } from './http.ts';

export interface RestCtx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  segments: string[];
  query: URLSearchParams;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User', avatar_url: '' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    pushed_at: NOW_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { id: 1, node_id: `L_${name}`, name, color: l?.color ?? 'ededed', default: false, description: '' };
    }),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    closed_at: issue.state === 'closed' ? NOW_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    labels: [],
    head: {
      label: `${VIEWER_LOGIN}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
      repo: repoJson(repo),
    },
    base: {
      label: `${VIEWER_LOGIN}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
      repo: repoJson(repo),
    },
    merged: pull.merged,
    mergeable: true,
    merge_commit_sha: pull.merged ? pull.mergeSha : null,
    merged_at: pull.merged ? pull.mergedAt : null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    closed_at: pull.state === 'closed' ? NOW_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Look up a repo under the viewer; any other owner is 404 (never 403). */
function findRepo(ctx: RestCtx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function pageParams(ctx: RestCtx): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

export async function handleRest(ctx: RestCtx): Promise<boolean> {
  const { store, req, res, method, segments, query } = ctx;
  // Auth: every /api/v3 call needs the trial bearer token.
  if (!authOk(req)) {
    jsonError(store, res, 401, 'Requires authentication');
    return true;
  }
  const seg = segments; // after /api/v3

  // ---- API root ------------------------------------------------------------
  if (seg.length === 0) {
    if (method !== 'GET') {
      jsonError(store, res, 404, 'Not Found');
      return true;
    }
    sendJson(store, res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // ---- /meta ---------------------------------------------------------------
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') {
      jsonError(store, res, 404, 'Not Found');
      return true;
    }
    sendJson(store, res, 200, { installed_version: '1.0.0', github_services_sha: '0000000000000000000000000000000000000000' });
    return true;
  }

  // ---- /user ---------------------------------------------------------------
  if (seg.length === 1 && seg[0] === 'user') {
    if (method === 'GET') {
      sendJson(store, res, 200, viewerUser());
      return true;
    }
    jsonError(store, res, 404, 'Not Found');
    return true;
  }

  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pageParams(ctx);
      const all = [...store.repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.id - b.id);
      const items = paginate(all, page, perPage).map(repoJson);
      const host = req.headers.host ?? 'localhost';
      const base = `http://${host}/api/v3/user/repos`;
      sendJson(store, res, 200, items, { link: linkHeader(base, page, perPage, all.length) });
      return true;
    }
    if (method === 'POST') {
      const body = parseJson(await readBody(req));
      if (body === null) {
        jsonError(store, res, 400, 'Problems parsing JSON');
        return true;
      }
      const rec = isRecord(body) ? body : {};
      const name = typeof rec.name === 'string' ? rec.name : '';
      if (name === '') {
        jsonError(store, res, 422, 'Validation Failed: name is required');
        return true;
      }
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        jsonError(store, res, 422, 'Repository already exists');
        return true;
      }
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        rec.private === true,
        typeof rec.description === 'string' ? rec.description : '',
      );
      sendJson(store, res, 201, repoJson(repo));
      return true;
    }
    jsonError(store, res, 404, 'Not Found');
    return true;
  }

  // ---- /repos/{owner}/{repo}/... -------------------------------------------
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = decodeURIComponent(seg[1] as string);
    const name = decodeURIComponent(seg[2] as string);
    const rest = seg.slice(3);
    const repo = findRepo(ctx, owner, name);

    // Repo itself: GET / PATCH / DELETE
    if (rest.length === 0) {
      if (method === 'GET') {
        if (repo === null) {
          jsonError(store, res, 404, 'Not Found');
          return true;
        }
        sendJson(store, res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (repo === null) {
          jsonError(store, res, 404, 'Not Found');
          return true;
        }
        const body = parseJson(await readBody(req));
        if (body === null) {
          jsonError(store, res, 400, 'Problems parsing JSON');
          return true;
        }
        if (isRecord(body)) {
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.private === 'boolean') repo.private = body.private;
        }
        sendJson(store, res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        if (repo === null) {
          jsonError(store, res, 404, 'Not Found');
          return true;
        }
        store.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
        res.end();
        return true;
      }
      jsonError(store, res, 404, 'Not Found');
      return true;
    }

    if (repo === null) {
      jsonError(store, res, 404, 'Not Found');
      return true;
    }

    // git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'POST') {
        jsonError(store, res, 404, 'Not Found');
        return true;
      }
      const body = parseJson(await readBody(req));
      if (body === null) {
        jsonError(store, res, 400, 'Problems parsing JSON');
        return true;
      }
      if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
        jsonError(store, res, 422, 'Validation Failed');
        return true;
      }
      const ref = body.ref as string;
      const sha = (body.sha as string).toLowerCase();
      if (!repo.objects.has(sha)) {
        jsonError(store, res, 422, 'Validation Failed: sha does not exist');
        return true;
      }
      if (repo.refs.has(ref)) {
        jsonError(store, res, 422, 'Validation Failed: ref already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(store, res, 201, { ref, node_id: `R_${ref}`, url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: 'commit', url: '' } });
      return true;
    }

    // branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') {
        jsonError(store, res, 404, 'Not Found');
        return true;
      }
      const { page, perPage } = pageParams(ctx);
      const all = [...repo.refs.entries()]
        .filter(([r]) => r.startsWith('refs/heads/'))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
      sendJson(store, res, 200, paginate(all, page, perPage));
      return true;
    }

    // commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') {
        jsonError(store, res, 404, 'Not Found');
        return true;
      }
      const shaParam = query.get('sha');
      const tip = shaParam !== null ? store.resolveRef(repo, shaParam) : (repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null);
      if (tip === null) {
        sendJson(store, res, 200, []);
        return true;
      }
      const { page, perPage } = pageParams(ctx);
      const commits = store.walkCommits(repo, tip).map((oid) => {
        const obj = repo.objects.get(oid);
        const parsed = obj !== undefined ? parseCommit(obj.data) : { tree: '', parents: [] as string[], author: '', committer: '', message: '' };
        return {
          sha: oid,
          node_id: `C_${oid}`,
          commit: {
            message: parsed.message.replace(/\n+$/, ''),
            author: { name: VIEWER_LOGIN, email: 'adaiversen@example.invalid', date: NOW_ISO },
            committer: { name: VIEWER_LOGIN, email: 'adaiversen@example.invalid', date: NOW_ISO },
            tree: { sha: parsed.tree },
          },
          parents: parsed.parents.map((p) => ({ sha: p })),
          url: `/api/v3/repos/${owner}/${name}/commits/${oid}`,
        };
      });
      sendJson(store, res, 200, paginate(commits, page, perPage));
      return true;
    }

    // contents
    if (rest.length >= 2 && rest[0] === 'contents') {
      return handleContents(ctx, repo, owner, name, rest.slice(1));
    }

    // labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'POST') {
        const body = parseJson(await readBody(req));
        if (body === null) {
          jsonError(store, res, 400, 'Problems parsing JSON');
          return true;
        }
        if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
          jsonError(store, res, 422, 'Validation Failed');
          return true;
        }
        const labelName = body.name as string;
        const color = typeof body.color === 'string' ? (body.color as string) : 'ededed';
        repo.labels.set(labelName, { name: labelName, color });
        sendJson(store, res, 201, { id: 1, node_id: `L_${labelName}`, name: labelName, color, default: false, description: '' });
        return true;
      }
      if (method === 'GET') {
        sendJson(store, res, 200, [...repo.labels.values()].map((l) => ({ id: 1, node_id: `L_${l.name}`, name: l.name, color: l.color, default: false, description: '' })));
        return true;
      }
      jsonError(store, res, 404, 'Not Found');
      return true;
    }

    // issues
    if (rest.length >= 1 && rest[0] === 'issues') {
      return handleIssues(ctx, repo, owner, name, rest.slice(1));
    }

    // pulls
    if (rest.length >= 1 && rest[0] === 'pulls') {
      return handlePulls(ctx, repo, owner, name, rest.slice(1));
    }

    jsonError(store, res, 404, 'Not Found');
    return true;
  }

  return false;
}

// ---------------------------------------------------------------- contents

async function handleContents(ctx: RestCtx, repo: Repo, owner: string, name: string, pathSegs: string[]): Promise<boolean> {
  const { store, req, res, method, query } = ctx;
  const path = pathSegs.map((s) => decodeURIComponent(s)).join('/');
  const refParam = query.get('ref');
  const branch = refParam ?? repo.defaultBranch;
  const tip = store.resolveRef(repo, branch);

  const treeAtTip = (): string | null => {
    if (tip === null) return null;
    const obj = repo.objects.get(tip);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  };

  if (method === 'GET') {
    const treeOid = treeAtTip();
    if (treeOid === null) {
      jsonError(store, res, 404, 'Not Found');
      return true;
    }
    const flat = store.flattenTree(repo, treeOid);
    const exact = flat.get(path);
    if (exact !== undefined) {
      const obj = repo.objects.get(exact.oid);
      const size = obj !== undefined ? obj.data.length : 0;
      sendJson(store, res, 200, {
        type: 'file',
        encoding: 'base64',
        size,
        name: path.split('/').pop() ?? path,
        path,
        content: obj !== undefined ? obj.data.toString('base64') : '',
        sha: exact.oid,
        url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
        html_url: `https://example.invalid/${owner}/${name}/blob/${branch}/${path}`,
      });
      return true;
    }
    // Directory listing: entries whose path is directly under `path`.
    const prefix = path === '' ? '' : `${path}/`;
    const seen = new Map<string, { name: string; path: string; sha: string; type: string }>();
    for (const [p, v] of flat) {
      if (!p.startsWith(prefix)) continue;
      const restP = p.slice(prefix.length);
      const first = restP.split('/')[0] as string;
      if (restP.includes('/')) {
        // sub-directory: find its tree oid via the tree walk
        const dirPath = `${prefix}${first}`;
        const dirOid = findTreeOid(store, repo, treeOid, dirPath);
        if (dirOid !== null && !seen.has(first)) seen.set(first, { name: first, path: dirPath, sha: dirOid, type: 'dir' });
      } else if (!seen.has(first)) {
        seen.set(first, { name: first, path: p, sha: v.oid, type: 'file' });
      }
    }
    if (seen.size === 0) {
      jsonError(store, res, 404, 'Not Found');
      return true;
    }
    const items = [...seen.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((e) => ({
        type: e.type,
        name: e.name,
        path: e.path,
        sha: e.sha,
        size: e.type === 'file' ? (repo.objects.get(e.sha)?.data.length ?? 0) : 0,
        url: `/api/v3/repos/${owner}/${name}/contents/${e.path}`,
      }));
    sendJson(store, res, 200, items);
    return true;
  }

  if (method === 'PUT') {
    const body = parseJson(await readBody(req));
    if (body === null) {
      jsonError(store, res, 400, 'Problems parsing JSON');
      return true;
    }
    if (!isRecord(body) || typeof body.content !== 'string' || typeof body.message !== 'string') {
      jsonError(store, res, 422, 'Validation Failed');
      return true;
    }
    const putBranch = typeof body.branch === 'string' ? (body.branch as string) : repo.defaultBranch;
    const putTip = store.resolveRef(repo, putBranch);
    let currentBlob: string | null = null;
    if (putTip !== null) {
      const obj = repo.objects.get(putTip);
      if (obj !== undefined && obj.type === 'commit') {
        const flat = store.flattenTree(repo, parseCommit(obj.data).tree);
        currentBlob = flat.get(path)?.oid ?? null;
      }
    }
    const shaParam = typeof body.sha === 'string' ? (body.sha as string).toLowerCase() : null;
    if (shaParam !== null) {
      if (currentBlob === null || shaParam !== currentBlob) {
        jsonError(store, res, 409, 'Conflict: sha does not match');
        return true;
      }
    }
    const existed = currentBlob !== null;
    const content = Buffer.from((body.content as string).replace(/\s+/g, ''), 'base64');
    const blobOid = store.putObject(repo, 'blob', content);
    const commitOid = store.commitContents(repo, putBranch, body.message as string, [{ path, blobOid }]);
    sendJson(store, res, existed ? 200 : 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', url: `/api/v3/repos/${owner}/${name}/contents/${path}` },
      commit: { sha: commitOid, message: body.message, author: { name: VIEWER_LOGIN, email: 'adaiversen@example.invalid', date: NOW_ISO } },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = parseJson(await readBody(req));
    if (body === null) {
      jsonError(store, res, 400, 'Problems parsing JSON');
      return true;
    }
    if (!isRecord(body) || typeof body.message !== 'string') {
      jsonError(store, res, 422, 'Validation Failed');
      return true;
    }
    const delBranch = typeof body.branch === 'string' ? (body.branch as string) : repo.defaultBranch;
    const delTip = store.resolveRef(repo, delBranch);
    let currentBlob: string | null = null;
    if (delTip !== null) {
      const obj = repo.objects.get(delTip);
      if (obj !== undefined && obj.type === 'commit') {
        const flat = store.flattenTree(repo, parseCommit(obj.data).tree);
        currentBlob = flat.get(path)?.oid ?? null;
      }
    }
    if (currentBlob === null) {
      jsonError(store, res, 404, 'Not Found');
      return true;
    }
    const shaParam = typeof body.sha === 'string' ? (body.sha as string).toLowerCase() : null;
    if (shaParam !== null && shaParam !== currentBlob) {
      jsonError(store, res, 409, 'Conflict: sha does not match');
      return true;
    }
    const commitOid = store.commitContents(repo, delBranch, body.message as string, [{ path, blobOid: null }]);
    sendJson(store, res, 200, { commit: { sha: commitOid, message: body.message } });
    return true;
  }

  jsonError(store, res, 404, 'Not Found');
  return true;
}

function findTreeOid(store: Store, repo: Repo, rootOid: string, dirPath: string): string | null {
  const parts = dirPath.split('/').filter((p) => p !== '');
  let current: string | null = rootOid;
  for (const part of parts) {
    if (current === null) return null;
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    current = entry !== undefined ? entry.oid : null;
  }
  return current;
}

// ---------------------------------------------------------------- issues

async function handleIssues(ctx: RestCtx, repo: Repo, owner: string, name: string, rest: string[]): Promise<boolean> {
  const { store, req, res, method, query } = ctx;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = parseJson(await readBody(req));
      if (body === null) {
        jsonError(store, res, 400, 'Problems parsing JSON');
        return true;
      }
      if (!isRecord(body) || typeof body.title !== 'string') {
        jsonError(store, res, 422, 'Validation Failed');
        return true;
      }
      const labels: string[] = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      for (const l of labels) {
        if (!repo.labels.has(l)) {
          jsonError(store, res, 422, `Validation Failed: label "${l}" does not exist`);
          return true;
        }
      }
      repo.seq += 1;
      const issue: Issue = {
        id: store.nextGlobalId,
        number: repo.seq,
        title: body.title as string,
        body: typeof body.body === 'string' ? (body.body as string) : '',
        state: 'open',
        labels,
        comments: [],
        seq: repo.seq,
      };
      store.nextGlobalId += 1;
      repo.issues.push(issue);
      sendJson(store, res, 201, issueJson(repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let items = repo.issues.slice();
      if (state !== 'all') items = items.filter((i) => i.state === state);
      if (sort === 'created') {
        items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, perPage } = pageParams(ctx);
      const host = req.headers.host ?? 'localhost';
      const base = `http://${host}/api/v3/repos/${owner}/${name}/issues`;
      sendJson(store, res, 200, paginate(items, page, perPage).map((i) => issueJson(repo, i)), { link: linkHeader(base, page, perPage, items.length) });
      return true;
    }
    jsonError(store, res, 404, 'Not Found');
    return true;
  }

  const num = parseInt(rest[0] as string, 10);
  if (Number.isNaN(num)) {
    jsonError(store, res, 404, 'Not Found');
    return true;
  }
  const issue = repo.issues.find((i) => i.number === num) ?? null;

  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue === null) {
        jsonError(store, res, 404, 'Not Found');
        return true;
      }
      sendJson(store, res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      if (issue === null) {
        jsonError(store, res, 404, 'Not Found');
        return true;
      }
      const body = parseJson(await readBody(req));
      if (body === null) {
        jsonError(store, res, 400, 'Problems parsing JSON');
        return true;
      }
      if (isRecord(body)) {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
      }
      sendJson(store, res, 200, issueJson(repo, issue));
      return true;
    }
    jsonError(store, res, 404, 'Not Found');
    return true;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === null) {
      jsonError(store, res, 404, 'Not Found');
      return true;
    }
    if (method === 'POST') {
      const body = parseJson(await readBody(req));
      if (body === null) {
        jsonError(store, res, 400, 'Problems parsing JSON');
        return true;
      }
      if (!isRecord(body) || typeof body.body !== 'string') {
        jsonError(store, res, 422, 'Validation Failed');
        return true;
      }
      const comment = { id: store.nextGlobalId, body: body.body as string };
      store.nextGlobalId += 1;
      issue.comments.push(comment);
      sendJson(store, res, 201, { id: comment.id, node_id: `C_${comment.id}`, body: comment.body, user: { login: VIEWER_LOGIN, id: 1000, type: 'User' }, created_at: NOW_ISO, updated_at: NOW_ISO });
      return true;
    }
    if (method === 'GET') {
      sendJson(store, res, 200, issue.comments.map((c) => ({ id: c.id, node_id: `C_${c.id}`, body: c.body, user: { login: VIEWER_LOGIN, id: 1000, type: 'User' }, created_at: NOW_ISO, updated_at: NOW_ISO })));
      return true;
    }
    jsonError(store, res, 404, 'Not Found');
    return true;
  }

  jsonError(store, res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------- pulls

function prFiles(store: Store, repo: Repo, pull: Pull) {
  const baseCommit = repo.objects.get(pull.baseSha);
  const headCommit = repo.objects.get(pull.headSha);
  const baseTree = baseCommit !== undefined && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : null;
  const headTree = headCommit !== undefined && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : null;
  return store.diffTrees(repo, baseTree, headTree).map((f) => ({
    sha: '',
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    blob_url: '',
    raw_url: '',
    contents_url: '',
    patch: '',
  }));
}

async function handlePulls(ctx: RestCtx, repo: Repo, owner: string, name: string, rest: string[]): Promise<boolean> {
  const { store, req, res, method, query } = ctx;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = parseJson(await readBody(req));
      if (body === null) {
        jsonError(store, res, 400, 'Problems parsing JSON');
        return true;
      }
      if (!isRecord(body) || typeof body.title !== 'string' || typeof body.head !== 'string' || typeof body.base !== 'string') {
        jsonError(store, res, 422, 'Validation Failed');
        return true;
      }
      const headSha = store.resolveRef(repo, body.head as string);
      const baseSha = store.resolveRef(repo, body.base as string);
      if (headSha === null || baseSha === null) {
        jsonError(store, res, 422, 'Validation Failed: head or base does not exist');
        return true;
      }
      repo.seq += 1;
      const pull: Pull = {
        id: store.nextGlobalId,
        number: repo.seq,
        title: body.title as string,
        body: typeof body.body === 'string' ? (body.body as string) : '',
        state: 'open',
        headRef: body.head as string,
        baseRef: body.base as string,
        headSha,
        baseSha,
        merged: false,
        mergedAt: '',
        mergeSha: '',
        seq: repo.seq,
      };
      store.nextGlobalId += 1;
      repo.pulls.push(pull);
      sendJson(store, res, 201, pullJson(repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = repo.pulls.slice().sort((a, b) => b.seq - a.seq);
      if (state !== 'all') items = items.filter((p) => p.state === state);
      const { page, perPage } = pageParams(ctx);
      const host = req.headers.host ?? 'localhost';
      const base = `http://${host}/api/v3/repos/${owner}/${name}/pulls`;
      sendJson(store, res, 200, paginate(items, page, perPage).map((p) => pullJson(repo, p)), { link: linkHeader(base, page, perPage, items.length) });
      return true;
    }
    jsonError(store, res, 404, 'Not Found');
    return true;
  }

  const num = parseInt(rest[0] as string, 10);
  if (Number.isNaN(num)) {
    jsonError(store, res, 404, 'Not Found');
    return true;
  }
  const pull = repo.pulls.find((p) => p.number === num) ?? null;

  if (rest.length === 1) {
    if (method === 'GET') {
      if (pull === null) {
        jsonError(store, res, 404, 'Not Found');
        return true;
      }
      sendJson(store, res, 200, pullJson(repo, pull));
      return true;
    }
    jsonError(store, res, 404, 'Not Found');
    return true;
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') {
      jsonError(store, res, 404, 'Not Found');
      return true;
    }
    if (pull === null) {
      jsonError(store, res, 404, 'Not Found');
      return true;
    }
    sendJson(store, res, 200, prFiles(store, repo, pull));
    return true;
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') {
      jsonError(store, res, 404, 'Not Found');
      return true;
    }
    if (pull === null) {
      jsonError(store, res, 404, 'Not Found');
      return true;
    }
    const body = parseJson(await readBody(req));
    if (body === null) {
      jsonError(store, res, 400, 'Problems parsing JSON');
      return true;
    }
    if (pull.merged) {
      sendJson(store, res, 200, { sha: pull.mergeSha, merged: true, message: 'Pull Request successfully merged' });
      return true;
    }
    const merged = doMerge(store, repo, pull);
    if (merged.status !== 200) {
      jsonError(store, res, merged.status, merged.message);
      return true;
    }
    sendJson(store, res, 200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }

  jsonError(store, res, 404, 'Not Found');
  return true;
}

/** Squash-merge a PR onto its base branch. Returns 200 + sha, or 405 on conflict. */
export function doMerge(store: Store, repo: Repo, pull: Pull): { status: number; message: string; sha: string } {
  if (pull.merged) return { status: 200, message: 'Pull Request successfully merged', sha: pull.mergeSha };
  // Conflict detection: a file changed on both sides since the merge-base.
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const mergeBase = findMergeBase(store, repo, pull.headSha, pull.baseSha);
  const headDiff = store.diffTrees(repo, treeOf(store, repo, mergeBase), treeOf(store, repo, pull.headSha));
  const baseDiff = store.diffTrees(repo, treeOf(store, repo, mergeBase), treeOf(store, repo, baseTip ?? pull.baseSha));
  const headPaths = new Map(headDiff.map((f) => [f.filename, f]));
  for (const bf of baseDiff) {
    if (headPaths.has(bf.filename)) {
      return { status: 405, message: 'Merge conflict: the head branch has conflicts that must be resolved', sha: '' };
    }
  }
  // Squash merge: apply head's changes onto the base tip tree.
  const baseTree = treeOf(store, repo, baseTip ?? pull.baseSha);
  let newTree = baseTree;
  const flatHead = store.flattenTree(repo, treeOf(store, repo, pull.headSha));
  for (const f of headDiff) {
    if (f.status === 'removed') newTree = store.removePath(repo, newTree, f.filename);
    else {
      const blob = flatHead.get(f.filename);
      if (blob !== undefined) newTree = store.setPath(repo, newTree, f.filename, blob.oid);
    }
  }
  if (newTree === null) newTree = store.putObject(repo, 'tree', Buffer.alloc(0));
  store.nextCommitEpoch += 1;
  const mergeOid = store.putObject(
    repo,
    'commit',
    buildCommit(newTree, baseTip !== null ? [baseTip] : [], `Merge pull request #${pull.number} from ${pull.headRef}`, store.nextCommitEpoch),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeOid);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = NOW_ISO;
  pull.mergeSha = mergeOid;
  return { status: 200, message: 'Pull Request successfully merged', sha: mergeOid };
}

function treeOf(store: Store, repo: Repo, commitOid: string | null): string | null {
  if (commitOid === null) return null;
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function findMergeBase(store: Store, repo: Repo, a: string, b: string): string | null {
  const ancestorsB = new Set(store.walkCommits(repo, b));
  for (const c of store.walkCommits(repo, a)) {
    if (ancestorsB.has(c)) return c;
  }
  return null;
}
