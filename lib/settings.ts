// Read a setting: DB first (decrypted), then env var fallback.
// Used by all integration modules to get their credentials.

import { sql } from './db';
import { decryptSecret, isEncrypted } from './encryption';

export async function getSetting(
  integrationId: string,
  key: string,
  instanceName = 'default'
): Promise<string | null> {
  // 1. Check DB (encrypted secrets stored here from /settings UI)
  try {
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
      return isEncrypted(raw) ? decryptSecret(raw) : raw;
    }
  } catch {
    // DB unavailable — fall through to env var
  }

  // 2. Fall back to env var
  return process.env[key] ?? null;
}

export async function getIntegrationSettings(
  integrationId: string,
  instanceName = 'default'
): Promise<Record<string, string>> {
  const rows = await sql`
    SELECT key, value FROM integration_settings
    WHERE org_id = 'default'
      AND integration_id = ${integrationId}
      AND instance_name = ${instanceName}
  `.catch(() => []);

  const result: Record<string, string> = {};
  for (const row of rows) {
    const raw = row.value as string | null;
    if (raw) {
      result[row.key as string] = isEncrypted(raw) ? decryptSecret(raw) : raw;
    }
  }
  return result;
}
