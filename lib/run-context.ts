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
  {
    id: 'dag-run-snowflake-lineage',
    label: 'Snowflake table freshness failure — trace upstream across 4 tools',
    description: 'RAW.SHOPIFY.ORDERS stale in Snowflake. Need to check: Fivetran sync → dbt sources → Dagster asset → upstream Shopify API. Classic cross-vendor lineage problem.',
  },
  {
    id: 'a227a58f-192e-4491-a963-04d713b07d89',
    label: 'hooli data-eng-prod: run_etl_pipeline FAILURE (enriched_data.process_chunk[9])',
    description: 'Real Dagster run from hooli/data-eng-prod. batch_enrichment code location. Retried and still failed. Git commit: 2cc6f2c.',
  },
  {
    id: 'gh-run-dbt-failure',
    label: 'GitHub Actions: dbt_transform.yml failed on step "dbt run --select customers+"',
    description: 'dbt workflow triggered by a merge to main. customer_tier column ref broken 4 hours after the PR merged. Classic "code change caused it" scenario.',
  },
  {
    id: 'sfn-etl-revenue-failure',
    label: 'AWS Step Functions: revenue-etl-pipeline failed at LoadToSnowflake state',
    description: 'Step Functions ETL: Extract (S3) → Transform (Glue) → Load (Snowflake). Failed at Load step with Snowflake permission error. Quarterly rotation pattern.',
  },
];

import { getRunStatus, getRunLogs, getUpstreamContext } from './integrations/dagster';
import { getWorkflowRun } from './integrations/github-actions';

export async function resolveRunId(runId: string): Promise<RunContext | null> {
  const normalized = runId.trim().toLowerCase();

  // Named simulated scenarios
  if (normalized.includes('silent-upstream')) return buildSilentUpstreamContext(runId);
  if (normalized.includes('schema-drift')) return buildSchemaDriftContext(runId);
  if (normalized.includes('airflow-dbt')) return buildAirflowDbtContext(runId);
  if (normalized.includes('snowflake-lineage')) return buildSnowflakeLineageContext(runId);
  if (normalized.includes('gh-run-dbt-failure')) return buildGitHubActionsDbtContext(runId);
  if (normalized.includes('sfn-etl')) return buildStepFunctionsEtlContext(runId);

  // Real Dagster UUID — try live API first
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId.trim());
  if (isUUID) return fetchRealDagsterRun(runId.trim());

  // GitHub Actions run ID: numeric, 9-12 digits
  const isGitHubRunId = /^\d{9,12}$/.test(runId.trim());
  if (isGitHubRunId) return fetchRealGitHubActionsRun(runId.trim());

  // Step Functions ARN
  const isSfnArn = runId.trim().startsWith('arn:aws:states:');
  if (isSfnArn) return buildStepFunctionsEtlContext(runId.trim());

  return null;
}

