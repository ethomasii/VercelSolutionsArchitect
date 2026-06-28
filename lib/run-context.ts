// Run Context Resolver — translates a run ID into an enriched context prompt.
//
// Today: returns simulated run contexts demonstrating key failure patterns.
// Production upgrade: replace each case with real API calls:
//   - Dagster: GraphQL API or Dagster MCP server
//   - dbt Cloud: GET /api/v2/accounts/{account_id}/runs/{run_id}/
//   - Airflow: GET /api/v1/dags/{dag_id}/dagRuns/{dag_run_id}/taskInstances
//   - Prefect: GET /api/runs/{flow_run_id}
//
// The key architectural point: the agent receives an ENRICHED PROMPT that includes
// dependency graph, upstream run results, and cross-tool context — not just a raw
// error log. This is what Dagster MCP provides for free when wired up.

export interface RunContext {
  runId: string;
  orchestrator: 'dagster' | 'airflow' | 'dbt-cloud' | 'prefect' | 'unknown';
  failedAsset: string;
  startedAt: string;
  failedAt: string;
  enrichedPrompt: string;
  source: 'simulated' | 'dagster_api' | 'dbt_cloud_api' | 'airflow_api';
}

// Pre-populated run IDs for the demo. Each one demonstrates a different failure pattern.
export const SAMPLE_RUN_IDS: Array<{ id: string; label: string; description: string }> = [
  {
    id: 'dag-run-silent-upstream',
    label: 'Silent upstream failure (Fivetran succeeded, 0 rows)',
    description: 'Fivetran reported SUCCESS but loaded 0 new rows. Snowflake dbt tests failed with nulls. Classic "succeeded but broken" pattern.',
  },
  {
    id: 'dag-run-schema-drift',
    label: 'Multi-tool schema drift (dbt → Snowflake → Salesforce)',
    description: 'Salesforce added a new field, Fivetran synced it, dbt downstream refs broke. Requires context from 3 tools to understand.',
  },
  {
    id: 'dag-run-airflow-dbt-timeout',
    label: 'Airflow-orchestrated dbt timeout (resource contention)',
    description: 'Airflow triggered dbt at the same time as another heavy Snowflake job. Warehouse contention caused timeout on a model that usually runs in 2 minutes.',
  },
];

export async function resolveRunId(runId: string): Promise<RunContext | null> {
  // TODO: Replace these stubs with real API calls based on orchestrator detection:
  //   if (runId.startsWith('dagster:')) return fetchDagsterRun(runId)
  //   if (runId.startsWith('dbt:')) return fetchDbtCloudRun(runId)
  //   if (runId.startsWith('airflow:')) return fetchAirflowRun(runId)
  //   return detectOrchestratorAndFetch(runId)

  const normalized = runId.trim().toLowerCase();

  if (normalized.includes('silent-upstream')) {
    return buildSilentUpstreamContext(runId);
  }
  if (normalized.includes('schema-drift')) {
    return buildSchemaDriftContext(runId);
  }
  if (normalized.includes('airflow-dbt')) {
    return buildAirflowDbtContext(runId);
  }

  return null;
}

