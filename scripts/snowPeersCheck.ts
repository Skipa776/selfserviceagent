// Read-only proof of the peer evidence visible through ServiceNowIncidentSource.
// This process performs only the adapter's GET searches and prints no identities.

import { ServiceNowIncidentSource, snowConfigFromEnv } from '../src/adapters/servicenow';

async function main(): Promise<number> {
  const config = snowConfigFromEnv();
  if (config === null) {
    process.stderr.write(
      'No ServiceNow credentials configured. Set SNOW_INSTANCE_URL, SNOW_USER and SNOW_PASSWORD.\n',
    );
    return 1;
  }

  const query = {
    service: process.env.SNOW_CHECK_SERVICE?.trim() || 'web_portal',
    scope: process.env.SNOW_CHECK_SCOPE?.trim() || 'service_wide',
    symptom: process.env.SNOW_CHECK_SYMPTOM?.trim() || 'no_connection',
    location: process.env.SNOW_CHECK_LOCATION?.trim() || '',
    building: process.env.SNOW_CHECK_BUILDING?.trim() || '',
    room: process.env.SNOW_CHECK_ROOM?.trim() || '',
  };
  const peers = await new ServiceNowIncidentSource(config).search(query);

  process.stdout.write(
    `${JSON.stringify(
      {
        readScope: config.readScope,
        query,
        count: peers.length,
        tickets: peers.map(({ id, matchScore, url }) => ({ id, matchScore, url })),
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`ServiceNow peer check failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exit(1);
  },
);
