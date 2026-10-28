import { snowConfigFromEnv } from '../src/adapters/servicenow';

type Row = Record<string, unknown>;

type Probe = {
  readonly name: string;
  readonly status: number;
  readonly rows: readonly Row[];
};

const DICTIONARY_FIELDS = [
  'name',
  'element',
  'column_label',
  'internal_type',
  'reference',
  'choice',
  'mandatory',
  'read_only',
  'max_length',
  'default_value',
  'attributes',
  'unique',
  'sys_id',
].join(',');

async function tableGet(
  instanceUrl: string,
  authorization: string,
  timeoutMs: number,
  table: string,
  query: string,
  fields: string,
  limit = 200,
): Promise<Probe> {
  const url =
    `${instanceUrl}/api/now/table/${table}` +
    `?sysparm_query=${encodeURIComponent(query)}` +
    `&sysparm_fields=${encodeURIComponent(fields)}` +
    `&sysparm_display_value=false&sysparm_limit=${limit}`;
  const response = await fetch(url, {
    headers: { accept: 'application/json', authorization },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let rows: Row[] = [];
  if (response.ok) {
    const body = (await response.json()) as { result?: unknown };
    rows = Array.isArray(body.result) ? (body.result as Row[]) : [];
  }
  return { name: table, status: response.status, rows };
}

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function printProbe(probe: Probe): void {
  process.stdout.write(`\n[${probe.name}] HTTP ${probe.status}, ${probe.rows.length} row(s)\n`);
  for (const row of probe.rows) process.stdout.write(`${JSON.stringify(row)}\n`);
}

async function main(): Promise<number> {
  const config = snowConfigFromEnv();
  if (config === null) {
    process.stderr.write('ServiceNow credentials are not configured.\n');
    return 1;
  }

  const authorization = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`;
  process.stdout.write(`instance=${config.instanceUrl}\nincidentTable=${config.incidentTable}\n`);

  const dictionary = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_dictionary',
    `nameINtask,${config.incidentTable}^elementINimpact,urgency,priority,correlation_id,correlation_display,u_service,u_scope,u_symptom,u_location,u_reporter_hash`,
    DICTIONARY_FIELDS,
  );
  printProbe(dictionary);

  const experimentDictionary = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_dictionary',
    `nameINtask,${config.incidentTable}^elementINu_experiment_id,u_analyst_approved_at,u_analyst_approver,u_approved_payload_digest,u_shared_tracking`,
    DICTIONARY_FIELDS,
  );
  printProbe({ ...experimentDictionary, name: 'sys_dictionary:experiment-metadata' });

  const choiceElements = ['impact', 'urgency', 'priority'];
  const choices = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_choice',
    `nameINtask,${config.incidentTable}^elementIN${choiceElements.join(',')}^inactive=false^ORDERBYelement^ORDERBYsequence`,
    'name,element,label,value,sequence,inactive,language,dependent_value',
  );
  printProbe(choices);

  const dbObjects = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_db_object',
    `nameINtask,${config.incidentTable},dl_u_priority`,
    'sys_id,name,label,super_class,is_extendable',
  );
  printProbe(dbObjects);

  const access = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_security_acl',
    `nameIN${config.incidentTable},${config.incidentTable}.*,task,task.*^operationINread,create,write^active=true^ORDERBYname`,
    'name,operation,active,admin_overrides,advanced,condition,script,sys_id',
    500,
  );
  printProbe(access);

  const fieldAccess = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_security_acl',
    `nameINtask.impact,task.urgency,task.priority,task.correlation_id,task.correlation_display,${config.incidentTable}.impact,${config.incidentTable}.urgency,${config.incidentTable}.priority,${config.incidentTable}.correlation_id,${config.incidentTable}.correlation_display^operationINread,create,write^active=true^ORDERBYname`,
    'name,operation,active,admin_overrides,advanced,condition,script,sys_id',
    500,
  );
  printProbe({ ...fieldAccess, name: 'sys_security_acl:analyst-fields' });

  const experimentFieldAccess = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_security_acl',
    `nameIN${['u_experiment_id', 'u_analyst_approved_at', 'u_analyst_approver', 'u_approved_payload_digest', 'u_shared_tracking']
      .flatMap((field) => [`task.${field}`, `${config.incidentTable}.${field}`]).join(',')}^operationINread,create,write^active=true^ORDERBYname`,
    'name,operation,active,admin_overrides,advanced,condition,script,sys_id',
    500,
  );
  printProbe({ ...experimentFieldAccess, name: 'sys_security_acl:experiment-fields' });

  const aclIds = [...access.rows, ...fieldAccess.rows, ...experimentFieldAccess.rows]
    .map((row) => text(row, 'sys_id')).filter(Boolean);
  const aclRoles = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_security_acl_role',
    aclIds.length === 0 ? 'sys_idISEMPTY' : `sys_security_aclIN${aclIds.join(',')}`,
    'sys_security_acl,sys_user_role',
    500,
  );
  printProbe(aclRoles);

  const roleIds = aclRoles.rows
    .map((row) => {
      const role = row.sys_user_role;
      return typeof role === 'object' && role !== null && 'value' in role && typeof role.value === 'string'
        ? role.value
        : '';
    })
    .filter(Boolean);
  const roles = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_user_role',
    roleIds.length === 0 ? 'sys_idISEMPTY' : `sys_idIN${roleIds.join(',')}`,
    'sys_id,name,description',
    500,
  );
  printProbe(roles);

  const currentUser = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_user',
    `user_name=${config.user}`,
    'sys_id,user_name,active,web_service_access_only',
    2,
  );
  printProbe(currentUser);

  const currentUserId = currentUser.rows.map((row) => text(row, 'sys_id')).find(Boolean) ?? '';
  const currentUserRoles = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_user_has_role',
    currentUserId === '' ? 'sys_idISEMPTY' : `user=${currentUserId}`,
    'user,role,inherited,state',
    500,
  );
  printProbe(currentUserRoles);

  const objectIds = dbObjects.rows.map((row) => text(row, 'sys_id')).filter(Boolean);
  const indexes = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_db_index',
    objectIds.length === 0 ? 'sys_idISEMPTY' : `tableIN${objectIds.join(',')}`,
    'table,name,unique,sys_id',
    500,
  );
  printProbe(indexes);

  const indexIds = indexes.rows.map((row) => text(row, 'sys_id')).filter(Boolean);
  const indexColumns = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_index',
    indexIds.length === 0 ? 'sys_idISEMPTY' : `indexIN${indexIds.join(',')}^ORDERBYindex^ORDERBYposition`,
    'index,element,position',
    500,
  );
  printProbe(indexColumns);

  const priorityLookup = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'dl_u_priority',
    'sys_idISNOTEMPTY^ORDERBYimpact^ORDERBYurgency',
    'impact,urgency,priority,active,sys_id',
    100,
  );
  printProbe(priorityLookup);

  const prioritySamples = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    config.incidentTable,
    'impactISNOTEMPTY^urgencyISNOTEMPTY^priorityISNOTEMPTY^ORDERBYDESCsys_created_on',
    'number,impact,urgency,priority,sys_created_on',
    100,
  );
  printProbe({ ...prioritySamples, name: `${config.incidentTable}:priority-samples` });

  const priorityRules = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    'sys_data_lookup_definition',
    `source_table=${config.incidentTable}^ORsource_table=task`,
    'name,source_table,matcher_table,active,run_on_insert,run_on_update,sys_id',
    100,
  );
  printProbe(priorityRules);

  const readBack = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    config.incidentTable,
    'sys_idISNOTEMPTY^ORDERBYDESCsys_created_on',
    'sys_id,number,active,impact,urgency,priority,correlation_id,correlation_display,short_description,sys_created_on,sys_updated_on',
    1,
  );
  printProbe(readBack);

  const impossibleCorrelation = `analyst-inspection-${Date.now()}`;
  const correlationRead = await tableGet(
    config.instanceUrl,
    authorization,
    config.timeoutMs,
    config.incidentTable,
    `correlation_id=${impossibleCorrelation}`,
    'sys_id,number,correlation_id,correlation_display',
    2,
  );
  printProbe({ ...correlationRead, name: `${config.incidentTable}:correlation-exact-read` });

  const requiredFailures = [dictionary, choices, access, priorityLookup, readBack, correlationRead]
    .filter((probe) => probe.status < 200 || probe.status >= 300);
  if (requiredFailures.length > 0) {
    process.stderr.write(`Required inspection probes failed: ${requiredFailures.map((probe) => `${probe.name}:${probe.status}`).join(', ')}\n`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`inspection failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exit(1);
  },
);