async function fetchRealDagsterRun(runId: string): Promise<RunContext | null> {
  const run = await getRunStatus(runId);
  const logs = await getRunLogs(runId, 30);

  // Walk upstream: check prior runs + recently failed assets
  const upstream = run.jobName
    ? await getUpstreamContext(run.jobName, runId)
    : null;

  if (run.source === 'unavailable') {
    return {
      runId, orchestrator: 'dagster', failedAsset: 'unknown',
      startedAt: new Date().toISOString(), failedAt: new Date().toISOString(),
      enrichedPrompt: `Triage pipeline failure for Dagster run: ${runId}

STATUS: Dagster credentials not configured — cannot fetch live run context.

To unlock live context for this run:
  1. Go to /settings and fill in:
     - DAGSTER_HOST: https://your-org.dagster.cloud
     - DAGSTER_TOKEN: your user token (Admin → User Tokens)
     - DAGSTER_ORG: your organization slug
  2. Re-submit this run ID

Run ID: ${runId}
Please paste the error log manually, or configure Dagster credentials in /settings.`,
      source: 'simulated',
    };
  }

  const errorEvents = logs.events.filter(e =>
    e.eventType.includes('FAILURE') || e.eventType.includes('ERROR') || e.level === 'ERROR'
  );
  const commitInfo = run.commitHash
    ? `\nGit commit: ${run.commitHash}${run.repoUrl ? `\nRepo: ${run.repoUrl}` : ''}`
    : '';

  // Upstream context section
  let upstreamSection = '';
  if (upstream && upstream.source === 'live') {
    const recurringNote = upstream.isRecurring
      ? `⚠️  This job has failed ${upstream.priorFailures} times recently — likely a recurring issue`
      : `First or occasional failure (${upstream.priorFailures} prior failures in recent runs)`;

    const recentRunsStr = upstream.recentRuns.map(r =>
      `  ${r.runId.slice(0, 8)}... ${r.status} ${r.startTime ? `at ${r.startTime}` : ''}`
    ).join('\n') || '  No recent runs found';

    const failedAssetsStr = upstream.failedAssets.length > 0
      ? upstream.failedAssets.map(a =>
          `  [${a.key.join('.')}] last failed: ${a.lastFailedAt}`
        ).join('\n')
      : '  No other assets failed recently';

    upstreamSection = `
UPSTREAM CONTEXT (asset graph + prior runs):
${recurringNote}

Recent runs of ${run.jobName ?? 'this job'}:
${recentRunsStr}

Other assets that failed in the last 6h (potential upstream causes):
${failedAssetsStr}

NOTE: Full upstream dependency traversal (walking asset deps recursively) requires
multiple get_asset calls per dep. This shows top-level health signals only.
For complete lineage: open the Dagster asset graph UI or use the Dagster MCP
get_asset tool with each dependency key.`;
  }

  const enrichedPrompt = `Triage pipeline failure for Dagster run: ${runId}

DAGSTER RUN CONTEXT (live from ${run.source === 'live' ? 'data-eng-prod' : 'dagster'}):
- Job: ${run.jobName ?? 'unknown'}
- Status: ${run.status ?? 'FAILURE'}
- Failed step: ${run.failureStep ?? run.assetKey ?? 'unknown'}
- Failure reason: ${run.failureDescription ?? 'STEP_FAILURE'}
- Started: ${run.startTime ?? 'unknown'}
- Ended: ${run.endTime ?? 'unknown'}${commitInfo}
${upstreamSection}
ERROR LOG EVENTS:
${errorEvents.map(e => `  [${e.level}] ${e.eventType}: ${e.message.slice(0, 200)}`).join('\n') || '  No explicit error events found — check stepKey failures below'}

ALL LOG EVENTS (${logs.events.length} total):
${logs.events.map(e => `  [${e.level}] ${e.eventType}${e.stepKey ? ` (${e.stepKey})` : ''}: ${e.message.slice(0, 120)}`).join('\n')}

SOURCE: Live data from Dagster MCP (${run.source})`;

  return {
    runId, orchestrator: 'dagster', failedAsset: run.jobName ?? 'unknown',
    startedAt: run.startTime ?? new Date().toISOString(),
    failedAt: run.endTime ?? new Date().toISOString(),
    enrichedPrompt, source: 'dagster_api',
  };
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
// Scenario 4: Snowflake table freshness failure — full cross-vendor lineage
// The alert fires on Snowflake but the root cause is 4 hops upstream.
// Demonstrates why you need cross-tool context, not just the error.
// -------------------------------------------------------------------
function buildSnowflakeLineageContext(runId: string): RunContext {
  const now = new Date();
  const failedAt = new Date(now.getTime() - 35 * 60000).toISOString();
  const startedAt = new Date(now.getTime() - 50 * 60000).toISOString();

  const enrichedPrompt = `Triage pipeline failure for run: ${runId}

ALERT SOURCE: Snowflake data freshness monitor
- Monitor: RAW.SHOPIFY.ORDERS freshness check
- Condition: MAX(created_at) < now() - interval '3 hours'
- Alert fired at: ${failedAt}
- Last fresh data: ${new Date(now.getTime() - 6 * 3600000).toISOString()}

CROSS-VENDOR LINEAGE (from dbt sources.yml + Dagster asset graph):

  Shopify API
    └── Fivetran connector: orders_shopify
        └── RAW.SHOPIFY.ORDERS  ← this is where the alert fired
            └── stg_orders (dbt staging model)
                └── fct_orders (dbt mart)  ← 14 downstream dbt models affected
                    └── dbt_orders_mart (Dagster asset)
                        └── revenue_report, inventory_dashboard (downstream)

HOW THIS LINEAGE WAS BUILT:
  - dbt/models/staging/shopify/sources.yml → maps Fivetran connector to RAW table
  - dbt ref() chains → stg_orders → fct_orders lineage
  - Dagster asset graph → dbt_orders_mart depends on fct_orders
  - 14 downstream assets will fail if RAW.SHOPIFY.ORDERS stays stale

UPSTREAM STATUS CHECK (last 6 hours):
  fivetran_orders_daily: LAST SUCCESS at ${new Date(now.getTime() - 6.5 * 3600000).toISOString()}
    ├── Status: SUCCEEDED
    ├── Rows loaded: 0  ⚠️  (expected ~8,000 rows)
    ├── Duration: 3 seconds (normal: 7-9 minutes)  ⚠️
    └── Note: Shopify returns HTTP 200 with empty array during maintenance windows
            No error is surfaced by Fivetran — this is a SILENT SUCCESS

  Shopify API status: Check https://status.shopify.com
  (Shopify had a 45-min partial outage for Webhooks+API at 01:30-02:15 UTC today)

SNOWFLAKE CONTEXT:
  Table: RAW.SHOPIFY.ORDERS
  Current row count: 847,293 (no new rows since 6 hours ago)
  Expected rows by now: ~855,000 (based on 30-day average)
  No failed Snowflake queries — data simply stopped arriving

WHAT MAKES THIS HARD WITHOUT CROSS-TOOL CONTEXT:
  The alert fires on Snowflake (freshness monitor).
  The Snowflake table is fine — it just has no new data.
  The dbt tests will start failing in 20 minutes (null checks on today's partition).
  The real issue is in Fivetran, which "succeeded" with 0 rows.
  And the root cause is Shopify API behavior during their maintenance window.
  Without the lineage map (sources.yml + Dagster graph), this looks like a Snowflake problem.

Pipeline: dbt_orders_mart (alert origin: ${runId})
Orchestrator context source: simulated (wire up Dagster MCP + GitHub for real lineage)`;

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

SNOWFLAKE WAREHOUSE CONTENTION:
  Snowflake query history for COMPUTE_WH_L during 02:00-04:00 UTC:
  ┌─────────────────────────────────────────────────────────────────────┐
  │  customer_ltv_batch_job (nightly ETL, separate team):               │
  │    Warehouse: COMPUTE_WH_L  ← SAME WAREHOUSE as dbt revenue models! │
  │    Query: INSERT INTO ANALYTICS.LTV.CUSTOMER_SCORES ...              │
  │    Duration: 3h 12min, scanning 2.1 billion rows                     │
  │    Status: RUNNING (was already running when dbt started at 03:00)   │
  └─────────────────────────────────────────────────────────────────────┘
  
  Both jobs share COMPUTE_WH_L. Snowflake credits were fully consumed
  by the LTV batch — dbt queries queued and eventually timed out.
  No Snowflake platform error — this is a RESOURCE CONTENTION issue.

FAILURE LOG (from Airflow task logs):
  [2026-06-28 04:28:14] INFO - Running dbt model revenue_mart
  [2026-06-28 04:30:02] ERROR - Query timeout after 300 seconds
  [2026-06-28 04:30:02] ERROR - Query ID: 01ab8f4c-0001-1234-0000-000000000001
  [2026-06-28 04:30:02] ERROR - Snowflake error: 604 (query execution time exceeded)
  
  dbt model revenue_mart timed out after 94 minutes.
  Snowflake warehouse COMPUTE_WH_L was saturated by concurrent batch job.

NOTE: This is NOT a code regression and NOT a Snowflake platform issue.
The fix is to move one of the two jobs to a dedicated warehouse.
Do NOT just retry without addressing the warehouse allocation.

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

// -------------------------------------------------------------------
// Real GitHub Actions run fetch
// -------------------------------------------------------------------
async function fetchRealGitHubActionsRun(runId: string): Promise<RunContext | null> {
  const run = await getWorkflowRun(runId);

  if (run.source === 'unavailable') {
    return {
      runId, orchestrator: 'unknown', failedAsset: 'unknown',
      startedAt: new Date().toISOString(), failedAt: new Date().toISOString(),
      enrichedPrompt: `Triage GitHub Actions workflow run: ${runId}

STATUS: GitHub credentials not configured — cannot fetch live run context.

To enable: go to /settings → GitHub → set GITHUB_TOKEN, GITHUB_REPO_OWNER, GITHUB_REPO_NAME.

Run ID: ${runId}
Please paste the workflow logs manually to continue triage.`,
      source: 'simulated',
    };
  }

  const failedJobsStr = run.failedJobs.map(j => {
    const stepsStr = j.failedSteps.map(s => `      ✗ ${s.name}`).join('\n');
    return `  Job: ${j.name}\n${stepsStr || '      (no individual step failures)'}`;
  }).join('\n') || '  No failed jobs found (may be a setup failure)';

  const enrichedPrompt = `Triage GitHub Actions workflow failure for run: ${runId}

WORKFLOW CONTEXT (live from GitHub API):
- Workflow: ${run.workflowName ?? 'unknown'}
- Repository: ${run.repoFullName ?? 'unknown'}
- Status: ${run.conclusion ?? run.status ?? 'failure'}
- Triggered by: ${run.triggeredBy ?? 'unknown'}
- Head commit: ${run.headSha ?? 'unknown'} — "${run.headCommitMessage ?? 'unknown'}"
- Started: ${run.startedAt ?? 'unknown'}
- Completed: ${run.completedAt ?? 'unknown'}

FAILED JOBS AND STEPS:
${failedJobsStr}

NOTE: GitHub Actions does not provide data lineage. To understand upstream context:
  - Check which dbt models / scripts this workflow runs
  - Check if upstream Fivetran syncs ran before this workflow triggered
  - Look at the commit that triggered this run for recent code changes

SOURCE: Live data from GitHub API (run ID: ${runId})`;

  return {
    runId, orchestrator: 'unknown', failedAsset: run.workflowName ?? 'unknown',
    startedAt: run.startedAt ?? new Date().toISOString(),
    failedAt: run.completedAt ?? new Date().toISOString(),
    enrichedPrompt, source: 'dagster_api',
  };
}

// -------------------------------------------------------------------
// Scenario 5: GitHub Actions dbt pipeline failure
// PR merged → dbt workflow triggered → customer_tier ref broken
// -------------------------------------------------------------------
function buildGitHubActionsDbtContext(runId: string): RunContext {
  const now = new Date();
  const failedAt = new Date(now.getTime() - 25 * 60000).toISOString();
  const startedAt = new Date(now.getTime() - 35 * 60000).toISOString();

  const enrichedPrompt = `Triage GitHub Actions workflow failure for run: ${runId}

WORKFLOW CONTEXT (GitHub Actions):
- Workflow: dbt_transform.yml
- Repository: acme-corp/data-platform
- Trigger: push to main (PR #247 merged 4 hours ago)
- Triggered by: alex-p
- Head commit: a4f7c2e — "rename customer_segment → customer_tier across customer models"
- Started: ${startedAt}
- Failed at: ${failedAt}

FAILED JOBS AND STEPS:
  Job: dbt-run
    ✓ Setup Python environment (4s)
    ✓ Install dbt dependencies (12s)
    ✓ dbt deps (8s)
    ✓ dbt compile (23s)
    ✓ dbt run --select staging.+ (45s)
    ✗ dbt run --select marts.customers+ (FAILED after 34s)
    ✗ dbt test --select marts.customers+ (skipped due to prior failure)

FAILURE OUTPUT:
  Database Error in model fct_customer_orders (models/marts/customers/fct_customer_orders.sql)
    column "customer_tier" of relation "dim_customers" does not exist
    LINE 47: SELECT c.customer_tier, SUM(o.order_amount) as revenue
    compiled SQL: target/compiled/dbt_project/models/marts/fct_customer_orders.sql

LINEAGE CONTEXT (from dbt manifest + sources.yml):
  fct_customer_orders
    ← dim_customers (dbt model)
       ← stg_customers (dbt staging)
          ← source('salesforce', 'accounts') → Fivetran Salesforce connector

NOTE: The failing model references "customer_tier" which was introduced in PR #247
(merged 4 hours ago, commit a4f7c2e). The PR renamed customer_segment → customer_tier
in dim_customers but did NOT update fct_customer_orders.

RECENT FIVETRAN SYNC STATUS:
  fivetran_salesforce_sync: SUCCEEDED 2h ago, 3,201 rows loaded (normal)
  (Fivetran is NOT the issue — this is a code change problem)

Pipeline: dbt_customers_transform (orchestrator: GitHub Actions)
Run ID: ${runId}`;

  return {
    runId, orchestrator: 'unknown', failedAsset: 'dbt_customers_transform',
    startedAt, failedAt, enrichedPrompt, source: 'simulated',
  };
}

// -------------------------------------------------------------------
// Scenario 6: Step Functions ETL pipeline failure
// S3 → Glue → Snowflake chain. Failed at Load step (permission denied).
// Demonstrates multi-step pipeline context without a DAG orchestrator.
// -------------------------------------------------------------------
function buildStepFunctionsEtlContext(runId: string): RunContext {
  const now = new Date();
  const failedAt = new Date(now.getTime() - 40 * 60000).toISOString();
  const startedAt = new Date(now.getTime() - 75 * 60000).toISOString();

  const enrichedPrompt = `Triage AWS Step Functions execution failure: ${runId}

STEP FUNCTIONS CONTEXT:
- State Machine: revenue-etl-pipeline
- Execution: arn:aws:states:us-east-1:123456789012:execution:revenue-etl-pipeline:${runId}
- Status: FAILED
- Started: ${startedAt}
- Failed at: ${failedAt}

STATE MACHINE DEFINITION (simplified):
  ExtractFromS3 → TransformWithGlue → ValidateRowCounts → LoadToSnowflake → NotifySuccess
                                                              ↑
                                                         FAILED HERE

EXECUTION HISTORY:
  [SUCCEEDED] ExtractFromS3
    - S3 bucket: s3://acme-data-lake/raw/revenue/2026-06-28/
    - Files extracted: 247 Parquet files, 2.3GB total
    - Duration: 8 minutes

  [SUCCEEDED] TransformWithGlue
    - Glue job: revenue-transform-job
    - Output rows: 1,847,293
    - Duration: 22 minutes

  [SUCCEEDED] ValidateRowCounts
    - Expected: >1M rows ✓
    - Null rate on revenue_amount: 0.02% ✓ (below 1% threshold)

  [FAILED] LoadToSnowflake
    - Duration: 0 seconds (immediate failure)
    - Error type: SnowflakeConnectionError
    - Cause: "Insufficient privileges to operate on schema 'PROD.REVENUE'. 
      User: ETL_SVC_ACCT, Role: ETL_ROLE, Error: 003001 (42501)"

CLOUDWATCH LOGS (LoadToSnowflake step):
  [ERROR] snowflake.connector.errors.ProgrammingError: 003001 (42501):
  Insufficient privileges to operate on schema 'PROD.REVENUE'
  User: ETL_SVC_ACCT
  Role: ETL_ROLE

CROSS-TOOL CONTEXT:
  - EventBridge detected FAILED state at ${failedAt}
  - Alert sent to #data-ops Slack channel
  - This is the 2nd occurrence this quarter (last: March 31 → quarterly credential rotation)
  - PROD.REVENUE.FCT_REVENUE has not been updated for 6 hours (freshness SLA: 4h)
  - 3 downstream BI dashboards are now stale

PIECING TOGETHER LINEAGE (no OpenLineage, using manual mapping):
  Snowflake PROD.REVENUE.FCT_REVENUE
    ← LoadToSnowflake (Step Functions, this state machine)
       ← TransformWithGlue (Glue job: revenue-transform-job)
          ← S3 raw zone (upstream ETL deposits here)
             ← Fivetran/custom connectors (multiple sources)

Pipeline: revenue-etl-pipeline (orchestrator: AWS Step Functions)
Execution: ${runId}`;

  return {
    runId, orchestrator: 'unknown', failedAsset: 'revenue-etl-pipeline',
    startedAt, failedAt, enrichedPrompt, source: 'simulated',
  };
}
