import { neon } from '@neondatabase/serverless';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const sql = neon(process.env.DATABASE_URL!);

async function seed() {
  console.log('🌱 Seeding Dispatch database...\n');

  // ----------------------------------------------------------------
  // RUNBOOKS (10 entries)
  // ----------------------------------------------------------------

  const runbooks = [
    {
      title: 'Fivetran Orders Sync — Upstream Data Missing',
      failure_type: 'upstream_data_missing',
      pipeline_tags: ['fivetran', 'orders', 'shopify'],
      content: `Check Fivetran sync status in the dashboard first. Known issue: Shopify API
rate limits during flash sales cause delayed syncs. This pipeline has a 45-min
grace period built in — check if the sync is still running before re-triggering.
If still failing after 1 hour, check Fivetran's status page at status.fivetran.com for
incidents. Do not trigger a manual backfill until you confirm the sync is not in progress —
duplicate data will break downstream dbt tests.

Common causes: (1) Shopify rate limit hit during high-traffic event, (2) Fivetran
connector credential rotation, (3) Shopify schema change to webhook payload.`,
      remediation_steps: JSON.stringify([
        'Check Fivetran dashboard → Orders connector → Last sync status',
        'If sync is in progress (not failed), wait for it to complete',
        'If sync failed, check error message in Fivetran dashboard',
        'If Shopify rate limit: wait 45 minutes and check Shopify API status',
        'If credential error: file ticket with IT to rotate Fivetran Shopify credentials',
        'Escalate to #data-ops if unresolved after 1 hour',
      ]),
      author: 'data-platform-team',
    },
    {
      title: 'dbt Customers Transform — Schema Mismatch',
      failure_type: 'schema_mismatch',
      pipeline_tags: ['dbt', 'customers', 'salesforce'],
      content: `Upstream schema changes from Salesforce are the #1 cause of this failure.
Run \`dbt ls --select customers+\` to identify all downstream models before rerunning.
Check with the Salesforce admin team if a new field was added or renamed on the Opportunity
or Account object — they don't always notify data eng.

Column renames are particularly insidious because they break all refs silently.
Recent known issue: customer_segment was renamed to customer_tier in PR #247.
Always check the dbt_customers model's ref() calls against the actual Salesforce schema.

If you see KeyError or column not found in logs, check git for PRs merged in the last 24h
that touched models/staging/salesforce/.`,
      remediation_steps: JSON.stringify([
        'Run: dbt ls --select customers+ to map downstream impact',
        'Check Salesforce schema for recent field renames/additions',
        'Search git log for PRs touching models/staging/salesforce/ in last 24h',
        'If column rename: update all ref() calls in downstream models',
        'Run: dbt compile to verify fix before triggering full run',
        'Notify Salesforce admin team to add data eng to change notification list',
      ]),
      author: 'analytics-eng',
    },
    {
      title: 'dbt Compilation Error — Missing ref() or Circular Dependency',
      failure_type: 'dbt_compilation_error',
      pipeline_tags: ['dbt'],
      content: `Almost always a missing ref(), renamed model, or circular dependency.
Check the last PR merged to the dbt repo in the last 24h — this is the smoking gun 90%
of the time. If it was a model rename, the old ref() in dependent models will break.

Run \`dbt compile\` locally to reproduce before triggering a full run on Dagster.
Look for: "Compilation Error in model", "depends on a node named X which was not found".

Circular dependencies are rarer but happen when two models ref() each other. Use
\`dbt ls --select +model_name\` to trace the DAG and find the cycle.`,
      remediation_steps: JSON.stringify([
        'Run: dbt compile locally to see the exact error',
        'Check git log --oneline -10 for recent model renames',
        'Search for the missing model name in ref() calls across the project',
        'If circular dep: run dbt ls --select +model_name to trace the DAG',
        'Fix the ref() or rename, then re-run dbt compile to verify',
        'If stuck: check #dbt-help channel — this is a common pattern',
      ]),
      author: 'analytics-eng',
    },
    {
      title: 'Databricks ML Pipeline — Resource Exhaustion',
      failure_type: 'resource_exhaustion',
      pipeline_tags: ['databricks', 'ml', 'warehouse'],
      content: `Warehouse auto-suspend is set to 2 minutes. If this job runs longer than
90 minutes it will suspend mid-run. DO NOT just retry without addressing this —
you will hit the same failure.

Options: (1) increase warehouse size for this run in Databricks UI, (2) disable
auto-suspend temporarily via the Databricks API, (3) add a keepalive query that
runs every 60 seconds.

Also check: cluster auto-scaling limits (max workers reached), Databricks spot
instance preemption (check cluster event log for PREEMPTED events), disk space
on the cluster volume.`,
      remediation_steps: JSON.stringify([
        'Check Databricks cluster event log for PREEMPTED or SUSPENDED events',
        'If auto-suspend: increase cluster auto-suspend to 10 min for this run',
        'If spot preemption: switch to on-demand instances for critical runs',
        'If disk: clear /tmp on cluster or increase cluster volume size',
        'Do NOT retry with same config — fix the resource issue first',
        'Monitor first 15 min of retry run in Databricks UI',
      ]),
      author: 'ml-platform-team',
    },
    {
      title: 'Snowflake Raw — Permission Denied (Service Account)',
      failure_type: 'permission_denied',
      pipeline_tags: ['snowflake', 'raw', 'permissions'],
      content: `SYSADMIN rotates service account credentials quarterly (check #data-ops for
the schedule). If this is the 1st or 2nd week of a new quarter, that's almost
certainly the cause. File a ticket with IT to rotate the DISPATCH_SVC_ACCT
password and update the Snowflake integration secret in Vercel env vars.

Also check: (1) Snowflake role assignment (DISPATCH_SVC_ACCT must have USAGE on
the RAW database and schema), (2) IP allowlist changes (Snowflake network policy),
(3) MFA requirement added to service account (service accounts should use key-pair auth).

Error pattern: "Insufficient privileges to operate on schema 'RAW.SALESFORCE'"`,
      remediation_steps: JSON.stringify([
        'Check #data-ops Slack channel for quarterly credential rotation announcement',
        'File IT ticket: "Rotate DISPATCH_SVC_ACCT Snowflake password"',
        'Update SNOWFLAKE_PASSWORD env var in Vercel dashboard (all environments)',
        'Verify role: GRANT USAGE ON SCHEMA RAW.SALESFORCE TO ROLE DISPATCH_ROLE',
        'Test connectivity: run SELECT CURRENT_USER() in Snowflake console with service account',
        'Escalate to IT if rotation not completed within 2 hours',
      ]),
      author: 'data-platform-team',
    },
    {
      title: 'dbt Orders — Test Failure (Null Check)',
      failure_type: 'dbt_test_failure',
      pipeline_tags: ['dbt', 'orders', 'data-quality'],
      content: `dbt test failures on orders most commonly indicate upstream data quality issues,
not pipeline code problems. Check: (1) not_null test on order_id — means orders with null
IDs arrived from Fivetran, (2) unique test on order_id — means duplicate orders in source.

Before treating as a code issue: verify the source data in RAW.SHOPIFY.ORDERS.
If nulls or duplicates exist there, the fix is upstream (Fivetran config or Shopify API).

If the source data looks clean, it may be a dbt test config issue (wrong column reference)
or a legitimate bug introduced by a recent model change. Check git history.`,
      remediation_steps: JSON.stringify([
        'Run: SELECT COUNT(*) FROM RAW.SHOPIFY.ORDERS WHERE ORDER_ID IS NULL',
        'If nulls in source: open Fivetran support ticket — this is their issue',
        'If source is clean: check dbt test config in schema.yml for the orders model',
        'Check git for recent changes to models/marts/orders/ in last 48h',
        'Run failing test locally: dbt test --select orders --store-failures',
        'If legitimate data quality issue: add to known_issues runbook and alert #data-quality',
      ]),
      author: 'analytics-eng',
    },
    {
      title: 'External API — Network Timeout (Weather/Pricing)',
      failure_type: 'network_timeout',
      pipeline_tags: ['external-api', 'network'],
      content: `Network timeouts to external APIs (weather, pricing, exchange rates) are
usually transient. Check the API provider's status page first before any intervention.

Most external APIs have a status page: status.openweathermap.org, status.stripe.com, etc.
If the provider is having issues, the correct action is to wait and retry — not to
escalate internally.

If the timeout is consistent across multiple retries over 30+ minutes, check:
(1) Our outbound IP has not been blocked (new IP after Vercel deployment?),
(2) API rate limit hit (check response headers from last successful call),
(3) SSL certificate issues (certificate rotation breaking TLS handshake).`,
      remediation_steps: JSON.stringify([
        'Check external API provider status page immediately',
        'If provider incident: subscribe to updates and wait — do not escalate internally',
        'If no provider incident: check retry logs for consistent vs intermittent failures',
        'Verify outbound IP allowlist with the API provider if failures are consistent',
        'Check rate limit headers from last successful API response in logs',
        'If 30+ min with no resolution: escalate to #data-platform with provider incident link',
      ]),
      author: 'data-platform-team',
    },
    {
      title: 'Upstream Asset Not Ready — Dependency Timing',
      failure_type: 'dependency_not_ready',
      pipeline_tags: ['dagster', 'dependencies', 'scheduling'],
      content: `This pipeline depends on an upstream asset that hasn't materialized yet.
Check the Dagster asset graph to identify which upstream dependency is missing.
This is almost always a scheduling issue, not a code bug.

Common causes: (1) upstream job ran later than expected due to resource contention,
(2) upstream job failed silently (check its status in Dagster), (3) Dagster sensor
trigger timing changed.

Check if the upstream asset has a "freshness policy" defined. If so, Dagster should
alert before this pipeline even runs. If not, adding a freshness policy is the correct
long-term fix.`,
      remediation_steps: JSON.stringify([
        'Open Dagster Asset Graph and identify which upstream asset is missing',
        'Check upstream asset materialization history — did it run? Did it succeed?',
        'If upstream failed: triage that pipeline first',
        'If upstream still running: wait for it and monitor in Dagster UI',
        'If scheduling issue: check if cron/sensor timing needs adjustment',
        'Long-term fix: add freshness policy to upstream asset in Dagster',
      ]),
      author: 'data-platform-team',
    },
    {
      title: 'S3 Data Lake — Permission Denied',
      failure_type: 'permission_denied',
      pipeline_tags: ['s3', 'aws', 'permissions'],
      content: `S3 permission errors are distinct from Snowflake service account issues.
Check: (1) IAM role attached to the ECS task or Lambda has s3:GetObject permission
on the target bucket, (2) bucket policy hasn't been tightened (new VPC endpoint
policy, SCP change), (3) KMS key policy if the bucket uses SSE-KMS.

Recent pattern: new AWS SCPs were applied that block cross-account S3 access.
If the bucket is in a different AWS account, verify the cross-account role assumption
still works.

Error pattern: "Access Denied" or "403 Forbidden" in AWS SDK response.`,
      remediation_steps: JSON.stringify([
        'Check IAM role attached to the job execution: aws iam get-role --role-name <role>',
        'Verify s3:GetObject permission: aws s3 ls s3://bucket/path using the role',
        'Check bucket policy in AWS console for recent changes (CloudTrail)',
        'If KMS: verify IAM role has kms:Decrypt permission on the key',
        'If cross-account: verify trust policy on the target account role',
        'File AWS support ticket if SCP change is suspected — needs infra team',
      ]),
      author: 'data-platform-team',
    },
    {
      title: 'dbt Payments Transform — Schema Mismatch',
      failure_type: 'schema_mismatch',
      pipeline_tags: ['dbt', 'payments', 'stripe'],
      content: `Stripe schema changes are the primary cause of payments pipeline failures.
Stripe occasionally renames or adds fields in their API responses without notice.
Check the Stripe changelog (stripe.com/docs/changelog) for recent changes.

The payments pipeline uses the Stripe→Fivetran connector. Recent Stripe API version
upgrade can change field names in the raw tables. Check RAW.STRIPE schema directly
in Snowflake for unexpected column changes.

Also check: payment_status values — Stripe occasionally adds new status strings
that break enum constraints in our dbt tests.`,
      remediation_steps: JSON.stringify([
        'Check Stripe changelog for API changes in the last 7 days',
        'Query Snowflake: SELECT column_name FROM information_schema.columns WHERE table_name = \'PAYMENTS\'',
        'Compare column list against last known good schema (check git for schema.yml)',
        'If Stripe added/renamed column: update staging model to handle new field',
        'Test with: dbt run --select payments+ in staging environment first',
        'Notify #payments-eng — Stripe changes often affect multiple downstream models',
      ]),
      author: 'analytics-eng',
    },
    {
      title: 'GitHub Actions dbt Pipeline — Code Regression',
      failure_type: 'schema_mismatch',
      pipeline_tags: ['github-actions', 'dbt', 'ci-cd'],
      content: `dbt workflows triggered by GitHub Actions typically fail immediately after a PR merge.
The most common cause: a column was renamed in the merged PR but downstream refs were not updated.
Run "dbt compile" locally to catch these before merging.`,
      remediation_steps: JSON.stringify([
        'Check GitHub Actions run logs: which dbt model failed and what was the error?',
        'Look at the commit that triggered the workflow: git show HEAD --name-only',
        'Run: dbt compile locally against the failing branch',
        'Check for renamed models/columns: grep -r "old_name" models/',
        'Update all downstream ref() calls to use the new name',
        'Re-run the workflow after pushing the fix commit',
      ]),
      author: 'analytics-eng',
    },
    {
      title: 'AWS Step Functions ETL — Permission Denied (Quarterly Rotation)',
      failure_type: 'permission_denied',
      pipeline_tags: ['step-functions', 'aws', 'snowflake', 'etl'],
      content: `The revenue-etl-pipeline uses ETL_SVC_ACCT to load data into PROD.REVENUE in Snowflake.
IT rotates this account quarterly. This pipeline has failed on March 31, June 30, September 30, December 31.
Credentials are stored in AWS Secrets Manager (secret: prod/etl-svc-acct) — no code change needed.`,
      remediation_steps: JSON.stringify([
        'Check #data-ops for credential rotation announcement',
        'File IT ticket: "Rotate ETL_SVC_ACCT in Secrets Manager: prod/etl-svc-acct"',
        'IT updates Secrets Manager — Step Functions reads at runtime, no code change needed',
        'Test: aws secretsmanager get-secret-value --secret-id prod/etl-svc-acct',
        'Re-run Step Functions execution from the failed LoadToSnowflake state (not from start)',
        'Verify PROD.REVENUE.FCT_REVENUE is populated before closing the incident',
      ]),
      author: 'data-platform-team',
    },
  ];

  for (const rb of runbooks) {
    await sql`
      INSERT INTO runbooks (org_id, title, failure_type, pipeline_tags, content, remediation_steps, author)
      VALUES ('default', ${rb.title}, ${rb.failure_type}, ${rb.pipeline_tags}, ${rb.content}, ${rb.remediation_steps}::jsonb, ${rb.author})
      ON CONFLICT DO NOTHING
    `;
  }
  console.log(`✅ Inserted ${runbooks.length} runbooks`);

  // ----------------------------------------------------------------
  // INCIDENTS (20 entries across 6 pipelines)
  // ----------------------------------------------------------------

  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
  const minutesAfter = (base: string, m: number) =>
    new Date(new Date(base).getTime() + m * 60 * 1000).toISOString();

  const incidents = [
    // Pipeline A: fivetran_orders_daily — known flaky, 8 incidents
    {
      pipeline_name: 'fivetran_orders_daily', failure_type: 'upstream_data_missing',
      occurred_at: daysAgo(5), resolved_at: minutesAfter(daysAgo(5), 22),
      resolution_summary: 'Waited for Fivetran backfill to complete. Shopify rate limit during flash sale.',
      root_cause: 'Shopify API rate limit', known_flaky: true, resolved_by: 'on-call-bot',
    },
    {
      pipeline_name: 'fivetran_orders_daily', failure_type: 'upstream_data_missing',
      occurred_at: daysAgo(12), resolved_at: minutesAfter(daysAgo(12), 28),
      resolution_summary: 'Waited for Fivetran backfill to complete.',
      root_cause: 'Shopify API rate limit', known_flaky: true, resolved_by: 'sarah-k',
    },
    {
      pipeline_name: 'fivetran_orders_daily', failure_type: 'upstream_data_missing',
      occurred_at: daysAgo(19), resolved_at: minutesAfter(daysAgo(19), 18),
      resolution_summary: 'Waited for Fivetran backfill. No action needed.',
      root_cause: 'Shopify API rate limit', known_flaky: true, resolved_by: 'on-call-bot',
    },
    {
      pipeline_name: 'fivetran_orders_daily', failure_type: 'upstream_data_missing',
      occurred_at: daysAgo(26), resolved_at: minutesAfter(daysAgo(26), 31),
      resolution_summary: 'Fivetran sync completed on its own. Flash sale traffic spike.',
      root_cause: 'Shopify API rate limit', known_flaky: true, resolved_by: 'marcus-t',
    },
    {
      pipeline_name: 'fivetran_orders_daily', failure_type: 'upstream_data_missing',
      occurred_at: daysAgo(35), resolved_at: minutesAfter(daysAgo(35), 25),
      resolution_summary: 'Waited for Fivetran backfill to complete.',
      root_cause: 'Shopify API rate limit', known_flaky: true, resolved_by: 'on-call-bot',
    },
    {
      pipeline_name: 'fivetran_orders_daily', failure_type: 'upstream_data_missing',
      occurred_at: daysAgo(48), resolved_at: minutesAfter(daysAgo(48), 20),
      resolution_summary: 'Backfill completed. Known flaky behavior on high-traffic days.',
      root_cause: 'Shopify API rate limit', known_flaky: true, resolved_by: 'sarah-k',
    },
    {
      pipeline_name: 'fivetran_orders_daily', failure_type: 'upstream_data_missing',
      occurred_at: daysAgo(62), resolved_at: minutesAfter(daysAgo(62), 24),
      resolution_summary: 'Waited for Fivetran backfill. No intervention needed.',
      root_cause: 'Shopify API rate limit', known_flaky: true, resolved_by: 'on-call-bot',
    },
    {
      pipeline_name: 'fivetran_orders_daily', failure_type: 'upstream_data_missing',
      occurred_at: daysAgo(78), resolved_at: minutesAfter(daysAgo(78), 19),
      resolution_summary: 'Fivetran completed backfill automatically.',
      root_cause: 'Shopify API rate limit', known_flaky: true, resolved_by: 'marcus-t',
    },

    // Pipeline B: dbt_customers_transform — one bad PR, 6 weeks ago
    {
      pipeline_name: 'dbt_customers_transform', failure_type: 'schema_mismatch',
      occurred_at: daysAgo(42), resolved_at: minutesAfter(daysAgo(42), 12),
      resolution_summary: 'Reverted PR that renamed customer_segment to customer_tier without updating downstream refs.',
      root_cause: 'Column rename in PR without updating downstream dbt refs',
      known_flaky: false, resolved_by: 'alex-p',
    },

    // Pipeline C: snowflake_revenue_mart — never failed
    // (no incidents — this is the "escalate immediately" story)

    // Pipeline D: databricks_ml_pipeline — resource exhaustion twice
    {
      pipeline_name: 'databricks_ml_pipeline', failure_type: 'resource_exhaustion',
      occurred_at: daysAgo(14), resolved_at: minutesAfter(daysAgo(14), 45),
      resolution_summary: 'Increased warehouse size to X-Large for training run. Added keepalive query.',
      root_cause: 'Warehouse auto-suspend during long training run',
      known_flaky: false, resolved_by: 'ml-team-oncall',
    },
    {
      pipeline_name: 'databricks_ml_pipeline', failure_type: 'resource_exhaustion',
      occurred_at: daysAgo(45), resolved_at: minutesAfter(daysAgo(45), 38),
      resolution_summary: 'Disabled auto-suspend for ML cluster during training window.',
      root_cause: 'Warehouse auto-suspend during long training run',
      known_flaky: false, resolved_by: 'marcus-t',
    },

    // Pipeline E: snowflake_raw_ingestion — permission issue quarterly
    {
      pipeline_name: 'snowflake_raw_ingestion', failure_type: 'permission_denied',
      occurred_at: daysAgo(90), resolved_at: minutesAfter(daysAgo(90), 120),
      resolution_summary: 'IT rotated DISPATCH_SVC_ACCT credentials as part of quarterly rotation. Updated env var.',
      root_cause: 'Quarterly service account credential rotation',
      known_flaky: false, resolved_by: 'it-team',
    },
    {
      pipeline_name: 'snowflake_raw_ingestion', failure_type: 'permission_denied',
      occurred_at: daysAgo(180), resolved_at: minutesAfter(daysAgo(180), 95),
      resolution_summary: 'Quarterly credential rotation. Updated SNOWFLAKE_PASSWORD in all Vercel environments.',
      root_cause: 'Quarterly service account credential rotation',
      known_flaky: false, resolved_by: 'sarah-k',
    },

    // Pipeline F: payments_dbt_pipeline — occasional flakiness
    {
      pipeline_name: 'payments_dbt_pipeline', failure_type: 'dbt_test_failure',
      occurred_at: daysAgo(7), resolved_at: minutesAfter(daysAgo(7), 30),
      resolution_summary: 'Stripe API returned duplicate payment IDs during batch. Added dedup logic.',
      root_cause: 'Stripe API duplicate payment_id in batch response',
      known_flaky: false, resolved_by: 'alex-p',
    },
    {
      pipeline_name: 'payments_dbt_pipeline', failure_type: 'network_timeout',
      occurred_at: daysAgo(33), resolved_at: minutesAfter(daysAgo(33), 15),
      resolution_summary: 'Stripe API incident (status.stripe.com). Resolved when Stripe recovered.',
      root_cause: 'Stripe API incident',
      known_flaky: false, resolved_by: 'on-call-bot',
    },
    {
      pipeline_name: 'payments_dbt_pipeline', failure_type: 'schema_mismatch',
      occurred_at: daysAgo(55), resolved_at: minutesAfter(daysAgo(55), 45),
      resolution_summary: 'Stripe API version bump added new payment_method_type values. Updated enum test.',
      root_cause: 'Stripe API enum expansion',
      known_flaky: false, resolved_by: 'alex-p',
    },

    // Extra incidents for realism
    {
      pipeline_name: 'dbt_marketing_attribution', failure_type: 'dbt_compilation_error',
      occurred_at: daysAgo(21), resolved_at: minutesAfter(daysAgo(21), 8),
      resolution_summary: 'Missing ref() after model rename in PR #198. Fixed ref and re-ran.',
      root_cause: 'Model renamed in PR without updating ref() in downstream models',
      known_flaky: false, resolved_by: 'sarah-k',
    },
    {
      pipeline_name: 'fivetran_salesforce_sync', failure_type: 'upstream_data_missing',
      occurred_at: daysAgo(3), resolved_at: minutesAfter(daysAgo(3), 60),
      resolution_summary: 'Salesforce maintenance window ran longer than expected. Pipeline resumed automatically.',
      root_cause: 'Salesforce scheduled maintenance window',
      known_flaky: false, resolved_by: 'on-call-bot',
    },

    // GitHub Actions dbt pipeline incidents
    {
      pipeline_name: 'github-actions-dbt-transform', failure_type: 'schema_mismatch',
      occurred_at: new Date(now.getTime() - 4.5 * 3600000).toISOString(),
      resolved_at: minutesAfter(new Date(now.getTime() - 4.5 * 3600000).toISOString(), 18),
      resolution_summary: 'dbt workflow failed after PR #247 renamed customer_segment → customer_tier. Fixed missing ref in fct_customer_orders.',
      root_cause: 'Code regression: column rename in PR without updating all downstream refs',
      known_flaky: false, resolved_by: 'alex-p',
    },
    {
      pipeline_name: 'github-actions-dbt-transform', failure_type: 'dbt_test_failure',
      occurred_at: daysAgo(8), resolved_at: minutesAfter(daysAgo(8), 25),
      resolution_summary: 'not_null test on order_id failed. Traced to Fivetran loading 0 rows that day.',
      root_cause: 'Upstream Fivetran silent failure propagated to dbt tests',
      known_flaky: false, resolved_by: 'marcus-t',
    },

    // AWS Step Functions ETL incidents
    {
      pipeline_name: 'revenue-etl-pipeline', failure_type: 'permission_denied',
      occurred_at: new Date(now.getTime() - 40 * 60000).toISOString(),
      resolved_at: null,
      resolution_summary: null,
      root_cause: 'Quarterly credential rotation — ETL_SVC_ACCT lost access to PROD.REVENUE',
      known_flaky: false, resolved_by: null,
    },
    {
      pipeline_name: 'revenue-etl-pipeline', failure_type: 'permission_denied',
      occurred_at: daysAgo(91),
      resolved_at: minutesAfter(daysAgo(91), 115),
      resolution_summary: 'IT rotated ETL_SVC_ACCT credentials as part of quarterly rotation. Updated Snowflake connection secret in Step Functions.',
      root_cause: 'Quarterly service account credential rotation',
      known_flaky: false, resolved_by: 'it-team',
    },
    {
      pipeline_name: 'revenue-etl-pipeline', failure_type: 'resource_exhaustion',
      occurred_at: daysAgo(45), resolved_at: minutesAfter(daysAgo(45), 35),
      resolution_summary: 'Glue job ran out of DPUs during end-of-month revenue calculation. Increased DPU count from 10 to 20.',
      root_cause: 'End-of-month data volume spike exceeded Glue job capacity',
      known_flaky: false, resolved_by: 'data-platform-team',
    },

    // Databricks incidents
    {
      pipeline_name: 'databricks-feature-pipeline', failure_type: 'resource_exhaustion',
      occurred_at: daysAgo(6), resolved_at: minutesAfter(daysAgo(6), 42),
      resolution_summary: 'Spot instance preemption during model training run. Switched to on-demand for critical runs.',
      root_cause: 'AWS spot instance preemption during high-demand period',
      known_flaky: false, resolved_by: 'ml-platform-team',
    },
  ];

  for (const inc of incidents) {
    await sql`
      INSERT INTO incidents (org_id, pipeline_name, failure_type, occurred_at, resolved_at,
                             resolution_summary, root_cause, known_flaky, resolved_by)
      VALUES ('default', ${inc.pipeline_name}, ${inc.failure_type}, ${inc.occurred_at},
              ${inc.resolved_at}, ${inc.resolution_summary}, ${inc.root_cause},
              ${inc.known_flaky}, ${inc.resolved_by})
      ON CONFLICT DO NOTHING
    `;
  }
  console.log(`✅ Inserted ${incidents.length} incidents`);

  // ----------------------------------------------------------------
  // GIT CONTEXT (~3 entries per key pipeline)
  // ----------------------------------------------------------------

  const gitRows = [
    // dbt_customers_transform: smoking gun — PR merged 4h ago
    {
      pipeline_name: 'dbt_customers_transform',
      commit_sha: 'a4f7c2e',
      pr_number: 247,
      pr_title: 'rename customer_segment → customer_tier across customer models',
      author: 'alex-p',
      changed_files: ['models/staging/salesforce/stg_customers.sql', 'models/marts/customers/dim_customers.sql', 'models/marts/customers/fct_customer_orders.sql'],
      committed_at: new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString(),
      is_likely_cause: true,
      source: 'simulated',
    },
    {
      pipeline_name: 'dbt_customers_transform',
      commit_sha: 'b9e3d1a',
      pr_number: 246,
      pr_title: 'add customer LTV calculation to dim_customers',
      author: 'sarah-k',
      changed_files: ['models/marts/customers/dim_customers.sql'],
      committed_at: daysAgo(2),
      is_likely_cause: false,
      source: 'simulated',
    },
    {
      pipeline_name: 'dbt_customers_transform',
      commit_sha: 'c1f4a9b',
      pr_number: 243,
      pr_title: 'update customer segment documentation',
      author: 'marcus-t',
      changed_files: ['models/marts/customers/schema.yml'],
      committed_at: daysAgo(7),
      is_likely_cause: false,
      source: 'simulated',
    },

    // fivetran_orders_daily: no code changes — correct to ignore
    {
      pipeline_name: 'fivetran_orders_daily',
      commit_sha: 'd8b2c5f',
      pr_number: 244,
      pr_title: 'add order_discount_amount to orders staging model',
      author: 'sarah-k',
      changed_files: ['models/staging/fivetran/stg_orders.sql'],
      committed_at: daysAgo(10),
      is_likely_cause: false,
      source: 'simulated',
    },
    {
      pipeline_name: 'fivetran_orders_daily',
      commit_sha: 'e3a7f2c',
      pr_number: 239,
      pr_title: 'refactor orders mart partitioning',
      author: 'alex-p',
      changed_files: ['models/marts/orders/fct_orders.sql'],
      committed_at: daysAgo(30),
      is_likely_cause: false,
      source: 'simulated',
    },

    // snowflake_revenue_mart: recent but unrelated changes
    {
      pipeline_name: 'snowflake_revenue_mart',
      commit_sha: 'f6d4e8a',
      pr_number: 245,
      pr_title: 'add revenue attribution by channel to revenue mart',
      author: 'marcus-t',
      changed_files: ['models/marts/revenue/fct_revenue.sql', 'models/marts/revenue/dim_channels.sql'],
      committed_at: daysAgo(3),
      is_likely_cause: false,
      source: 'simulated',
    },

    // databricks_ml_pipeline
    {
      pipeline_name: 'databricks_ml_pipeline',
      commit_sha: 'g2h9k1m',
      pr_number: 241,
      pr_title: 'increase batch size for customer embedding model training',
      author: 'ml-team-oncall',
      changed_files: ['pipelines/ml/customer_embeddings.py', 'pipelines/ml/config.yaml'],
      committed_at: daysAgo(16),
      is_likely_cause: false,
      source: 'simulated',
    },

    // payments_dbt_pipeline
    {
      pipeline_name: 'payments_dbt_pipeline',
      commit_sha: 'h3j7l2n',
      pr_number: 248,
      pr_title: 'add payment_method_type to payments fact table',
      author: 'alex-p',
      changed_files: ['models/staging/stripe/stg_payments.sql', 'models/marts/payments/fct_payments.sql'],
      committed_at: daysAgo(6),
      is_likely_cause: false,
      source: 'simulated',
    },

    // dbt_marketing_attribution: smoking gun — stg_ad_spend renamed 6h ago
    {
      pipeline_name: 'dbt_marketing_attribution',
      commit_sha: 'k7m3n9p',
      pr_number: 249,
      pr_title: 'rename stg_ad_spend to stg_ad_spend_daily for clarity',
      author: 'marcus-t',
      changed_files: ['models/staging/google_ads/stg_ad_spend.sql', 'models/staging/google_ads/stg_ad_spend_daily.sql'],
      committed_at: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
      is_likely_cause: true,
      source: 'simulated',
    },
    {
      pipeline_name: 'dbt_marketing_attribution',
      commit_sha: 'j2k8l4q',
      pr_number: 245,
      pr_title: 'add new google ads spend metrics',
      author: 'sarah-k',
      changed_files: ['models/staging/google_ads/stg_ad_spend.sql'],
      committed_at: daysAgo(3),
      is_likely_cause: false,
      source: 'simulated',
    },

    // hooli real pipeline names (from data-eng-prod deployment)
    {
      pipeline_name: 'run_etl_pipeline',
      commit_sha: '2cc6f2c',
      pr_number: 312,
      pr_title: 'increase batch size for enriched_data chunks from 8 to 12',
      author: 'data-eng-team',
      changed_files: ['batch_enrichment/assets/enriched_data.py', 'batch_enrichment/config.yaml'],
      committed_at: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(),
      is_likely_cause: true,
      source: 'simulated',
    },
    {
      pipeline_name: 'orders_augmented',
      commit_sha: 'aae00c4',
      pr_number: 308,
      pr_title: 'add company revenue tier to orders_augmented model',
      author: 'analytics-eng',
      changed_files: ['data_eng_pipeline/models/analytics/orders_augmented.sql'],
      committed_at: daysAgo(2),
      is_likely_cause: false,
      source: 'simulated',
    },
  ];

  for (const g of gitRows) {
    await sql`
      INSERT INTO git_context (org_id, pipeline_name, commit_sha, pr_number, pr_title,
                               author, changed_files, committed_at, is_likely_cause, source)
      VALUES ('default', ${g.pipeline_name}, ${g.commit_sha}, ${g.pr_number}, ${g.pr_title},
              ${g.author}, ${g.changed_files}, ${g.committed_at}, ${g.is_likely_cause}, ${g.source})
      ON CONFLICT DO NOTHING
    `;
  }
  console.log(`✅ Inserted ${gitRows.length} git context rows`);

  // ----------------------------------------------------------------
  // EVAL CASES (8 entries)
  // ----------------------------------------------------------------

  const evalCases = [
    {
      name: 'Schema mismatch with smoking-gun PR',
      input_log: `ERROR 2026-06-28 02:14:33 UTC [dbt] KeyError: 'customer_tier'
  File "models/marts/customers/fct_customer_orders.sql", line 47
  Database Error in model fct_customer_orders (models/marts/customers/fct_customer_orders.sql)
    column "customer_tier" of relation "dim_customers" does not exist
    LINE 47: SELECT c.customer_tier, SUM(o.order_amount) as revenue
    Compiled SQL at target/compiled/dbt_project/models/marts/customers/fct_customer_orders.sql
  Pipeline: dbt_customers_transform
  Dagster Run ID: run-abc-123
  Asset: dbt_customers_transform`,
      expected_failure_type: 'schema_mismatch',
      expected_keywords: ['customer_tier', 'PR #247', 'rename'],
      forbidden_patterns: [],
      should_find_runbook: true,
      should_find_git_cause: true,
      notes: 'Smoking gun test: PR #247 renamed customer_segment → customer_tier 4h ago. Agent must find it.',
    },
    {
      name: 'Fivetran orders — known flaky upstream',
      input_log: `WARNING 2026-06-28 03:02:11 UTC [dagster] Asset materialization failed: fivetran_orders_daily
  FivetranSyncError: No new data available from connector orders_shopify
  Last successful sync: 2026-06-28 01:15:00 UTC
  Expected freshness: 60 minutes
  Current lag: 107 minutes
  Connector status: SYNCING (rate limited)
  Shopify API error: 429 Too Many Requests
  Pipeline: fivetran_orders_daily`,
      expected_failure_type: 'upstream_data_missing',
      expected_keywords: ['Fivetran', 'wait', 'flaky'],
      forbidden_patterns: ['escalate immediately', 'critical incident'],
      should_find_runbook: true,
      should_find_git_cause: false,
      notes: 'Should identify as known_flaky (8 incidents in 90 days) and recommend waiting, not escalating.',
    },
    {
      name: 'dbt compilation error — missing ref',
      input_log: `ERROR 2026-06-28 04:33:12 UTC [dbt] Compilation Error
  dbt found an error when compiling the SQL for model 'fct_marketing_attribution':
    Compilation Error in model fct_marketing_attribution (models/marts/marketing/fct_marketing_attribution.sql)
    "ref" is undefined: node.ref.stg_ad_spend not found
    The model "stg_ad_spend" was not found. This could be because:
      - A model with this name doesn't exist
      - The model is disabled
    Pipeline: dbt_marketing_attribution`,
      expected_failure_type: 'dbt_compilation_error',
      expected_keywords: ['ref', 'rename', 'compile'],
      forbidden_patterns: [],
      should_find_runbook: true,
      should_find_git_cause: true,
      notes: 'PR #249 renamed stg_ad_spend → stg_ad_spend_daily 6h ago. Agent must find it.',
    },
    {
      name: 'Databricks resource exhaustion',
      input_log: `ERROR 2026-06-28 01:44:55 UTC [databricks] Job failed: customer_embedding_training
  com.databricks.backend.daemon.driver.DriverClient$ClusterAutoTerminatedException:
  Cluster j-abc123 terminated due to auto-suspend after 2 minutes of inactivity
  Job run ID: 4821749
  Cluster: ml-training-cluster-m5.4xlarge
  Duration before failure: 94 minutes
  Pipeline: databricks_ml_pipeline`,
      expected_failure_type: 'resource_exhaustion',
      expected_keywords: ['auto-suspend', 'retry', 'warehouse'],
      forbidden_patterns: ['just retry', 'retry without'],
      should_find_runbook: true,
      should_find_git_cause: false,
      notes: 'Should find runbook and explicitly say NOT to just retry without fixing resource issue.',
    },
    {
      name: 'Snowflake permission denied — quarterly rotation',
      input_log: `ERROR 2026-06-28 06:15:44 UTC [snowflake] Pipeline failed: snowflake_raw_ingestion
sqlalchemy.exc.ProgrammingError: (snowflake.connector.errors.ProgrammingError) 003001 (42501):
Insufficient privileges to operate on schema 'RAW.SALESFORCE'
User: DISPATCH_SVC_ACCT
Role: DISPATCH_ROLE
Error code: 003001 (permission denied)
Message: Access to SCHEMA 'RAW.SALESFORCE' is denied for user DISPATCH_SVC_ACCT
Note: Credentials were last rotated 91 days ago — quarterly rotation may be overdue
Pipeline: snowflake_raw_ingestion`,
      expected_failure_type: 'permission_denied',
      expected_keywords: ['credential', 'rotation', 'quarterly'],
      forbidden_patterns: [],
      should_find_runbook: true,
      should_find_git_cause: false,
      notes: 'Should identify credential rotation as likely cause based on runbook pattern.',
    },
    {
      name: 'First-ever failure on revenue mart — escalate',
      input_log: `ERROR 2026-06-28 07:22:01 UTC [dagster] Asset materialization failed: snowflake_revenue_mart
  SnowflakeError: Query timeout after 300 seconds
  Query ID: 01ab8f4c-0000-1234-0000-000000000001
  SQL: INSERT INTO PROD.REVENUE.FCT_REVENUE SELECT ...
  Rows scanned: 847,293,441
  Pipeline: snowflake_revenue_mart`,
      expected_failure_type: 'resource_exhaustion',
      expected_keywords: ['escalate'],
      forbidden_patterns: [],
      should_find_runbook: false,
      should_find_git_cause: false,
      notes: 'Zero incident history. No runbook. Confidence should be Low-Medium. Should recommend escalation.',
    },
    {
      name: 'Cascading failure — downstream dbt tests from upstream Fivetran',
      input_log: `ERROR 2026-06-28 05:11:22 UTC [dbt] Multiple test failures detected
  Test not_null_fct_orders_order_id: FAIL (1,247 failures)
  Test not_null_fct_orders_customer_id: FAIL (1,247 failures)  
  Test not_null_fct_orders_created_at: FAIL (1,247 failures)
  Test relationships_fct_orders_customer_id: FAIL (1,247 failures)
  Root model: stg_orders (sourced from RAW.FIVETRAN.ORDERS)
  Note: fivetran_orders_daily failed to sync 2 hours ago (rate limited)
  Pipeline: payments_dbt_pipeline`,
      expected_failure_type: 'dbt_test_failure',
      expected_keywords: ['Fivetran', 'upstream', 'root cause'],
      forbidden_patterns: ['fix the dbt model'],
      should_find_runbook: true,
      should_find_git_cause: false,
      notes: 'Immediate failure IS dbt_test_failure; agent must identify Fivetran upstream root cause in response.',
    },
    {
      name: 'Ambiguous log — insufficient info',
      input_log: `ERROR [pipeline] Failed
Error: unexpected error
Check logs for details
Exit code: 1`,
      expected_failure_type: 'unknown',
      expected_keywords: ['more context'],
      forbidden_patterns: ['customer_tier', 'Fivetran', 'Snowflake credentials'],
      should_find_runbook: false,
      should_find_git_cause: false,
      notes: 'Truncated log with no useful signals. Should classify as unknown with Low confidence and ask for more context.',
    },
  ];

  for (const ec of evalCases) {
    await sql`
      INSERT INTO eval_cases (org_id, name, input_log, expected_failure_type,
                              expected_keywords, forbidden_patterns, should_find_runbook,
                              should_find_git_cause, notes)
      VALUES ('default', ${ec.name}, ${ec.input_log}, ${ec.expected_failure_type},
              ${ec.expected_keywords}, ${ec.forbidden_patterns}, ${ec.should_find_runbook},
              ${ec.should_find_git_cause}, ${ec.notes})
      ON CONFLICT ON CONSTRAINT eval_cases_org_name_unique
      DO UPDATE SET
        input_log = EXCLUDED.input_log,
        expected_failure_type = EXCLUDED.expected_failure_type,
        expected_keywords = EXCLUDED.expected_keywords,
        forbidden_patterns = EXCLUDED.forbidden_patterns,
        should_find_runbook = EXCLUDED.should_find_runbook,
        should_find_git_cause = EXCLUDED.should_find_git_cause,
        notes = EXCLUDED.notes
    `;
  }
  console.log(`✅ Inserted ${evalCases.length} eval cases`);

  console.log('\n✨ Seed complete!');
  console.log('   Runbooks: ', runbooks.length);
  console.log('   Incidents:', incidents.length);
  console.log('   Git rows: ', gitRows.length);
  console.log('   Eval cases:', evalCases.length);
}

seed().catch(err => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
