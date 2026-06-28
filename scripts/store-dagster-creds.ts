import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

import { encryptSecret } from '../lib/encryption';
import { sql } from '../lib/db';

const settings = [
  { key: 'DAGSTER_TOKEN', value: 'user:bf880158745b480681bf62cb7038273f', isSecret: true },
  { key: 'DAGSTER_ORG', value: 'hooli', isSecret: false },
  { key: 'DAGSTER_HOST', value: 'https://hooli.dagster.cloud', isSecret: false },
  { key: 'DAGSTER_DEPLOYMENT', value: 'data-eng-prod', isSecret: false },
];

async function storeSettings() {
  for (const s of settings) {
    const stored = s.isSecret ? encryptSecret(s.value) : s.value;
    await sql`
      INSERT INTO integration_settings (org_id, integration_id, instance_name, key, value, is_secret)
      VALUES ('default', 'dagster', 'default', ${s.key}, ${stored}, ${s.isSecret})
      ON CONFLICT ON CONSTRAINT integration_settings_unique
      DO UPDATE SET value = ${stored}, updated_at = now()
    `;
    console.log('✅ Saved:', s.key, s.isSecret ? '(encrypted)' : `= ${s.value}`);
  }
  console.log('\n✨ Dagster credentials stored and encrypted in Neon.');
}

storeSettings().catch(err => { console.error('Failed:', err); process.exit(1); });
