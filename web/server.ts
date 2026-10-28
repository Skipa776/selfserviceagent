// Local application server. It serves one static page and forwards its textbox
// to POST /report, exactly like the production callers would. It parses nothing,
// decides nothing, and matches nothing: it passes text and renders a reply.
//
// It touches NONE of the stage seam: it imports buildStage2() and postReport()
// and does no more than the interactive client already does. Node's built-in `http`
// keeps the local server dependency-free.
//
//   npm run web    → http://localhost:4000
//
// Wired to real stage 2: campus AI assistant parses, and a configured ServiceNow PDI files
// the ticket. Unconfigured, the same honest degradation the rest of the system
// uses applies (keyword parse / in-memory sink) — the UI never sees a difference.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildStage2 } from '../src/composition';
import { postReport } from '../src/api';
import { snowConfigFromEnv } from '../src/adapters/servicenow';
import { compose } from '../src/composer';
import type { ReportResponse } from '../src/contracts/api';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT) || 4000;
const HOST = process.env.WEB_HOST || '127.0.0.1';
const presentationMode = process.env.WEB_PRESENTATION === '1';
const snowConfig = snowConfigFromEnv();

// One system for the process lifetime. Audit and short-lived in-memory state
// accumulate across requests; peer evidence comes from the configured adapter.
const system = buildStage2();

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (c: Buffer) => {
      if (rejected) return;
      size += c.length;
      // A public-form endpoint bounds its input; 64 KB is far more than any
      // legitimate problem description.
      if (size > 64_000) {
        rejected = true;
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function writeJson(
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function invalidRequestResponse(): ReportResponse {
  return {
    outcome: 'UNAVAILABLE',
    reply: compose({ outcome: 'UNAVAILABLE', reason: 'identity_unavailable' }),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url === '/app/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        presentationMode,
        serviceNowConfigured: snowConfig !== null,
        serviceNowReadScope: snowConfig?.readScope ?? null,
        serviceNowReadDescription:
          snowConfig === null
            ? 'ServiceNow is not configured; no ServiceNow incidents are read.'
            : snowConfig.readScope === 'all_tagged'
            ? 'Reads active ServiceNow incidents with matching integration metadata; no local cache/preload.'
            : 'Reads active incidents previously filed by this service.',
        serviceDeskQueueUrl: snowConfig === null ? null : `${snowConfig.instanceUrl}/incident_list.do`,
      }),
    );
    return;
  }

  // ── The real backend call ──────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/report') {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      writeJson(res, 400, invalidRequestResponse());
      return;
    }

    let parsed: unknown;
    try {
      if (raw.trim() === '') throw new SyntaxError('empty request body');
      parsed = JSON.parse(raw);
    } catch {
      writeJson(res, 400, invalidRequestResponse());
      return;
    }

    try {
      // postReport chooses the status code from the outcome; we relay both.
      const { status, body } = await postReport(parsed, system.deps);
      writeJson(res, status, body);
    } catch {
      writeJson(res, 503, {
        outcome: 'UNAVAILABLE',
        reply: compose({ outcome: 'UNAVAILABLE', reason: 'incident_search_failed' }),
      });
    }
    return;
  }

  // A reference page only: it does not query or mutate the ticketing system.
  if (req.method === 'GET' && url.startsWith('/ticket/')) {
    const match = /^\/ticket\/([A-Za-z0-9-]+)$/.exec(url);
    if (!match) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const ticketId = escapeHtml(match[1]);
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ticket reference ${ticketId}</title>
  <style>
    body { margin: 0; padding: 32px 20px; color: #1c2a3a; background: #f4f6f8; font: 16px/1.5 Arial, sans-serif; }
    main { max-width: 640px; margin: 10vh auto 0; padding: 28px; background: #fff; border: 1px solid #e2e7ec; border-radius: 14px; }
    h1 { margin-top: 0; color: #1e293b; font-size: 24px; }
    strong { color: #0f766e; }
  </style>
</head>
<body>
  <main>
    <h1>Existing ticket reference</h1>
    <p>Ticket <strong>${ticketId}</strong> is an existing ticket reference.</p>
    <p>No new ticket was created for the current report.</p>
    <p>Updates should be checked in the ticketing system.</p>
  </main>
</body>
</html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── The static page ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
    try {
      const html = await readFile(join(here, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('index.html not found');
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`\n  Campus Issue Reporter - local app\n`);
  process.stdout.write(`  stage-${system.deps.stage}  listening on ${HOST}:${PORT}\n`);
  process.stdout.write(`  open http://localhost:${PORT}\n\n`);
  if (presentationMode) process.stdout.write('  presentation identity simulation: enabled\n\n');
});
