// Boot sequence for the forge.
//
// This process is the entrypoint the trial harness starts. It does not
// implement any git or API behaviour itself; all of that lives in app.ts.
// What it does is the short handshake with the harness environment:
//
//   - learn the env's address from MAKEFUN_ENV_URL,
//   - start the forge on a kernel-chosen port (never 8080: that one is
//     the env's own),
//   - announce the chosen port with POST <env>/register,
//   - poll GET <env>/done until the env reports the trial finished,
//   - stop the forge and leave with status 0.
//
// Every network step retries with a growing pause, because the env may
// still be coming up when this process starts. Only two situations end
// the process early: a missing MAKEFUN_ENV_URL, and a register answer
// that says the request itself was wrong (400/405).

import { createApp } from './app.ts';

// The env origin, without trailing slashes so URL building stays simple.
const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** Longest a single HTTP attempt may run before it is abandoned. */
const ATTEMPT_BUDGET_MS = 30_000;
/** Pause before the first retry, and the longest pause between retries. */
const RETRY_FIRST_MS = 250;
const RETRY_LIMIT_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after `failures` consecutive failed attempts: doubling, capped. */
function nextPauseMs(failures: number): number {
  return Math.min(RETRY_LIMIT_MS, RETRY_FIRST_MS * 2 ** Math.min(failures, 8));
}

/**
 * Announce our port to the env. Returns once the env has accepted the
 * registration. A 409 means a first registration already won; that is
 * not an error, we simply carry on waiting for the trial to end.
 */
async function announce(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let response: Response;
    try {
      response = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ATTEMPT_BUDGET_MS),
      });
    } catch {
      await pause(nextPauseMs(failures));
      continue;
    }
    if (response.status === 200 || response.status === 409) return;
    if (response.status === 400 || response.status === 405) {
      throw new Error(`register rejected with HTTP ${response.status}`);
    }
    await pause(nextPauseMs(failures));
  }
}

/** Keep asking the env whether the trial is over; return once it is. */
async function awaitFinish(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${ENV_ORIGIN}/done`, {
        signal: AbortSignal.timeout(ATTEMPT_BUDGET_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // No answer yet, or the answer was unusable: still not finished.
    }
    await pause(nextPauseMs(failures));
  }
}

/** Start the forge, announce it, and wait for the trial to finish. */
async function run(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => resolve());
  });
  const bound = forge.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('forge did not bind a TCP port');
  }
  process.stdout.write(`[boot] forge listening on ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[boot] registered with env; waiting for done\n');

  await awaitFinish();
  forge.close();
  process.stdout.write('[boot] trial finished\n');
}

if (ENV_ORIGIN === '') {
  process.stderr.write('[boot] MAKEFUN_ENV_URL is not set; nothing to register with\n');
  process.exit(1);
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[boot] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
