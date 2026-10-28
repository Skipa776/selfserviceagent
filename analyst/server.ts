import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AnalystSessionStore } from '../src/analyst/session';
import { AnalystWorkspace } from '../src/analyst/workspace';
import { postReport } from '../src/api';
import { buildStage2 } from '../src/composition';
import { llmClientFromEnv } from '../src/parser/chatClient';
import { snowConfigFromEnv } from '../src/adapters/servicenow';

const here = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.ANALYST_PORT) || 4100;
const bootstrapToken = process.env.ANALYST_OPERATOR_TOKEN?.trim() || randomBytes(24).toString('hex');
const client = llmClientFromEnv();
if (client === null) throw new Error('analyst demo requires configured LLM provider credentials');
const snowConfig = snowConfigFromEnv();

// Shadow means shadow: ordinary reports in this process use the in-memory sink,
// even when ServiceNow credentials exist in the shell.
const system = buildStage2({ client, snow: null });
const workspace = new AnalystWorkspace(
  process.env.ANALYST_DB_PATH?.trim() || '.analyst-demo.sqlite',
  client,
);
const sessions = new AnalystSessionStore(bootstrapToken);
let ingested = 0;

type BenchmarkArtifact = {
  readonly measuredAt?: string;
  readonly rows?: number;
  readonly runs?: number;
  readonly results?: readonly unknown[];
};

async function benchmarkArtifact(): Promise<BenchmarkArtifact | null> {
  try {
    return JSON.parse(await readFile('analyst-model-benchmark.json', 'utf8')) as BenchmarkArtifact;
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function text(res: ServerResponse, status: number, value: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(value);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64_000) reject(new Error('body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function cookie(req: IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === `http://${HOST}:${PORT}`;
}

function ingestNewEvents(): void {
  const fresh = system.stream.events.slice(ingested);
  workspace.ingest(fresh);
  ingested = system.stream.events.length;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/operator/login') {
      const html = await readFile(join(here, 'login.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/operator/login') {
      if (!sameOrigin(req)) return text(res, 403, 'forbidden');
      const body = await readBody(req).catch(() => null) as { token?: unknown } | null;
      const session = sessions.login(typeof body?.token === 'string' ? body.token : '');
      if (session === null) return text(res, 401, 'invalid or already-used operator token');
      res.writeHead(204, {
        'set-cookie': `analyst_session=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`,
        'x-csrf-token': session.csrfToken,
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    const sessionId = cookie(req, 'analyst_session');
    const session = sessions.authenticate(sessionId);
    if (url.pathname.startsWith('/operator') && session === null) {
      return text(res, 401, 'operator authentication required');
    }

    if (req.method === 'GET' && url.pathname === '/operator') {
    const html = await readFile(join(here, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
    }

    if (req.method === 'GET' && url.pathname === '/operator/state') {
      ingestNewEvents();
      return json(res, 200, {
      ...workspace.status(),
      csrfToken: session?.csrfToken,
      snapshots: workspace.snapshots().map((snapshot) => ({
        ...snapshot,
        proposal: workspace.proposal(snapshot.snapshotId),
        proposalDigest: workspace.proposalDigest(snapshot.snapshotId),
      })),
        createBlocker: 'PDI experiment metadata and least-privilege ACLs are not configured.',
        benchmark: await benchmarkArtifact(),
        sharedTickets: workspace.sharedTickets(),
      });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/operator/proposals/')) {
    if (!sameOrigin(req) || sessions.authorizeMutation(sessionId, String(req.headers['x-csrf-token'] ?? '')) === null) {
      return text(res, 403, 'mutation authorization failed');
    }
    ingestNewEvents();
    const snapshotId = decodeURIComponent(url.pathname.slice('/operator/proposals/'.length));
    const result = await workspace.generate(snapshotId);
    return json(res, result.ok ? 200 : 422, result);
    }

    if (req.method === 'POST' && url.pathname.startsWith('/operator/approvals/')) {
    const authorized = sameOrigin(req)
      ? sessions.authorizeMutation(sessionId, String(req.headers['x-csrf-token'] ?? ''))
      : null;
    if (authorized === null) return text(res, 403, 'mutation authorization failed');
    ingestNewEvents();
    const snapshotId = decodeURIComponent(url.pathname.slice('/operator/approvals/'.length));
    const body = await readBody(req).catch(() => null) as { proposalDigest?: unknown } | null;
    const proposalDigest = typeof body?.proposalDigest === 'string' ? body.proposalDigest : '';
    const result = workspace.approve(snapshotId, proposalDigest, authorized.approver);
    return json(res, result.ok ? 200 : 409, result);
    }

    if (req.method === 'POST' && url.pathname === '/report') {
      const body = await readBody(req).catch(() => null);
      if (body === null) return text(res, 400, 'invalid request');
      const result = await postReport(body, system.deps);
      ingestNewEvents();
      return json(res, result.status, result.body);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/operator/shared/')) {
      const ticketNumber = decodeURIComponent(url.pathname.slice('/operator/shared/'.length));
      const ticket = workspace.sharedTickets().find((candidate) => candidate.ticketNumber === ticketNumber);
      return ticket === undefined ? text(res, 404, 'shared ticket not found') : json(res, 200, ticket);
    }

    if (req.method === 'GET' && url.pathname === '/') {
    const html = await readFile(join(here, '../web/index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
    }

    if (req.method === 'GET' && url.pathname === '/app/config') {
      return json(res, 200, {
        presentationMode: true,
      serviceNowConfigured: false,
      serviceNowReadScope: null,
      serviceNowReadDescription: 'Shadow analyst profile; ServiceNow reads and writes are disabled in this process.',
      serviceDeskQueueUrl: snowConfig === null ? null : `${snowConfig.instanceUrl}/incident_list.do`,
      });
    }

    text(res, 404, 'not found');
  } catch {
    text(res, 500, 'analyst demo request failed');
  }
});

function shutdown(): void {
  server.close(() => {
    workspace.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => {
  process.stdout.write(`\nAI Incident Analyst demo listening on http://${HOST}:${PORT}\n`);
  process.stdout.write(`Operator login: http://${HOST}:${PORT}/operator/login\n`);
  process.stdout.write(`Operator login token: ${bootstrapToken}\n`);
  process.stdout.write('ServiceNow generalized creation: disabled by PDI readiness gate\n\n');
});
