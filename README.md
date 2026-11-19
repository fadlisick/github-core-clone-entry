# github-core-clone-01 entry

[![bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/fadlisick/github-core-clone-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/fadlisick/github-core-clone-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone git forge for [the contest](https://make.fun/bounty/github-core-clone-01): one Node 22
process, its own in-memory store, no UI, no outside service, no `git` binary, no runtime
dependencies. It serves all four surfaces the sealed suite drives as a client: git clone/push over
smart HTTP (`/<owner>/<repo>.git`), repositories + issues over REST v3 (`/api/v3`), queries over
GraphQL (`/api/graphql`), and tools over MCP (`/mcp`).

Local kit suite (kit level e20a304d): **120/120 checks, score 939/1000** (feature 600, agent 200,
perf 139; per-workload p50s — push 809 ms, clone 473 ms, read 1037 ms, write 127 ms; run-to-run
perf varies with machine load, 128–139 across three runs).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own `app.ts` only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server router (healthz, git, REST, GraphQL, MCP).
- `store.ts`: the in-memory store — repos, git objects (verbatim), trees/commits, issues, PRs,
  deterministic clock (fixed trial epoch, no wall clock in any response).
- `git.ts`: pkt-line codec, pack read/write, smart-HTTP v2 (upload-pack) + v0 (upload/receive-pack),
  shallow/deepen, non-fast-forward reporting.
- `rest.ts`: REST v3 — repos, branches, commits, contents, labels, issues, comments, pull requests,
  files, squash merge with conflict detection.
- `graphql.ts`: hand-rolled GraphQL lexer/parser/executor for the suite's documents, incl.
  introspection, batch arrays, and the five mutations (shared with REST via the same store).
- `mcp.ts`: MCP over streamable HTTP — modern `server/discover` plus legacy `initialize`, six tools.
- `http.ts`: JSON replies, request ids, auth.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

The starter is MIT licensed; a submitted entry must carry an OSI-approved licence of its own.
