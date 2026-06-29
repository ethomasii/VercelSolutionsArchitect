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

// ---------------------------------------------------------------------------
// Synthetic Databricks context
// Provides realistic Databricks job/cluster data for triage when no
// Databricks token is configured. Real: lib/integrations/databricks.ts.
// ---------------------------------------------------------------------------
export interface SyntheticDatabricksJob {
  jobId: string;
  jobName: string;
  runId: string;
  clusterType: 'job_cluster' | 'existing_cluster';
  clusterSpec: string;
  startTime: string;
  durationSeconds: number;
  terminationCode: string;
  errorMessage: string;
  notebookPath?: string;
  sparkVersion: string;
  nodeType: string;
  numWorkers: number;
  spotPreempted: boolean;
  oomKilled: boolean;
  unityLineage?: { upstreamTables: string[]; downstreamTables: string[] };
}

export function getSyntheticDatabricksJob(pipelineName: string, errorHint?: string): SyntheticDatabricksJob | null {
  const name = pipelineName.toLowerCase();
  const isOOM = errorHint?.toLowerCase().includes('oom') || errorHint?.toLowerCase().includes('memory') || name.includes('ml') || name.includes('train');
  const isSpot = errorHint?.toLowerCase().includes('spot') || errorHint?.toLowerCase().includes('preempt');
  const isTimeout = name.includes('etl') || name.includes('batch');

  if (!name.includes('databricks') && !name.includes('spark') && !name.includes('ml') && !errorHint?.includes('Databricks')) {
    return null;
  }

  const now = new Date();
  if (isOOM) {
    return {
      jobId: 'demo-job-411',
      jobName: `${pipelineName}_training_job`,
      runId: 'demo-run-77182',
      clusterType: 'job_cluster',
      clusterSpec: 'Standard_DS3_v2 × 4 workers',
      startTime: new Date(now.getTime() - 3600000).toISOString(),
      durationSeconds: 3240,
      terminationCode: 'CLUSTER_ERROR',
      errorMessage: 'com.databricks.backend.daemon.driver.DriverClient$DriverDied: Driver killed due to memory pressure. Consider upgrading to a memory-optimized instance (Standard_E8s_v3) or reducing batch size.',
      notebookPath: '/Repos/ml-platform/feature_engineering/customer_ltv_features',
      sparkVersion: '14.3.x-scala2.12',
      nodeType: 'Standard_DS3_v2',
      numWorkers: 4,
      spotPreempted: false,
      oomKilled: true,
      unityLineage: {
        upstreamTables: ['hive_metastore.raw.customer_events', 'main.analytics.fct_orders'],
        downstreamTables: ['main.ml_features.customer_ltv_v2'],
      },
    };
  } else if (isSpot) {
    return {
      jobId: 'demo-job-388',
      jobName: `${pipelineName}_etl_job`,
      runId: 'demo-run-55901',
      clusterType: 'job_cluster',
      clusterSpec: 'Spot: Standard_DS4_v2 × 8 workers',
      startTime: new Date(now.getTime() - 7200000).toISOString(),
      durationSeconds: 1820,
      terminationCode: 'CLOUD_PROVIDER_SHUTDOWN',
      errorMessage: 'Cluster terminated by cloud provider (spot preemption). The cluster was using spot instances which can be reclaimed at any time. Use on-demand instances for production jobs or configure automatic retry on spot preemption.',
      notebookPath: '/Repos/data-eng/pipelines/nightly_etl',
      sparkVersion: '14.3.x-scala2.12',
      nodeType: 'Standard_DS4_v2',
      numWorkers: 8,
      spotPreempted: true,
      oomKilled: false,
    };
  } else {
    return {
      jobId: 'demo-job-502',
      jobName: `${pipelineName}_notebook_job`,
      runId: 'demo-run-81234',
      clusterType: 'existing_cluster',
      clusterSpec: 'Shared compute cluster (data-eng-prod)',
      startTime: new Date(now.getTime() - 5400000).toISOString(),
      durationSeconds: isTimeout ? 5400 : 920,
      terminationCode: isTimeout ? 'TIMEOUT' : 'RUN_EXECUTION_ERROR',
      errorMessage: isTimeout
        ? 'Job run exceeded maximum duration of 90 minutes. The job was processing 3.2GB of unpartitioned data — add date partition pruning to reduce scan size.'
        : 'PySpark: AnalysisException: Column not found: customer_tier. Schema changed in upstream table main.raw.customers (migration 2026-06-27).',
      notebookPath: '/Repos/data-eng/pipelines/revenue_aggregation',
      sparkVersion: '14.3.x-scala2.12',
      nodeType: 'Standard_DS3_v2',
      numWorkers: 4,
      spotPreempted: false,
      oomKilled: false,
      unityLineage: {
        upstreamTables: ['main.raw.customers', 'main.raw.orders', 'main.staging.payments'],
        downstreamTables: ['main.analytics.mart_revenue', 'main.reporting.revenue_dashboard'],
      },
    };
  }
}

