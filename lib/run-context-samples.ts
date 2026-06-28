// Client-safe constants from run-context — no server imports.
// Keep SAMPLE_RUN_IDS here so client components can import it without pulling
// in Neon, Dagster, or any other server-side dependency.

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
    label: 'hooli data-eng-prod: run_etl_pipeline FAILURE — enriched_data.process_chunk[9] exhausted retries',
    description: 'Real Dagster run from hooli/data-eng-prod. process_chunk calls EnrichmentAPI.get_order_details() — chunk #9 failed 2× step retries + 1× run retry. Public source code read directly from dagster-io/hooli-data-eng-pipelines.',
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
