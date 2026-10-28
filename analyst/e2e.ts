import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4124;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'synthetic-e2e-token';
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean): void {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n`);
  if (ok) passed++;
  else failed++;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(200);
  }
  throw new Error('analyst server did not start');
}

function runServer(): ChildProcessByStdio<null, Readable, Readable> {
  return spawn('npx', ['tsx', '--env-file-if-exists=.env', 'analyst/server.ts'], {
    env: {
      ...process.env,
      ANALYST_PORT: String(PORT),
      ANALYST_OPERATOR_TOKEN: TOKEN,
      ANALYST_DB_PATH: ':memory:',
      SNOW_INSTANCE_URL: '',
      SNOW_USER: '',
      SNOW_PASSWORD: '',
      LLM_API_URL: 'http://127.0.0.1:9',
      LLM_API_KEY: 'synthetic',
      LLM_MODEL: 'synthetic',
      LLM_TIMEOUT_MS: '20',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function main(): Promise<void> {
  const server = runServer();
  try {
    await waitForServer();
    check('operator page requires authentication', (await fetch(`${BASE}/operator`)).status === 401);
    check('operator login page is available', (await fetch(`${BASE}/operator/login`)).status === 200);

    const login = await fetch(`${BASE}/operator/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const csrf = login.headers.get('x-csrf-token') ?? '';
    check('one-use token creates protected session', login.status === 204 && cookie !== '' && csrf !== '');
    check('bootstrap token cannot be replayed', (await fetch(`${BASE}/operator/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ token: TOKEN }),
    })).status === 401);

    const operatorPage = await (await fetch(`${BASE}/operator`, { headers: { cookie } })).text();
    check('operator benchmark explains failure counts',
      operatorPage.includes('Field failures') &&
      operatorPage.includes('Report failures') &&
      operatorPage.includes('Failures and reliability events'));

    const report = await fetch(`${BASE}/report`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'The projector in Lecture Hall West is down', identityRef: 'analyst-e2e', canFollowUp: false }),
    });
    check('ordinary report path remains available', report.ok);

    const stateResponse = await fetch(`${BASE}/operator/state`, { headers: { cookie } });
    const state = await stateResponse.json() as { mode?: string; serviceNowCreationEnabled?: boolean; snapshots?: unknown[] };
    check('authenticated operator sees shadow evidence', stateResponse.ok && state.mode === 'shadow' && (state.snapshots?.length ?? 0) === 1);
    check('ServiceNow generalized creation stays disabled', state.serviceNowCreationEnabled === false);

    const config = await (await fetch(`${BASE}/app/config`)).json() as { serviceNowConfigured?: boolean };
    check('analyst process disables ordinary ServiceNow filing', config.serviceNowConfigured === false);

    const forbidden = await fetch(`${BASE}/operator/proposals/not-found`, {
      method: 'POST', headers: { cookie, origin: 'http://evil.example', 'x-csrf-token': csrf },
    });
    check('cross-origin mutation is rejected', forbidden.status === 403);
  } finally {
    server.kill();
  }
  process.stdout.write(`\n  ${passed} passed, ${failed} failed\n\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'analyst e2e failed'}\n`);
  process.exit(1);
});
