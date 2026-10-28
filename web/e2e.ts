// web/e2e.ts - a dependency-free HTTP smoke test for the local web surface.
//
//   npm run web:e2e
//
// It boots the same server as npm run web, then exercises the HTTP requests made
// by the page. External configuration is explicitly blanked so this command is
// always offline and cannot create ServiceNow records.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { HUMAN_PATH } from '../src/composer';

const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}`;

type ReportResponse = {
  outcome: string;
  reply: string;
  ticket?: { ticketNumber: string; url: string };
  missingFields?: string[];
  override?: { matchId: string };
};

const KNOWN_OUTCOMES = new Set([
  'FILED_INCIDENT',
  'FILED_REQUEST',
  'MATCHED_DECLARED',
  'MATCHED_CLUSTER',
  'NEEDS_DETAIL',
  'THROTTLED',
  'UNAVAILABLE',
]);

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (ok) passed++;
  else failed++;
}

async function post(body: unknown): Promise<ReportResponse> {
  const res = await fetch(`${BASE}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as ReportResponse;
}

function isCanonicalResponse(body: ReportResponse): boolean {
  return KNOWN_OUTCOMES.has(body.outcome) && typeof body.reply === 'string' && body.reply !== '';
}

async function waitForServer(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error('server did not start in time');
}

