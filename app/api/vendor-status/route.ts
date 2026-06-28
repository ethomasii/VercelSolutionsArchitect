import { checkVendorStatus } from '@/lib/vendor-status';

export const runtime = 'nodejs';

// Dagster first — if the orchestrator is down, run visibility is gone before anything else
const VENDORS = ['dagster', 'fivetran', 'snowflake', 'dbt', 'github', 'shopify', 'salesforce', 'stripe', 'databricks', 'airflow'];

export async function GET() {
  const results = await Promise.all(VENDORS.map(v => checkVendorStatus(v)));
  const hasIssues = results.some(r => r.level !== 'operational' && r.level !== 'unknown');
  return Response.json({ vendors: results, hasIssues });
}
