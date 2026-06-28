import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// GET /api/settings — returns all integration settings for org
// Secret values are masked (return true/false whether set, not the value)
export async function GET() {
  const rows = await sql`
    SELECT integration_id, key, 
      CASE WHEN is_secret THEN '••••••••' ELSE value END as value,
      is_secret,
      updated_at
    FROM integration_settings
    WHERE org_id = 'default'
    ORDER BY integration_id, key
  `;

  // Also include env-var-sourced values (show as "set via env var")
  const settings: Record<string, Record<string, { value: string | null; source: 'db' | 'env' | 'unset'; isSecret: boolean; updatedAt?: string }>> = {};

  for (const row of rows) {
    if (!settings[row.integration_id]) settings[row.integration_id] = {};
    settings[row.integration_id][row.key] = {
      value: row.value,
      source: 'db',
      isSecret: row.is_secret,
      updatedAt: row.updated_at,
    };
  }

  // Overlay env vars (show that they're set without exposing values)
  const envVarMap: Record<string, string[]> = {
    dagster: ['DAGSTER_HOST', 'DAGSTER_TOKEN'],
    github: ['GITHUB_TOKEN'],
    snowflake: ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USER', 'SNOWFLAKE_PASSWORD', 'SNOWFLAKE_WAREHOUSE'],
    fivetran: ['FIVETRAN_API_KEY', 'FIVETRAN_API_SECRET'],
    slack: ['SLACK_WEBHOOK_URL'],
    confluence: ['CONFLUENCE_BASE_URL', 'CONFLUENCE_TOKEN', 'CONFLUENCE_SPACE_KEY'],
    dbt_cloud: ['DBT_CLOUD_API_KEY', 'DBT_CLOUD_ACCOUNT_ID'],
    pagerduty: ['PAGERDUTY_API_KEY', 'PAGERDUTY_SERVICE_ID'],
  };

  for (const [integrationId, keys] of Object.entries(envVarMap)) {
    if (!settings[integrationId]) settings[integrationId] = {};
    for (const key of keys) {
      if (!settings[integrationId][key] && process.env[key]) {
        settings[integrationId][key] = {
          value: '••••••••',
          source: 'env',
          isSecret: true,
        };
      }
    }
  }

  return Response.json(settings);
}

// POST /api/settings — save one or more settings
export async function POST(req: Request) {
  const body = await req.json() as {
    integrationId: string;
    settings: Array<{ key: string; value: string; isSecret?: boolean }>;
  };

  const { integrationId, settings: newSettings } = body;

  if (!integrationId || !Array.isArray(newSettings)) {
    return Response.json({ error: 'integrationId and settings[] required' }, { status: 400 });
  }

  for (const s of newSettings) {
    if (!s.key) continue;
    // Don't overwrite a value if the user submits the masked placeholder
    if (s.value === '••••••••' || s.value === '') continue;

    await sql`
      INSERT INTO integration_settings (org_id, integration_id, key, value, is_secret)
      VALUES ('default', ${integrationId}, ${s.key}, ${s.value}, ${s.isSecret ?? false})
      ON CONFLICT ON CONSTRAINT integration_settings_unique
      DO UPDATE SET value = ${s.value}, is_secret = ${s.isSecret ?? false}, updated_at = now()
    `;
  }

  return Response.json({ ok: true, integrationId });
}

// DELETE /api/settings?integrationId=dagster — clear all settings for an integration
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const integrationId = url.searchParams.get('integrationId');
  if (!integrationId) return Response.json({ error: 'integrationId required' }, { status: 400 });

  await sql`
    DELETE FROM integration_settings
    WHERE org_id = 'default' AND integration_id = ${integrationId}
  `;

  return Response.json({ ok: true });
}