function runServer(presentation: boolean): ChildProcessByStdio<null, Readable, Readable> {
  return spawn('npx', ['tsx', '--env-file-if-exists=.env', 'web/server.ts'], {
    env: {
      ...process.env,
      WEB_HOST: '',
      WEB_PORT: String(PORT),
      WEB_PRESENTATION: presentation ? '1' : '',
      SNOW_INSTANCE_URL: '',
      SNOW_USERNAME: '',
      SNOW_PASSWORD: '',
      LLM_API_URL: '',
      LLM_API_KEY: '',
      LLM_MODEL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function stopServer(server: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (server.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
  server.kill();
  await exited;
}

async function main(): Promise<void> {
  let serverOutput = '';
  const server = runServer(false);
  server.stdout.on('data', (chunk: Buffer) => {
    serverOutput += chunk.toString('utf8');
  });
  server.stderr.on('data', (chunk: Buffer) => {
    serverOutput += chunk.toString('utf8');
  });

  try {
    await waitForServer();
    check(
      'server defaults to 127.0.0.1 and prints its host',
      serverOutput.includes(`listening on 127.0.0.1:${PORT}`),
      serverOutput.trim(),
    );

    // 1. The page serves.
    const page = await fetch(`${BASE}/`);
    const html = await page.text();
    check('GET / serves the portal', page.ok && html.includes('Report a Problem'));
    check(
      'page exposes the mandatory override action',
      html.includes('This is not my issue - file separately'),
    );

    // 2. The app exposes only sanitized ServiceNow configuration state.
    const configResponse = await fetch(`${BASE}/app/config`);
    const config = (await configResponse.json()) as {
      presentationMode?: boolean;
      serviceNowConfigured?: boolean;
      serviceNowReadScope?: string | null;
      serviceNowReadDescription?: string;
      serviceDeskQueueUrl?: string | null;
    };
    check(
      'GET /app/config reports sanitized ServiceNow state',
      configResponse.ok &&
        config.presentationMode === false &&
        typeof config.serviceNowConfigured === 'boolean' &&
        config.serviceNowReadScope === null &&
        config.serviceNowReadDescription ===
          'ServiceNow is not configured; no ServiceNow incidents are read.',
    );
    const removedStatus = await fetch(`${BASE}/pilot/status`);
    check('removed status endpoint is 404', removedStatus.status === 404);

    // 3. Ticket references are deterministic and require no browser fixture state.
    const ticketPage = await fetch(`${BASE}/ticket/INCCANVAS0001`);
    const ticketHtml = await ticketPage.text();
    check(
      'GET /ticket/INCCANVAS0001 serves a safe reference page',
      ticketPage.status === 200 &&
        ticketHtml.includes('INCCANVAS0001') &&
        ticketHtml.includes('No new ticket was created'),
    );

    const invalidTicketPage = await fetch(`${BASE}/ticket/INC%3CBAD%3E`);
    check('invalid ticket path → 404', invalidTicketPage.status === 404);

    // 4. A vague report gets the NEEDS_DETAIL question without external calls.
    const vague = await post({ text: 'something is broken', identityRef: 'e2e-vague', canFollowUp: true });
    check(
      'vague report → NEEDS_DETAIL',
      vague.outcome === 'NEEDS_DETAIL' && Array.isArray(vague.missingFields),
      `got ${vague.outcome}`,
    );

    // 5. Ordinary reports use the public endpoint without presentation fixtures.
    const full = await post({
      text: 'the wifi in North Residence Hall keeps dropping every few minutes on my laptop',
      identityRef: 'e2e-full-' + Date.now(),
      canFollowUp: false,
    });
    check('full report -> a valid contract outcome', KNOWN_OUTCOMES.has(full.outcome), full.outcome);

    const projector = await post({
      text: 'The projector in Lecture Hall will not turn on',
      identityRef: 'e2e-projector-' + Date.now(),
      canFollowUp: false,
    });
    check('ordinary projector report returns a valid outcome', KNOWN_OUTCOMES.has(projector.outcome), projector.outcome);

    check(
      'served HTML has no removed presentation-mode behavior',
      !html.includes('Lecture Hall Demo') && !html.includes('presentation-example') &&
        !html.includes('pilotMode') && !html.includes('pilotProgress'),
    );

    // 6. Boundary failures preserve the seven-outcome response contract.
    const bad = await fetch(`${BASE}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const badBody = (await bad.json()) as ReportResponse;
    check(
      'malformed body -> canonical UNAVAILABLE with human path',
      bad.status === 400 &&
        isCanonicalResponse(badBody) &&
        badBody.outcome === 'UNAVAILABLE' &&
        badBody.reply.includes(HUMAN_PATH),
    );

    const empty = await fetch(`${BASE}/report`, { method: 'POST' });
    const emptyBody = (await empty.json()) as ReportResponse;
    check(
      'empty body -> canonical UNAVAILABLE with human path',
      empty.status === 400 &&
        isCanonicalResponse(emptyBody) &&
        emptyBody.outcome === 'UNAVAILABLE' &&
        emptyBody.reply.includes(HUMAN_PATH),
    );

    const emptyJson = await post({});
    check(
      'empty JSON object flows through postReport',
      isCanonicalResponse(emptyJson) && emptyJson.outcome === 'NEEDS_DETAIL',
      emptyJson.outcome,
    );

    const invalidShape = await post([]);
    check(
      'shape-invalid JSON flows through postReport',
      isCanonicalResponse(invalidShape) && invalidShape.outcome === 'NEEDS_DETAIL',
      invalidShape.outcome,
    );

    const oversized = await fetch(`${BASE}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(64_001) }),
    });
    const oversizedBody = (await oversized.json()) as ReportResponse;
    check(
      'oversized body -> canonical UNAVAILABLE with human path',
      oversized.status === 400 &&
        isCanonicalResponse(oversizedBody) &&
        oversizedBody.outcome === 'UNAVAILABLE' &&
        oversizedBody.reply.includes(HUMAN_PATH),
    );

    const favicon = await fetch(`${BASE}/favicon.ico`);
    check('favicon request is retained', favicon.status === 204);
  } finally {
    await stopServer(server);
  }

  const presentationServer = runServer(true);
  let presentationOutput = '';
  presentationServer.stdout.on('data', (chunk: Buffer) => {
    presentationOutput += chunk.toString('utf8');
  });
  presentationServer.stderr.on('data', (chunk: Buffer) => {
    presentationOutput += chunk.toString('utf8');
  });
  try {
    await waitForServer();
    const configResponse = await fetch(`${BASE}/app/config`);
    const config = (await configResponse.json()) as { presentationMode?: boolean };
    const page = await fetch(`${BASE}/`);
    const html = await page.text();
    check(
      'presentation app explicitly enables synthetic reporter rotation',
      config.presentationMode === true &&
        html.includes('Presentation mode simulates a new reporter') &&
        html.includes('presentationMode') &&
        html.includes('lastSubmittedIdentityRef'),
      presentationOutput.trim(),
    );
  } finally {
    await stopServer(presentationServer);
  }

  process.stdout.write(`\n  ${passed} passed, ${failed} failed\n\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  fatal: ${error instanceof Error ? error.message : 'unknown'}\n\n`);
  process.exit(1);
});
