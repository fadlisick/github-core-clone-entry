# github-core-clone-01 — build log

Entry: `~/workspace/makefun/github-core-clone-entry/` → GitHub `fadlisick/github-core-clone-entry`
Kit: `~/workspace/makefun/github-core-clone-kit/` (kit.json bundle_sha256 e20a304d…)
Competition: $500 pot, deadline 2026-11-21T06:30Z (21 Nov 13:30 WIB). Reference forge: 120/120, ~900/1000 (a prize needs strictly beating it).

## Local suite trials (kit sdk/run.ts, Node 22.18.0, token test-token-123)

| Run | Passed | Feature | Agent | Perf | Score | Failing |
|-----|--------|---------|-------|------|-------|---------|
| 1 (2026-11-19 ~12:20 WIB) | 89/120 | 445 | 173 | 136 | 754 | contents PUT 500 (store.objects bug), git unknown-repo 200, ls-refs prefix HEAD leak, fetch-incremental re-sent held blob, graphql/mcp PR files+merge 500s |
| 2 (~12:35 WIB) | 119/120 | 595 | 200 | 128 | 923 | repos.commits only — commit message trailing `\n` |
| 3 (~12:40 WIB) | **120/120** | **600** | **200** | **139** | **939** | none |

Per-group run 3: git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15.
Perf p50s run 3: push 808.7 ms (38 pts), clone 473.0 ms (15 pts), read 1036.5 ms (43 pts), write 127.3 ms (43 pts); perf_p50_us 473,991. Perf is noisy across runs (136/128/139) — shared VM under load from parallel lanes; clone is the weakest workload (15–30 pts, p50 199–473 ms).

## Bugs fixed between runs
1. `store.objects` does not exist — objects live on `Repo`. All `store.objects.get` → `repo.objects.get` (rest.ts ×9, graphql.ts ×2). This was the single root cause of all contents/pulls/GraphQL-PR/MCP-PR 500s.
2. `getRepo` returns `Repo | undefined`, not null — `repo === null` check in app.ts never fired; missing repo returned 200 (v2 ad branch) or 500 (v0 ad crash). Normalized with `?? null`.
3. ls-refs: HEAD entry leaked into prefix-filtered responses — omitted when `refPrefixes` non-empty.
4. Incremental fetch re-sent objects reachable from haves (shared blobs) — added `haveClosure()` (stops at shallow boundaries so deepen still works) and excluded it from the send set.
5. Commit message trailing `\n` — stripped in the REST commits lister (`parsed.message.replace(/\n+$/, '')`).

## Boot check (main.ts, starter file unchanged)
Stub env server (register + done): bound ephemeral port 41279, registered, served /healthz + /api/v3/meta, exited 0 when done=true.

## Notes / risks
- Determinism: fixed TRIAL_EPOCH (2025-01-01), counter-based request ids, no wall clock in responses.
- `git.ts` ofs-delta branch in readPack has placeholder arithmetic, voided — deltas are rejected downstream; harmless but untidy.
- Sealed suite runs on grader hardware: local perf points are indicative only; feature+agent (800/800) are the solid part.
- DO NOT bundle/submit from this session — parent handles it in a fresh session.
