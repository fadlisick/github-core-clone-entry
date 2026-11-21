// Entry point for the forge: bring the server up, tell the trial harness
// where it lives, then sit still until the harness says the trial is over.
//
// The harness (the "env") hands this process exactly one knob,
// MAKEFUN_ENV_URL. Everything else is up to this file: pick a free port,
// announce it, and wait. The forge itself lives in app.ts; this file only
// manages the conversation with the env around it.
//
// Order of events:
//   1. Read MAKEFUN_ENV_URL. No env, no trial: fail fast with exit code 1.
//   2. Start the forge on port 0 and let the OS choose the port. Port 8080
//      belongs to the env and is never used here.
//   3. POST {"port": <chosen>} to <env>/register. A 200 means the env took
//      note; a 409 means some other process registered first, which is fine
//      too — this process simply keeps waiting like everyone else. A 400 or
//      405 means the request itself is wrong, so there is nothing to retry.
//      Anything else (a dropped connection, a slow env, another status) is
//      retried with a growing pause between attempts.
//   4. Poll GET <env>/done until it answers {"done": true}. The env replies
//      immediately either way, so this is a plain poll loop, not a hanging
//      request. A failed poll just means "not done yet".
//   5. Shut the server down and leave with exit code 0.

import { createApp } from './app.ts';

// The env's base URL, without a trailing slash so paths join cleanly.
const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (ENV_ORIGIN === '') {
  process.stderr.write('entry: MAKEFUN_ENV_URL is not set, nothing to register with\n');
  process.exit(1);
}

// Longest a single register or done request may run before it is dropped.
const REQUEST_BUDGET_MS = 30_000;
// Pause schedule for retries: starts short, doubles, never exceeds the cap.
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pause before the next retry after `failures` failed attempts.
function pauseBeforeRetry(failures: number): number {
  const doubled = FIRST_PAUSE_MS * 2 ** Math.min(failures, 8);
  return Math.min(LONGEST_PAUSE_MS, doubled);
}

// A request the env answered with 400 or 405: the request is malformed and
// retrying it would never help, so it ends the program.
class BadRegisterRequest extends Error {}

async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
    } catch {
      // The env may still be starting up: wait and try again.
      await pause(pauseBeforeRetry(failures));
      failures += 1;
      continue;
    }
    if (response.status === 200 || response.status === 409) return;
    if (response.status === 400 || response.status === 405) {
      throw new BadRegisterRequest(`register refused the port with HTTP ${response.status}`);
    }
    await pause(pauseBeforeRetry(failures));
    failures += 1;
  }
}

async function waitUntilFinished(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${ENV_ORIGIN}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Unreachable env or a slow answer: same as "not done", keep polling.
    }
    await pause(pauseBeforeRetry(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => resolve());
  });
  const bound = forge.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge did not bind a TCP port');
  }
  process.stdout.write(`entry: forge listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('entry: registered, waiting for the trial to finish\n');

  await waitUntilFinished();
  forge.close();
  process.stdout.write('entry: trial finished\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`entry: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
