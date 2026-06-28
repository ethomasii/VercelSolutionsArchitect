import { sql } from '@/lib/db';
import { encryptSecret, decryptSecret, isEncrypted, MASK } from '@/lib/encryption';

export const runtime = 'nodejs';

// GET /api/settings — returns all settings, secrets masked
export async function GET() {
  const rows = await sql`
    SELECT integration_id, instance_name, key, value, is_secret, updated_at
    FROM integration_settings
    WHERE org_id = 'default'
    ORDER BY integration_id, instance_name, key
  `;

  // Build: { [integrationId]: { [instanceName]: { [key]: {...} } } }
  const settings: Record<string, Record<string, Record<string, {
    value: string | null;
    source: 'db' | 'env';
    isSecret: boolean;
    isSet: boolean;
    updatedAt?: string;
  }>>> = {};

  for (const row of rows) {
    const iid = row.integration_id as string;
    const inst = row.instance_name as string;
    const k = row.key as string;
    if (!settings[iid]) settings[iid] = {};
    if (!settings[iid][inst]) settings[iid][inst] = {};

    const rawValue = row.value as string | null;
    const isSecret = row.is_secret as boolean;

    settings[iid][inst][k] = {
      value: rawValue && isSecret ? MASK : rawValue,
      source: 'db',
      isSecret,
      isSet: !!rawValue,
      updatedAt: row.updated_at as string,
    };
  }

  // Overlay env vars — show they exist without exposing values
  const envVarMap: Record<string, string[]> = {
    dagster: ['DAGSTER_HOST', 'DAGSTER_TOKEN', 'DAGSTER_ORG'],
    github: ['GITHUB_TOKEN', 'GITHUB_REPO_OWNER', 'GITHUB_REPO_NAME'],
    snowflake: ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USER', 'SNOWFLAKE_PASSWORD', 'SNOWFLAKE_WAREHOUSE'],
    fivetran: ['FIVETRAN_API_KEY', 'FIVETRAN_API_SECRET'],
    slack: ['SLACK_WEBHOOK_URL'],
    confluence: ['CONFLUENCE_BASE_URL', 'CONFLUENCE_TOKEN', 'CONFLUENCE_SPACE_KEY'],
    dbt_cloud: ['DBT_CLOUD_API_KEY', 'DBT_CLOUD_ACCOUNT_ID'],
    pagerduty: ['PAGERDUTY_API_KEY', 'PAGERDUTY_SERVICE_ID'],
    airflow: ['AIRFLOW_HOST', 'AIRFLOW_API_KEY'],
    prefect: ['PREFECT_API_URL', 'PREFECT_API_KEY'],
  };

  for (const [iid, keys] of Object.entries(envVarMap)) {
    for (const key of keys) {
      if (process.env[key]) {
        if (!settings[iid]) settings[iid] = {};
        if (!settings[iid]['default']) settings[iid]['default'] = {};
        if (!settings[iid]['default'][key]) {
          settings[iid]['default'][key] = {
            value: MASK,
            source: 'env',
            isSecret: true,
            isSet: true,
          };
        }
      }
    }
  }

  return Response.json(settings);
}

// POST /api/settings
export async function POST(req: Request) {
  const body = await req.json() as {
    integrationId: string;
    instanceName?: string;
    settings: Array<{ key: string; value: string; isSecret?: boolean }>;
  };

  const { integrationId, instanceName = 'default', settings: newSettings } = body;

  if (!integrationId || !Array.isArray(newSettings)) {
    return Response.json({ error: 'integrationId and settings[] required' }, { status: 400 });
  }

  for (const s of newSettings) {
    if (!s.key || !s.value || s.value === MASK || s.value === '') continue;

    // Always encrypt secret values before storing
    const storedValue = s.isSecret ? encryptSecret(s.value) : s.value;

    await sql`
      INSERT INTO integration_settings (org_id, integration_id, instance_name, key, value, is_secret)
      VALUES ('default', ${integrationId}, ${instanceName}, ${s.key}, ${storedValue}, ${s.isSecret ?? false})
      ON CONFLICT ON CONSTRAINT integration_settings_unique
      DO UPDATE SET value = ${storedValue}, is_secret = ${s.isSecret ?? false}, updated_at = now()
    `;
  }

  return Response.json({ ok: true, integrationId, instanceName });
}

// DELETE /api/settings?integrationId=dagster&instanceName=production
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const integrationId = url.searchParams.get('integrationId');
  const instanceName = url.searchParams.get('instanceName');

  if (!integrationId) return Response.json({ error: 'integrationId required' }, { status: 400 });

  if (instanceName) {
    await sql`DELETE FROM integration_settings WHERE org_id = 'default' AND integration_id = ${integrationId} AND instance_name = ${instanceName}`;
  } else {
    await sql`DELETE FROM integration_settings WHERE org_id = 'default' AND integration_id = ${integrationId}`;
  }

  return Response.json({ ok: true });
}

// GET /api/settings/value?integrationId=dagster&key=DAGSTER_TOKEN&instanceName=default
// Returns the decrypted value — called server-side only, never from client
export async function PATCH(req: Request) {
  const { integrationId, key, instanceName = 'default' } = await req.json() as {
    integrationId: string; key: string; instanceName?: string;
  };

  // First check DB
  const rows = await sql`
    SELECT value FROM integration_settings
    WHERE org_id = 'default'
      AND integration_id = ${integrationId}
      AND instance_name = ${instanceName}
      AND key = ${key}
    LIMIT 1
  `;

  if (rows[0]?.value) {
    const raw = rows[0].value as string;
    return Response.json({ value: isEncrypted(raw) ? decryptSecret(raw) : raw, source: 'db' });
  }

  // Fall back to env var
  const envValue = process.env[key];
  if (envValue) {
    return Response.json({ value: envValue, source: 'env' });
  }

  return Response.json({ value: null, source: 'unset' });
}