// -------------------------------------------------------------------
// Scenario 1: Silent upstream failure
// Fivetran shows SUCCESS but loaded 0 new rows. dbt tests fail with nulls.
// The signal is in the ROW COUNT, not the status code.
// -------------------------------------------------------------------
function buildSilentUpstreamContext(runId: string): RunContext {
  const now = new Date();
  const failedAt = new Date(now.getTime() - 45 * 60000).toISOString();
  const startedAt = new Date(now.getTime() - 60 * 60000).toISOString();

  const enrichedPrompt = `Triage pipeline failure for run: ${runId}

ORCHESTRATOR CONTEXT (Dagster):
- Orchestrator: Dagster
- Failed asset: dbt_orders_mart
- Run started: ${startedAt}
- Run failed at: ${failedAt}
- Error: dbt test not_null_fct_orders_order_id FAIL (8,291 failures)

ASSET DEPENDENCY GRAPH:
  dbt_orders_mart
    └── stg_orders          (source: Shopify via Fivetran)
    └── stg_order_items     (source: Shopify via Fivetran)
    └── dim_customers       (upstream dbt model)

UPSTREAM RUN RESULTS (last 6 hours, same Dagster workspace):
  fivetran_orders_daily     SUCCEEDED  ${new Date(now.getTime() - 90 * 60000).toISOString()}
    ├── Status: SUCCESS (connector reports no errors)
    ├── Rows loaded: 0  ⚠️  (expected ~12,000 based on 30-day average)
    ├── Sync duration: 4 seconds  ⚠️  (usually 8-12 minutes)
    └── Last row timestamp in RAW.SHOPIFY.ORDERS: 2026-06-27 18:33 UTC (18 hours stale)

  fivetran_salesforce_sync  SUCCEEDED  ${new Date(now.getTime() - 120 * 60000).toISOString()}
    ├── Status: SUCCESS
    └── Rows loaded: 1,847 (normal)

  dim_customers             SUCCEEDED  ${new Date(now.getTime() - 75 * 60000).toISOString()}

FAILURE LOG:
  dbt test not_null_fct_orders_order_id ......... FAIL (8,291)
  dbt test not_null_fct_orders_customer_id ...... FAIL (8,291)
  dbt test unique_fct_orders_order_id ........... FAIL (8,291)

  All 8,291 failing rows have NULL values for order_id, customer_id, created_at.
  These correspond to the date partition for 2026-06-28 (today).
  No data was loaded into RAW.SHOPIFY.ORDERS for today.

NOTE: fivetran_orders_daily shows SUCCESS in Fivetran dashboard but connector
executed in 4 seconds (normal: 8-12 minutes) with 0 rows loaded. Shopify API
returned HTTP 200 with empty results array — no error surfaced in Fivetran logs.
This is a known Shopify API behavior during maintenance windows.

Pipeline: dbt_orders_mart (Dagster run: ${runId})
Orchestrator context source: simulated (wire up Dagster MCP for real data)`;

  return {
    runId,
    orchestrator: 'dagster',
    failedAsset: 'dbt_orders_mart',
    startedAt,
    failedAt,
    enrichedPrompt,
    source: 'simulated',
  };
}

// -------------------------------------------------------------------
// Scenario 2: Multi-tool schema drift
// Salesforce → Fivetran → Snowflake → dbt chain. Schema changed at the top.
// Requires understanding all 3 tools to find root cause.
// -------------------------------------------------------------------
function buildSchemaDriftContext(runId: string): RunContext {
  const now = new Date();
  const failedAt = new Date(now.getTime() - 30 * 60000).toISOString();
  const startedAt = new Date(now.getTime() - 45 * 60000).toISOString();

  const enrichedPrompt = `Triage pipeline failure for run: ${runId}

ORCHESTRATOR CONTEXT (Dagster):
- Orchestrator: Dagster
- Failed asset: dbt_customers_transform
- Run started: ${startedAt}
- Run failed at: ${failedAt}

ASSET DEPENDENCY GRAPH:
  dbt_customers_transform
    └── stg_customers       (source: Salesforce via Fivetran)
    └── stg_accounts        (source: Salesforce via Fivetran)

UPSTREAM RUN RESULTS (last 6 hours):
  fivetran_salesforce_sync  SUCCEEDED  ${new Date(now.getTime() - 4 * 3600000).toISOString()}
    ├── Status: SUCCESS
    ├── Rows loaded: 3,201 (normal)
    ├── Schema changes detected: YES ⚠️
    └── Schema change detail: Column 'customer_segment' renamed to 'customer_tier'
                              on object: Salesforce.Opportunity

  dbt_customers_transform   LAST SUCCESS: 5 hours ago

SNOWFLAKE SCHEMA DIFF (RAW.SALESFORCE.OPPORTUNITY):
  - BEFORE: customer_segment VARCHAR(255)
  - AFTER:  customer_tier VARCHAR(255)
  (Salesforce admin renamed field — data engineering team not notified)

FAILURE LOG:
  ERROR: Database Error in model fct_customer_orders
    column "customer_segment" of relation "dim_customers" does not exist
    LINE 47: SELECT c.customer_segment, SUM(o.order_amount)

RECENT GIT ACTIVITY on dbt repo:
  No commits in last 24 hours to models touching customers.
  (Schema change originated in Salesforce, not in dbt code.)

Pipeline: dbt_customers_transform (Dagster run: ${runId})
Orchestrator context source: simulated (wire up Dagster MCP for real data)`;

  return {
    runId,
    orchestrator: 'dagster',
    failedAsset: 'dbt_customers_transform',
    startedAt,
    failedAt,
    enrichedPrompt,
    source: 'simulated',
  };
}

