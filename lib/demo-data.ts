// Synthetic demo data for each integration.
// When real credentials aren't configured, return realistic data that matches
// the simulated run ID scenarios. Makes the demo feel live immediately.
//
// Each function checks: if real credentials → use real API
//                       else → return contextually appropriate synthetic data

export interface SyntheticFivetranConnector {
  id: string;
  service: string;
  schema: string;
  syncStatus: string;
  lastSyncDurationSeconds: number;
  rowsLoaded: number;
  isLikelyCause: boolean;
  note: string;
}

export interface SyntheticJiraIssue {
  key: string;
  summary: string;
  status: string;
  priority: string;
  assignee: string;
  created: string;
  url: string;
}

export interface SyntheticSnowflakeQuery {
  queryId: string;
  user: string;
  warehouseName: string;
  durationSeconds: number;
  creditsUsed: number;
  queryText: string;
  startTime: string;
}

// Returns synthetic Fivetran connector data based on the pipeline context.
// Used when FIVETRAN_API_KEY is not configured.
export function getSyntheticFivetranStatus(
  pipelineName: string,
  failureType: string
): SyntheticFivetranConnector[] {
  const name = pipelineName.toLowerCase();

  // Silent upstream failure scenario — Fivetran "succeeded" with 0 rows
  if (name.includes('order') || name.includes('shopify') || failureType === 'upstream_data_missing') {
    return [{
      id: 'orders_shopify_demo',
      service: 'shopify',
      schema: 'RAW.SHOPIFY',
      syncStatus: 'SUCCEEDED',  // ← note: shows as SUCCESS in Fivetran dashboard
      lastSyncDurationSeconds: 4,  // ← 4 seconds vs normal 8-12 minutes = red flag
      rowsLoaded: 0,  // ← 0 rows = the silent failure
      isLikelyCause: true,
      note: 'SILENT FAILURE: Fivetran reported SUCCESS but duration was 4s (normal: 8-12min) and 0 rows were loaded. Shopify API returned empty response during rate limit window.',
    }];
  }

  // Schema mismatch scenario — Fivetran working fine, issue is dbt
  if (name.includes('customer') || name.includes('salesforce') || failureType === 'schema_mismatch') {
    return [{
      id: 'salesforce_accounts_demo',
      service: 'salesforce',
      schema: 'RAW.SALESFORCE',
      syncStatus: 'SUCCEEDED',
      lastSyncDurationSeconds: 487,
      rowsLoaded: 3201,
      isLikelyCause: false,
      note: 'Fivetran sync healthy (3,201 rows, 8 min). The schema mismatch is in the dbt layer, not upstream.',
    }];
  }

  // Permission denied — Fivetran not the issue
  if (failureType === 'permission_denied') {
    return [{
      id: 'raw_data_demo',
      service: 'generic',
      schema: 'RAW',
      syncStatus: 'SUCCEEDED',
      lastSyncDurationSeconds: 320,
      rowsLoaded: 1847,
      isLikelyCause: false,
      note: 'Fivetran connector is healthy. The permission issue is in the destination (Snowflake), not in ingestion.',
    }];
  }

  return [];
}

// Returns synthetic Jira issues for a pipeline.
export function getSyntheticJiraIssues(pipelineName: string): SyntheticJiraIssue[] {
  const name = pipelineName.toLowerCase();

  if (name.includes('revenue') || name.includes('etl')) {
    return [{
      key: 'DATA-1892',
      summary: 'Revenue ETL pipeline intermittent Snowflake permission failures',
      status: 'In Progress',
      priority: 'P2',
      assignee: 'sarah-k',
      created: new Date(Date.now() - 91 * 24 * 3600000).toISOString(),
      url: 'https://your-org.atlassian.net/browse/DATA-1892',
    }];
  }

  if (name.includes('order') || name.includes('fivetran')) {
    return [{
      key: 'DATA-2341',
      summary: 'fivetran_orders_daily: Shopify rate limiting causing empty syncs',
      status: 'Open',
      priority: 'P3',
      assignee: 'marcus-t',
      created: new Date(Date.now() - 14 * 24 * 3600000).toISOString(),
      url: 'https://your-org.atlassian.net/browse/DATA-2341',
    }];
  }

  return [];
}

// Returns synthetic Snowflake concurrent query data for warehouse contention scenarios.
export function getSyntheticSnowflakeContention(
  warehouseName: string,
  failureTimeUtc: string
): SyntheticSnowflakeQuery[] {
  // Airflow dbt timeout scenario — another heavy job sharing the warehouse
  if (warehouseName.toUpperCase().includes('COMPUTE_WH')) {
    const failureTime = new Date(failureTimeUtc);
    return [{
      queryId: 'demo-q-001',
      user: 'ANALYTICS_SVC',
      warehouseName,
      durationSeconds: 11520,  // 3.2 hours
      creditsUsed: 48.3,
      queryText: 'INSERT INTO ANALYTICS.LTV.CUSTOMER_SCORES SELECT ... FROM customers c JOIN orders o ...',
      startTime: new Date(failureTime.getTime() - 7200000).toISOString(),
    }, {
      queryId: 'demo-q-002',
      user: 'DBT_SVC_ACCT',
      warehouseName,
      durationSeconds: 5640,  // 94 minutes (the dbt run that timed out)
      creditsUsed: 0,  // didn't complete
      queryText: 'SELECT ... FROM PROD.REVENUE.FCT_REVENUE WHERE ...',
      startTime: new Date(failureTime.getTime() - 5640000).toISOString(),
    }];
  }
  return [];
}
