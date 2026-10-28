// Preflight for the ServiceNow PDI — does the instance answer, and do the five
// custom columns actually exist?
//
//   npm run snow:check
//
// Reads only. Creates nothing, so it is safe to run against any instance and
// safe to run repeatedly.
//
// It exists because the columns are created by hand in a web UI, and a typo
// there fails in the worst available way: `u_reporterhash` instead of
// `u_reporter_hash` means every filed ticket silently carries no reporter hash,
// every peer read-back discards every record (correctly — match_candidate.md
// forbids synthesizing the missing field), the cluster count reads zero forever,
// and the service files a ticket every single time. Nothing errors. The feature
// is simply gone, and the only symptom is that dedup never fires — which looks
// exactly like "nobody reported the same thing twice".
//
// Thirty seconds here beats finding that during a board demo.

import { SNOW_COLUMNS, snowConfigFromEnv } from '../src/adapters/servicenow';

/** The custom columns. The two native ones need no checking — task has them. */
const CUSTOM = [
  SNOW_COLUMNS.service,
  SNOW_COLUMNS.scope,
  SNOW_COLUMNS.symptom,
  SNOW_COLUMNS.location,
  SNOW_COLUMNS.reporterHash,
];

/**
 * A column that certainly exists on `task`, queried alongside the real ones as
 * a CONTROL.
 *
 * Without it this check cannot tell two very different problems apart. A
 * non-admin account reading sys_dictionary does not get a 403 — ServiceNow ACLs
 * filter the rows and return `200 []`, which is byte-identical to "none of these
 * columns exist". Reporting the wrong one sends you into the dictionary UI to
 * create five columns that may already be there, when the actual fix is a role.
 *
 * If the control comes back, the query works and an absent column is genuinely
 * absent. If it does not, nothing else the query says can be trusted.
 */
const CONTROL = 'short_description';

type DictionaryRow = { name?: string; element?: string };

async function main(): Promise<number> {
  const config = snowConfigFromEnv();
  if (config === null) {
    process.stderr.write(
      '\n  No ServiceNow credentials configured.\n' +
        '  Set SNOW_INSTANCE_URL, SNOW_USER and SNOW_PASSWORD (see .env.example).\n\n',
    );
    return 1;
  }

  const tables = [...new Set(['task', config.incidentTable, config.requestTable])];
  process.stdout.write(`\n  instance : ${config.instanceUrl}\n  tables   : ${tables.join(', ')}\n\n`);

  // sys_dictionary is the authority on which columns exist. Asking the incident
  // table for the fields directly would tell us nothing on an empty instance —
  // ServiceNow silently drops unknown names from sysparm_fields rather than
  // erroring, which is the same failure mode this script exists to catch.
  const query = `nameIN${tables.join(',')}^elementIN${[...CUSTOM, CONTROL].join(',')}`;
  const url =
    `${config.instanceUrl}/api/now/table/sys_dictionary` +
    `?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=name,element&sysparm_limit=200`;

  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`,
    },
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!res.ok) {
    // Status only — a 401 body can echo request headers (boundaries.md).
    process.stderr.write(
      `  HTTP ${res.status}.\n` +
        (res.status === 401
          ? '  Check SNOW_USER / SNOW_PASSWORD.\n'
          : res.status === 404
            ? '  Check SNOW_INSTANCE_URL — it should have no trailing path.\n'
            : '  If the instance is hibernating, wake it at developer.servicenow.com.\n') +
        '\n',
    );
    return 1;
  }

  const body = (await res.json()) as { result?: DictionaryRow[] };
  const found = new Set((body.result ?? []).map((r) => r.element).filter((e): e is string => !!e));

  // The control, before anything else. Every finding below is meaningless if the
  // query itself cannot see the dictionary.
  if (!found.has(CONTROL)) {
    process.stderr.write(
      `  Cannot read sys_dictionary — the control column '${CONTROL}' is not visible\n` +
        '  either, and it certainly exists on `task`.\n\n' +
        '  This is a ROLE problem, not a missing-column problem. ServiceNow filters\n' +
        '  dictionary rows by ACL and returns an empty list rather than a 403, so it\n' +
        '  looks identical to "the columns were never created".\n\n' +
        '  Give SNOW_USER the admin role, or check you are pointed at the instance\n' +
        '  you think you are. Do not go create columns yet — they may already exist.\n\n',
    );
    return 1;
  }

  for (const column of CUSTOM) {
    const on = (body.result ?? []).filter((r) => r.element === column).map((r) => r.name);
    process.stdout.write(
      found.has(column)
        ? `  ok      ${column.padEnd(18)} on ${on.join(', ')}\n`
        : `  MISSING ${column}\n`,
    );
  }

  const missing = CUSTOM.filter((c) => !found.has(c));
  if (missing.length > 0) {
    process.stdout.write(
      `\n  ${missing.length} column(s) missing. Create them as String columns on the\n` +
        '  `task` table (both incident and sc_request inherit) — System Definition →\n' +
        '  Tables → task → Columns → New. Set the column NAME explicitly rather than\n' +
        '  letting it derive from the label.\n\n' +
        '  Until they exist, buildStage2() still runs: tickets file with missing\n' +
        '  fields and peer read-back discards every record, so the service files\n' +
        '  every time instead of ever deflecting.\n\n',
    );
    return 1;
  }

  process.stdout.write('\n  All five columns present. The PDI adapter prerequisites are satisfied.\n\n');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`\n  check failed: ${error instanceof Error ? error.message : 'unknown'}\n\n`);
    process.exit(1);
  },
);
