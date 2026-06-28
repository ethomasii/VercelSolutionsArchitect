// Vendor Status Checker — calls real StatusPage.io APIs to get current incident status.
//
// Most data vendors (Fivetran, Snowflake, dbt Cloud, Stripe, Databricks, GitHub, Airflow)
// use StatusPage.io which exposes a standard /api/v2/summary.json endpoint.
// No auth required — these are public status pages.
//
// This gives the agent context that NO orchestration vendor provides:
// "Fivetran sync failed AND Fivetran is reporting an API incident"
// → the root cause is a vendor outage, not a code bug.

export type VendorStatusLevel = 'operational' | 'degraded' | 'outage' | 'unknown';

export interface VendorStatus {
  vendor: string;
  indicator: string;
  description: string;
  level: VendorStatusLevel;
  statusPageUrl: string;
  checkedAt: string;
  activeIncidents: Array<{
    name: string;
    status: string;
    impact: string;
    startedAt: string;
  }>;
}

// StatusPage.io summary.json response shape
interface StatusPageSummary {
  status?: { indicator?: string; description?: string };
  incidents?: Array<{
    name?: string;
    status?: string;
    impact?: string;
    created_at?: string;
  }>;
}

const VENDOR_STATUS_URLS: Record<string, { url: string; statusPage: string }> = {
  fivetran: {
    url: 'https://status.fivetran.com/api/v2/summary.json',
    statusPage: 'https://status.fivetran.com',
  },
  snowflake: {
    url: 'https://status.snowflake.com/api/v2/summary.json',
    statusPage: 'https://status.snowflake.com',
  },
  dbt: {
    url: 'https://status.getdbt.com/api/v2/summary.json',
    statusPage: 'https://status.getdbt.com',
  },
  databricks: {
    url: 'https://status.databricks.com/api/v2/summary.json',
    statusPage: 'https://status.databricks.com',
  },
  github: {
    url: 'https://www.githubstatus.com/api/v2/summary.json',
    statusPage: 'https://www.githubstatus.com',
  },
  stripe: {
    url: 'https://status.stripe.com/api/v2/summary.json',
    statusPage: 'https://status.stripe.com',
  },
  shopify: {
    url: 'https://www.shopifystatus.com/api/v2/summary.json',
    statusPage: 'https://www.shopifystatus.com',
  },
  salesforce: {
    url: 'https://status.salesforce.com/api/v2/summary.json',
    statusPage: 'https://status.salesforce.com',
  },
  airflow: {
    url: 'https://status.astronomer.io/api/v2/summary.json',
    statusPage: 'https://status.astronomer.io',
  },
  prefect: {
    url: 'https://status.prefect.io/api/v2/summary.json',
    statusPage: 'https://status.prefect.io',
  },
  airbyte: {
    url: 'https://status.airbyte.com/api/v2/summary.json',
    statusPage: 'https://status.airbyte.com',
  },
};

// Map pipeline name keywords to vendor status checks
export function detectVendors(pipelineName: string, failureType: string): string[] {
  const name = pipelineName.toLowerCase();
  const vendors: string[] = [];

  if (name.includes('fivetran') || name.includes('orders') && failureType === 'upstream_data_missing') vendors.push('fivetran');
  if (name.includes('snowflake') || name.includes('raw') || name.includes('warehouse')) vendors.push('snowflake');
  if (name.includes('dbt')) vendors.push('dbt');
  if (name.includes('databricks') || name.includes('spark') || name.includes('ml')) vendors.push('databricks');
  if (name.includes('shopify') || name.includes('orders')) vendors.push('shopify');
  if (name.includes('salesforce') || name.includes('crm')) vendors.push('salesforce');
  if (name.includes('stripe') || name.includes('payment')) vendors.push('stripe');
  if (name.includes('github') || name.includes('git')) vendors.push('github');
  if (name.includes('airflow') || name.includes('astronomer')) vendors.push('airflow');

  // Always include the primary data source vendor based on failure type
  if (failureType === 'upstream_data_missing' && !vendors.includes('fivetran')) {
    vendors.push('fivetran');
  }

  // Deduplicate and limit to 3 (avoid too many requests)
  return [...new Set(vendors)].slice(0, 3);
}

function normalizeIndicator(indicator?: string): VendorStatusLevel {
  const i = (indicator ?? 'none').toLowerCase();
  if (i === 'none') return 'operational';
  if (i === 'minor') return 'degraded';
  if (i === 'major' || i === 'critical') return 'outage';
  return 'unknown';
}

export async function checkVendorStatus(vendor: string): Promise<VendorStatus> {
  const config = VENDOR_STATUS_URLS[vendor.toLowerCase()];
  const checkedAt = new Date().toISOString();

  if (!config) {
    return {
      vendor,
      indicator: 'unknown',
      description: 'No status page configured for this vendor',
      level: 'unknown',
      statusPageUrl: '',
      checkedAt,
      activeIncidents: [],
    };
  }

  try {
    const res = await fetch(config.url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000), // 5s timeout per vendor
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json() as StatusPageSummary;
    const indicator = data.status?.indicator ?? 'none';
    const description = data.status?.description ?? 'Unknown';

    const activeIncidents = (data.incidents ?? [])
      .filter(inc => inc.status !== 'resolved')
      .map(inc => ({
        name: inc.name ?? 'Unknown incident',
        status: inc.status ?? 'investigating',
        impact: inc.impact ?? 'unknown',
        startedAt: inc.created_at ?? checkedAt,
      }));

    return {
      vendor,
      indicator,
      description,
      level: normalizeIndicator(indicator),
      statusPageUrl: config.statusPage,
      checkedAt,
      activeIncidents,
    };
  } catch (err) {
    // Don't fail the triage if a status page is unreachable
    return {
      vendor,
      indicator: 'unknown',
      description: `Could not reach status page: ${err instanceof Error ? err.message : String(err)}`,
      level: 'unknown',
      statusPageUrl: config.statusPage,
      checkedAt,
      activeIncidents: [],
    };
  }
}
