import { checkVendorStatus } from '@/lib/vendor-status';

export const runtime = 'nodejs';

export async function GET() {
  // Check the vendors most relevant to data pipeline triage
  const vendors = ['fivetran', 'snowflake', 'dbt', 'databricks', 'github'];
  const results = await Promise.all(vendors.map(v => checkVendorStatus(v)));

  const hasIssues = results.some(r => r.level !== 'operational' && r.level !== 'unknown');

  return Response.json({ vendors: results, hasIssues });
}