// -------------------------------------------------------------------
// Scenario 3: Airflow-orchestrated dbt timeout
// dbt runs in Airflow, not Dagster. Warehouse contention from concurrent job.
// Shows multi-orchestrator context.
// -------------------------------------------------------------------
function buildAirflowDbtContext(runId: string): RunContext {
  const now = new Date();
  const failedAt = new Date(now.getTime() - 20 * 60000).toISOString();
  const startedAt = new Date(now.getTime() - 120 * 60000).toISOString();

  const enrichedPrompt = `Triage pipeline failure for run: ${runId}

ORCHESTRATOR CONTEXT (Apache Airflow):
- Orchestrator: Airflow 2.8 (hosted on AWS MWAA)
- DAG: data_platform_daily
- Failed task: run_dbt_revenue_models
- Run started: ${startedAt}
- Run failed at: ${failedAt}
- Airflow task duration: 94 minutes (normal: 8-12 minutes)

DAG TASK DEPENDENCIES:
  data_platform_daily
    ├── extract_salesforce_data     SUCCEEDED (02:15 UTC)
    ├── extract_shopify_data        SUCCEEDED (02:20 UTC)
    ├── run_fivetran_syncs          SUCCEEDED (02:45 UTC)
    └── run_dbt_revenue_models      FAILED    (04:30 UTC)  ← this task

CONCURRENT SNOWFLAKE WORKLOAD (from Snowflake query history):
  Time window 02:00-04:00 UTC (overlapping with failed dbt run):
  - ml_feature_pipeline (separate Dagster job):
      Warehouse: COMPUTE_WH_L (same warehouse as dbt!)
      Query: INSERT INTO ML_FEATURES.CUSTOMER_EMBEDDINGS ...
      Duration: 3h 12min, scanning 2.1B rows
      Status: RUNNING (was running when dbt started)
  - dbt uses COMPUTE_WH_L with auto-suspend=2min

FAILURE LOG (from Airflow task logs):
  [2026-06-28 04:28:14] INFO - Running dbt model revenue_mart
  [2026-06-28 04:30:02] ERROR - Query timeout after 300 seconds
  [2026-06-28 04:30:02] ERROR - Query ID: 01ab8f4c-0001-1234-0000-000000000001
  [2026-06-28 04:30:02] ERROR - Snowflake error: 604 (query execution time exceeded)
  
  dbt model revenue_mart (run time: 94 minutes, query timeout: 300s)
  Warehouse COMPUTE_WH_L was under heavy load — auto-suspend disabled by concurrent job.

NOTE: This failure is caused by resource contention, NOT a code issue. The ML
feature pipeline and dbt are sharing a Snowflake warehouse. The fix is to separate
workloads onto different warehouses, not to retry dbt.

Pipeline: revenue_mart (Airflow DAG: ${runId})
Orchestrator context source: simulated (wire up Airflow REST API for real data)`;

  return {
    runId,
    orchestrator: 'airflow',
    failedAsset: 'revenue_mart',
    startedAt,
    failedAt,
    enrichedPrompt,
    source: 'simulated',
  };
}
