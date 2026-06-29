// Lineage inference — no OpenLineage/Marquez required.
//
// Six signals combine to infer the full dependency graph:
//
// 1. NAMING CONVENTIONS  — dbt/SQLMesh layers (mart_ → int_ → stg_ → raw_)
// 2. CO-FAILURE PATTERNS — if B fails 20min after A, A is upstream
// 3. RUNBOOK CROSS-REFERENCES — runbooks mention upstream pipelines
// 4. REPO STRUCTURE — dbt sources.yml / SQLMesh seeds / dlt schemas from GitHub
// 5. ERROR TEXT EXTRACTION — table names in SQL errors reveal the owner
// 6. TOOL FINGERPRINTS — error stack traces and log lines identify the tool chain:
//      dlt: "_dlt_loads", "PipelineStepFailed", "dlt.pipeline"
//      Airbyte: "_airbyte_raw_id", "AirbyteTraceMessage", "_ab_cdc_"
//      Snowpipe: "COPY_HISTORY", "SNOWPIPE_", auto-ingest
//      Snowflake streams+tasks: "STREAM_", "TASK_HISTORY", "scheduled task"
//      Dynamic Tables: "DYNAMIC TABLE", "DT_"
//      SQLMesh: "sqlmesh.core", "::" model notation
//      Coalesce: "coalesce_" prefix, "COALESCE_WORKSPACE"
//      Census/Hightouch: reverse ETL downstream tables
//      Spark/Databricks: "com.databricks", "SparkException", "_delta_log"
//      Mage: "mage_ai", "pipeline_run", MageAI stack traces
//      Prefect: "prefect.engine", "FlowRun", PrefectHTTPStatusError
//
// The walk is directional and multi-hop: a Snowpipe feeds a stream, the stream
// triggers a task, the task writes a table that dbt reads as a source.
// We trace as many hops as the signals support.

import { sql } from './db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolOwner =
  | 'fivetran' | 'airbyte' | 'stitch' | 'meltano' | 'singer' | 'hevo' | 'dlt' | 'portable'
  | 'dbt' | 'sqlmesh' | 'coalesce' | 'dataform'
  | 'dagster' | 'airflow' | 'prefect' | 'mage' | 'kestra' | 'flyte'
  | 'snowflake_task' | 'snowpipe' | 'snowflake_stream' | 'dynamic_table' | 'snowflake_proc'
  | 'databricks' | 'spark'
  | 'census' | 'hightouch'   // reverse ETL — downstream of the mart layer
  | 'manual' | 'unknown';

export interface LineageNode {
  id: string;
  type: 'ingestion' | 'dbt_model' | 'sqlmesh_model' | 'dagster_asset' | 'orchestrator_task'
      | 'snowflake_native' | 'reverse_etl' | 'raw_table' | 'unknown';
  layer: 'source' | 'raw' | 'staging' | 'intermediate' | 'mart' | 'reverse_etl' | 'unknown';
  tool: ToolOwner;
  upstreamIds: string[];
  downstreamIds: string[];
  inferenceMethod: ('naming' | 'co_failure' | 'runbook_mention' | 'repo_structure' | 'error_extraction' | 'tool_fingerprint')[];
}

export interface InferredLineage {
  focusNode: string;
  upstreamNodes: LineageNode[];
  downstreamNodes: LineageNode[];
  confidence: 'high' | 'medium' | 'low';
  confidenceNote: string;
  detectedTools?: string[];
  extractedTables?: TableRef[];
}

export interface TableRef {
  raw: string;
  database: string;
  schema: string;
  table: string;
  layer: LineageNode['layer'];
  tool: ToolOwner;
  pipelineHints: string[];
  chainDescription: string;  // human-readable upstream chain
}

// ---------------------------------------------------------------------------
// 6. TOOL FINGERPRINT DETECTION
// Scans raw log/error text for tool-specific signatures.
// Returns every tool found anywhere in the call chain.
// ---------------------------------------------------------------------------

interface ToolFingerprint {
  tool: ToolOwner;
  role: 'ingestion' | 'transformation' | 'orchestration' | 'storage' | 'reverse_etl';
  layer: LineageNode['layer'];
  patterns: (string | RegExp)[];
  note: string;
}

const TOOL_FINGERPRINTS: ToolFingerprint[] = [
  // --- Ingestion tools ---
  {
    tool: 'dlt', role: 'ingestion', layer: 'raw',
    patterns: [
      '_dlt_loads', '_dlt_pipeline_state', '_dlt_version', '_dlt_sentinel',
      'dlt.pipeline', 'dlt.sources', 'DltSource', 'DltResource',
      'PipelineStepFailed', 'dlt.exceptions', 'dlt_destination',
      /normalize_storage/, /dlt\.(extract|normalize|load)/,
    ],
    note: 'dlt (data load tool) — Python-native ELT library, often embedded in Dagster/Airflow assets. Leaves _dlt_* system tables in the destination schema.',
  },
  {
    tool: 'airbyte', role: 'ingestion', layer: 'raw',
    patterns: [
      '_airbyte_raw_id', '_airbyte_extracted_at', '_airbyte_normalized_at',
      '_ab_cdc_', 'AirbyteTraceMessage', 'io.airbyte', 'AIRBYTE_INTERNAL',
      '_airbyte_raw_', 'airbyte_tmp', /AirbyteRecordMessage/, /airbyte\.protocol/,
    ],
    note: 'Airbyte — adds _airbyte_* metadata columns to every raw table. Raw tables land in _airbyte_raw_ schema before normalization.',
  },
  {
    tool: 'fivetran', role: 'ingestion', layer: 'raw',
    patterns: [
      '_fivetran_synced', '_fivetran_id', '_fivetran_deleted', '_fivetran_index',
      'fivetran_log', 'FivetranSyncError', /fivetran\.(connector|sync)/i,
    ],
    note: 'Fivetran — adds _fivetran_* metadata columns. Silent failures common: sync shows SUCCESS with 0 rows when upstream API returns empty.',
  },
  {
    tool: 'stitch', role: 'ingestion', layer: 'raw',
    patterns: ['_sdc_received_at', '_sdc_sequence', '_sdc_table_version', '_sdc_batched_at', 'STITCH'],
    note: 'Stitch — adds _sdc_* metadata columns to raw tables.',
  },
  {
    tool: 'meltano', role: 'ingestion', layer: 'raw',
    patterns: ['meltano', '.meltano/', 'meltano.yml', 'tap-', 'target-', /meltano\.(cli|core)/],
    note: 'Meltano — Singer-based ELT. Taps produce raw data, targets load to warehouse.',
  },
  {
    tool: 'hevo', role: 'ingestion', layer: 'raw',
    patterns: ['hevo_', '_hevo_', 'HevoData', /hevo\.(pipeline|source)/i],
    note: 'Hevo Data — managed ETL. Tables often prefixed with hevo_ in the destination.',
  },
  {
    tool: 'portable', role: 'ingestion', layer: 'raw',
    patterns: ['portable_io', 'portable.io', /_portable_/i],
    note: 'Portable.io — managed Singer connector platform.',
  },
  // --- Snowflake-native pipeline patterns ---
  {
    tool: 'snowpipe', role: 'ingestion', layer: 'raw',
    patterns: [
      'SNOWPIPE', 'COPY_HISTORY', 'AUTO_INGEST', 'PIPE_STATUS',
      /snowpipe/i, /auto.ingest/i, /copy into.*from @/i,
    ],
    note: 'Snowflake Snowpipe — continuous micro-batch ingestion from S3/GCS/Azure. Check COPY_HISTORY for failed files.',
  },
  {
    tool: 'snowflake_stream', role: 'ingestion', layer: 'raw',
    patterns: [
      'STREAM_', 'CREATE STREAM', 'SYSTEM$STREAM_HAS_DATA',
      /stream on/i, /consume.*stream/i, /stale_after/i,
    ],
    note: 'Snowflake Stream — CDC change tracking table. Streams go stale if not consumed within the data retention window (14 days default).',
  },
  {
    tool: 'snowflake_task', role: 'orchestration', layer: 'raw',
    patterns: [
      'SCHEDULED_TIME', 'TASK_HISTORY', 'EXECUTE TASK', 'CREATE TASK',
      'SYSTEM$TASK_DEPENDENTS_ENABLE', /task_graph_run_id/i,
      /after.*task/i, /warehouse.*size.*task/i,
    ],
    note: 'Snowflake Task — serverless or warehouse-compute scheduled SQL. Check TASK_HISTORY for error messages and SCHEDULED_TIME.',
  },
  {
    tool: 'dynamic_table', role: 'transformation', layer: 'staging',
    patterns: [
      'DYNAMIC TABLE', 'DT_', 'TARGET_LAG', 'DOWNSTREAM_LAG',
      /dynamic table/i, /refresh.*lag/i,
    ],
    note: 'Snowflake Dynamic Table — incremental refresh driven by upstream changes. Lag failures mean the upstream table stopped updating.',
  },
  {
    tool: 'snowflake_proc', role: 'transformation', layer: 'raw',
    patterns: [
      'CALL ', 'CREATE PROCEDURE', 'EXECUTE IMMEDIATE',
      /stored procedure/i, /sproc/i,
    ],
    note: 'Snowflake Stored Procedure — custom SQL/JavaScript/Python transformation. Check error in QUERY_HISTORY.',
  },
  // --- Transformation tools ---
  {
    tool: 'dbt', role: 'transformation', layer: 'staging',
    patterns: [
      'dbt run', 'dbt test', 'dbt compile', 'dbt.exceptions',
      'DbtRuntimeError', 'DbtCompilationError', 'ref(', 'source(',
      /models\/.*\.sql/, /dbt_project\.yml/, /packages\.yml/,
    ],
    note: 'dbt — SQL transformation. ref() and source() calls define the lineage graph. Schema naming: stg_ → int_ → fct_/dim_.',
  },
  {
    tool: 'sqlmesh', role: 'transformation', layer: 'staging',
    patterns: [
      'sqlmesh', 'SQLMesh', 'sqlmesh.core', /sqlmesh\.dbt/, /::/,
      'sqlmesh plan', 'sqlmesh run', /\.py@.*model/i,
    ],
    note: 'SQLMesh — next-gen SQL transformation compatible with dbt. Uses :: model notation. Supports Python models.',
  },
  {
    tool: 'coalesce', role: 'transformation', layer: 'staging',
    patterns: [
      'coalesce_', 'COALESCE_WORKSPACE', /coalesce\.app/i, /coalesce\.io/i,
    ],
    note: 'Coalesce — GUI-based SQL transformation. Tables often prefixed coalesce_.',
  },
  {
    tool: 'dataform', role: 'transformation', layer: 'staging',
    patterns: [
      'dataform', '.sqlx', 'dataform.json', /dataform\.co/i,
      /assertions\/.*\.sqlx/, /definitions\/.*\.sqlx/,
    ],
    note: 'Dataform (Google) — SQL transformation on BigQuery/Snowflake. Uses .sqlx files.',
  },
  // --- Orchestrators (already running when these appear in logs) ---
  {
    tool: 'dagster', role: 'orchestration', layer: 'unknown',
    patterns: [
      'dagster', 'DagsterRunStatus', 'DagsterEvent', 'OpExecutionContext',
      'DAGSTER_HOME', /dagster_home/i, /dagster\.(core|pipes)/,
    ],
    note: 'Dagster — asset-based orchestrator. Run logs available via MCP get_run_logs. Asset graph traversal finds downstream impact.',
  },
  {
    tool: 'prefect', role: 'orchestration', layer: 'unknown',
    patterns: [
      'prefect.engine', 'FlowRun', 'PrefectHTTPStatusError', 'PREFECT_API_URL',
      /prefect\.(flows|tasks|deployments)/, /flow_run_id/, /task_run_id/,
    ],
    note: 'Prefect — flow-based orchestrator. Check Prefect Cloud API for flow run logs.',
  },
  {
    tool: 'airflow', role: 'orchestration', layer: 'unknown',
    patterns: [
      'ExternalTaskSensor', 'TriggerDagRunOperator', 'DagRun', 'airflow.exceptions',
      'airflow.models', 'XCom', 'AIRFLOW_HOME', 'dag_id', 'task_instance',
      // Dataset / Asset patterns (Airflow 2.4+)
      /Dataset\s*\(/, /@task\s*\([^)]*outlets/, /schedule\s*=\s*\[Dataset/,
      // Airflow 3.x Assets
      /@asset\s*\(/, /schedule_on\s*=/, /AirflowAsset/,
      // Common Airflow errors
      /AirflowException/, /AirflowTaskTimeout/, /AirflowSensorTimeout/,
      /dag_dependencies/, /astro-airflow-mcp/,
    ],
    note: 'Apache Airflow — DAG-based orchestrator. Airflow 2.4+ Datasets provide native lineage (GET /api/v1/dag_dependencies). Astronomer MCP (astro-airflow-mcp) exposes list_assets, get_upstream_asset_events.',
  },
  {
    tool: 'mage', role: 'orchestration', layer: 'unknown',
    patterns: [
      'mage_ai', 'MageAI', 'pipeline_run', /mage\.ai/i,
      /from mage_ai/, /mage_ai\.settings/,
    ],
    note: 'Mage — open-source data pipeline tool. Check Mage UI for block-level error details.',
  },
  {
    tool: 'kestra', role: 'orchestration', layer: 'unknown',
    patterns: [
      'kestra.io', 'io.kestra', /kestra\.(core|runners)/, /namespace:.*kestra/,
    ],
    note: 'Kestra — YAML-based workflow orchestrator.',
  },
  // --- Cloud-native / serverless execution (most common "no orchestrator" patterns) ---
  {
    tool: 'airflow', role: 'orchestration', layer: 'unknown',  // already defined above but keeping slot
    patterns: [], note: '',  // deduplicated via seen set
  },
  {
    tool: 'unknown', role: 'ingestion', layer: 'unknown',   // AWS Lambda
    patterns: [
      'aws-lambda-java', 'com.amazonaws.services.lambda', 'LambdaLogger',
      'LAMBDA_TASK_ROOT', 'AWS_LAMBDA_FUNCTION_NAME', 'RequestId:',
      /lambda_handler/, /Handler.*lambda/i, /FunctionError.*Lambda/i,
      'Runtime.ExitError', 'Runtime.ImportModuleError',
    ],
    note: 'AWS Lambda — serverless function. Check CloudWatch Logs for /aws/lambda/{function-name}. If this writes to S3/Snowflake, trace what reads from there next.',
  } as unknown as ToolFingerprint,
  // We can't add 'lambda' to ToolOwner union without breaking types, use a cast
  {
    tool: 'unknown', role: 'orchestration', layer: 'unknown',  // AWS Glue
    patterns: [
      'GlueContext', 'glueContext', 'aws-glue', 'AWS_GLUE',
      /com\.amazonaws\.services\.glue/, /glue\.job\.commit/,
      'GLUE_JOB_NAME', 'GlueJobRun', /glue_catalog/i,
    ],
    note: 'AWS Glue — managed Spark ETL. Check Glue Console → Jobs → Run details. Tables land in Glue Data Catalog → Athena / Redshift Spectrum reads them.',
  } as unknown as ToolFingerprint,
  {
    tool: 'unknown', role: 'transformation', layer: 'unknown',  // Azure Data Factory
    patterns: [
      'ADF_PIPELINE', 'azure-data-factory', 'Microsoft.DataFactory',
      'ActivityRunEnd', 'PipelineRunEnd', 'TriggerRunEnd',
      /DataFactory.*Pipeline/i, /ADF.*failed/i,
      'Azure Data Factory', 'adf_pipeline_run_id',
    ],
    note: 'Azure Data Factory — cloud ETL. Check ADF Monitor → Pipeline Runs → Activity Runs for the failing step. ADF lineage is in Azure Purview if configured.',
  } as unknown as ToolFingerprint,
  {
    tool: 'unknown', role: 'transformation', layer: 'unknown',  // Databricks Lakeflow
    patterns: [
      'lakeflow', 'LakeFlow', 'databricks.sdk.service.pipelines',
      'DLT_', 'dlt_pipeline', /delta live tables/i, /DLT pipeline/i,
      'PIPELINE_UPDATE_ID', 'pipelineId.*databricks',
    ],
    note: 'Databricks Lakeflow / Delta Live Tables — streaming + batch DLT pipeline. Check Databricks UI → Delta Live Tables → Pipeline runs. Lineage in Unity Catalog lineage graph.',
  } as unknown as ToolFingerprint,
  {
    tool: 'unknown', role: 'ingestion', layer: 'unknown',  // GitHub Actions as data pipeline trigger
    patterns: [
      'GITHUB_ACTIONS', 'GITHUB_WORKFLOW', 'GITHUB_RUN_ID',
      'actions/checkout', 'runs-on:', /workflow_dispatch/,
    ],
    note: 'GitHub Actions — CI/CD used as a data pipeline trigger. Check Actions → Workflow runs. Upstream: what workflow triggered this? Downstream: what job depends on this artifact/push?',
  } as unknown as ToolFingerprint,
  // --- Databricks / Spark ---
  {
    tool: 'databricks', role: 'transformation', layer: 'unknown',
    patterns: [
      'com.databricks', 'DatabricksException', 'CLOUD_PROVIDER_SHUTDOWN',
      'ClusterAutoTerminatedException', '_delta_log', 'DeltaTable',
      /dbutils\.(fs|secrets)/, /spark\.read/, /SparkContext/,
    ],
    note: 'Databricks — Spark execution on Delta Lake. Check Jobs API for cluster OOM / spot preemption. Unity Catalog provides lineage if enabled.',
  },
  {
    tool: 'spark', role: 'transformation', layer: 'unknown',
    patterns: [
      'SparkException', 'org.apache.spark', 'pyspark', 'SparkContext',
      /py4j\.java_gateway/, /AnalysisException.*spark/,
    ],
    note: 'Apache Spark — distributed computation. Check executor logs for OOM / shuffle errors.',
  },
  // --- Reverse ETL (downstream consumers of marts) ---
  {
    tool: 'census', role: 'reverse_etl', layer: 'reverse_etl',
    patterns: [
      '_census_', 'census.app', 'GetDbt Census', /census\.(io|app)/i,
    ],
    note: 'Census — reverse ETL. Reads from analytics mart → syncs to CRM/ads. A mart failure will block Census syncs.',
  },
  {
    tool: 'hightouch', role: 'reverse_etl', layer: 'reverse_etl',
    patterns: [
      '_hightouch_', 'hightouch.io', 'hightouch.com', /hightouch\.(sync|model)/i,
    ],
    note: 'Hightouch — reverse ETL. Reads from analytics mart → syncs to destinations. Check Hightouch sync logs if mart data is stale.',
  },
];

// Detect all tools mentioned anywhere in a log/error block
export function detectToolsFromLog(logText: string): { tool: ToolOwner; note: string; role: ToolFingerprint['role'] }[] {
  const found: { tool: ToolOwner; note: string; role: ToolFingerprint['role'] }[] = [];
  const seen = new Set<ToolOwner>();

  for (const fp of TOOL_FINGERPRINTS) {
    if (seen.has(fp.tool)) continue;
    const matched = fp.patterns.some(p =>
      typeof p === 'string' ? logText.includes(p) : p.test(logText)
    );
    if (matched) {
      found.push({ tool: fp.tool, note: fp.note, role: fp.role });
      seen.add(fp.tool);
    }
  }

  return found;
}

// Build a multi-hop chain description from detected tools
// e.g. [dlt, dagster, dbt] → "dlt (embedded in Dagster asset) → raw table → dbt staging → mart"
export function buildToolChain(detectedTools: ReturnType<typeof detectToolsFromLog>): string {
  if (detectedTools.length === 0) return 'No specific tools identified from log signatures.';

  const ingestion = detectedTools.filter(t => t.role === 'ingestion');
  const orchestration = detectedTools.filter(t => t.role === 'orchestration');
  const transformation = detectedTools.filter(t => t.role === 'transformation');
  const storage = detectedTools.filter(t => t.role === 'storage');
  const reverseEtl = detectedTools.filter(t => t.role === 'reverse_etl');

  const parts: string[] = [];

  if (ingestion.length > 0) {
    const names = ingestion.map(t => t.tool).join(' / ');
    const hasDlt = ingestion.some(t => t.tool === 'dlt');
    const hasSnowpipe = ingestion.some(t => t.tool === 'snowpipe');
    const hasStream = ingestion.some(t => t.tool === 'snowflake_stream');

    if (hasDlt && orchestration.length > 0) {
      parts.push(`dlt (embedded in ${orchestration[0].tool} asset) → raw schema`);
    } else if (hasSnowpipe && hasStream) {
      parts.push(`Snowpipe (auto-ingest from cloud storage) → Snowflake Stream (CDC) → Task → raw table`);
    } else {
      parts.push(`${names} → raw schema`);
    }
  }

  if (transformation.length > 0) {
    const hasDbt = transformation.some(t => t.tool === 'dbt');
    const hasSqlmesh = transformation.some(t => t.tool === 'sqlmesh');
    const hasDynamicTable = transformation.some(t => t.tool === 'dynamic_table');
    const hasSnowflakeTask = detectedTools.some(t => t.tool === 'snowflake_task');

    if (hasDynamicTable) {
      parts.push(`Snowflake Dynamic Table (auto-refresh) → mart layer`);
    } else if (hasSnowflakeTask && hasDbt) {
      parts.push(`Snowflake Task (pre-processing) → ${hasDbt ? 'dbt' : 'sqlmesh'} (stg_ → int_ → fct_) → mart`);
    } else if (hasDbt) {
      parts.push(`dbt (stg_ → int_ → fct_/dim_) → analytics mart`);
    } else if (hasSqlmesh) {
      parts.push(`SQLMesh (:: model notation) → analytics mart`);
    } else {
      parts.push(transformation.map(t => t.tool).join(' → '));
    }
  }

  if (reverseEtl.length > 0) {
    parts.push(`→ ${reverseEtl.map(t => t.tool).join(' / ')} (reverse ETL to CRM/ads)`);
  }

  if (parts.length === 0) {
    return detectedTools.map(t => `${t.tool} (${t.role})`).join(' → ');
  }

  return parts.join('\n  → ');
}

// ---------------------------------------------------------------------------
// 5. ERROR TEXT EXTRACTION — parse table names from SQL errors
// ---------------------------------------------------------------------------

function schemaToLayer(schema: string): LineageNode['layer'] {
  const s = schema.toUpperCase();
  // Bronze/Silver/Gold (medallion architecture)
  if (['RAW', 'FIVETRAN', 'AIRBYTE', 'STITCH', 'INGESTION', 'LANDING', 'BRONZE', 'LAKE'].includes(s)) return 'raw';
  if (['STAGING', 'STG', 'SILVER'].includes(s) || s.startsWith('STG_')) return 'staging';
  if (['INTERMEDIATE', 'INT'].includes(s) || s.startsWith('INT_')) return 'intermediate';
  if (['ANALYTICS', 'MARTS', 'WAREHOUSE', 'DWH', 'GOLD', 'REPORTING', 'PRESENTATION', 'CURATED'].includes(s)) return 'mart';
  if (['ML', 'FEATURES', 'FEATURE_STORE', 'PLATINUM'].includes(s)) return 'unknown';
  return 'unknown';
}

function schemaToTool(schema: string, tableName: string): ToolOwner {
  const s = schema.toUpperCase();
  const t = tableName.toUpperCase();

  if (s === 'AIRBYTE' || t.startsWith('_AIRBYTE_RAW_')) return 'airbyte';
  if (s === 'STITCH' || t.startsWith('_SDC_')) return 'stitch';
  if (['TASKS', 'PROCEDURES', 'SPROCS'].includes(s)) return 'snowflake_task';
  if (s.includes('SNOWPIPE') || t.startsWith('SNOWPIPE_')) return 'snowpipe';
  if (s.includes('STREAM') || t.startsWith('STREAM_')) return 'snowflake_stream';
  if (['ML', 'FEATURES', 'FEATURE_STORE'].includes(s)) return 'databricks';
  if (['RAW', 'FIVETRAN', 'BRONZE', 'LANDING'].includes(s)) return 'fivetran'; // Fivetran is most common raw loader

  // dlt system tables anywhere
  if (t.startsWith('_DLT_')) return 'dlt';

  // dbt naming conventions
  if (['STG_', 'INT_', 'FCT_', 'DIM_', 'MART_'].some(p => t.startsWith(p))) return 'dbt';
  if (['STAGING', 'STG', 'INTERMEDIATE', 'INT', 'ANALYTICS', 'MARTS', 'DWH', 'REPORTING'].includes(s)) return 'dbt';

  return 'unknown';
}

function buildChainDescription(schema: string, table: string, tool: ToolOwner): string {
  const domain = table.toLowerCase()
    .replace(/^(_dlt_|_airbyte_raw_|_sdc_|stg_|int_|fct_|dim_|mart_|raw_)/, '')
    .replace(/_(daily|hourly|weekly|v\d+)$/, '');
  const src = domain.split('_')[0];

  switch (tool) {
    case 'fivetran':
      return [
        `Fivetran connector (${src} source) → ${schema}.${table} [raw]`,
        `→ stg_${domain} (dbt/SQLMesh staging — cleans + casts columns)`,
        `→ int_${domain} (dbt intermediate — business logic)`,
        `→ fct_${domain} / dim_${src} (mart layer — BI / reverse ETL consumers)`,
      ].join('\n  ');
    case 'airbyte':
      return [
        `Airbyte ${src} connection → _airbyte_raw_${domain} [raw, with _airbyte_* columns]`,
        `→ normalized: ${schema}.${table}`,
        `→ stg_${domain} (dbt staging after normalization)`,
        `→ int_${domain} → fct_${domain}`,
      ].join('\n  ');
    case 'dlt':
      return [
        `dlt pipeline (embedded in Dagster/Airflow/standalone) → ${schema}.${table}`,
        `  System tables: _dlt_loads, _dlt_pipeline_state (check for failed loads)`,
        `→ stg_${domain} (dbt reads dlt output as source)`,
        `→ mart layer`,
      ].join('\n  ');
    case 'snowpipe':
      return [
        `Cloud storage (S3/GCS/Azure) → Snowpipe (auto-ingest) → ${schema}.${table}`,
        `  Check: COPY_HISTORY for failed files, PIPE_STATUS for queue backlog`,
        `→ Snowflake Stream (CDC, if enabled) → Task → downstream tables`,
      ].join('\n  ');
    case 'snowflake_stream':
      return [
        `Upstream table change → Snowflake Stream ${table} (CDC tracking)`,
        `  Check: SYSTEM$STREAM_HAS_DATA, stale_after timestamp`,
        `→ Task consumes stream → writes to downstream table`,
      ].join('\n  ');
    case 'snowflake_task':
      return [
        `Snowflake Task ${table} — scheduled SQL or stored procedure`,
        `  Check: TASK_HISTORY for SCHEDULED_TIME, ERROR_MESSAGE`,
        `  Upstream: stream, Snowpipe, or Fivetran sync that this task waits on`,
      ].join('\n  ');
    case 'dynamic_table':
      return [
        `Snowflake Dynamic Table ${table} — auto-refreshes from upstream`,
        `  Check: TARGET_LAG, DOWNSTREAM_LAG, refresh failure in QUERY_HISTORY`,
        `  Root cause: upstream table stopped updating (Fivetran stall? Snowpipe backlog?)`,
      ].join('\n  ');
    case 'dbt':
      if (table.toUpperCase().startsWith('STG_'))
        return `dbt staging model ${table} → int_${domain} → fct_${domain} (upstream: raw_${domain} or fivetran_${src}_connector)`;
      if (table.toUpperCase().startsWith('INT_'))
        return `dbt intermediate ${table} → fct_${domain} / mart_${domain} (upstream: stg_${domain})`;
      return `dbt mart ${table} → BI dashboards / Census / Hightouch (upstream: int_${domain} or stg_${domain})`;
    case 'databricks':
      return [
        `Databricks/Spark job writes to ${schema}.${table} (Delta Lake)`,
        `  Check: Databricks Jobs API for OOM / spot preemption / schema drift`,
        `  Unity Catalog lineage: ${schema}.${table} → downstream ML models / marts`,
      ].join('\n  ');
    default:
      return `${schema}.${table} — owner unclear; check QUERY_HISTORY for most recent write`;
  }
}

function tableRefToPipelineHints(schema: string, table: string, tool: ToolOwner): string[] {
  const domain = table.toLowerCase()
    .replace(/^(_dlt_|_airbyte_raw_|stg_|int_|fct_|dim_|mart_|raw_)/, '')
    .replace(/_(daily|hourly|weekly|v\d+)$/, '');
  const src = domain.split('_')[0];

  const base = [domain, `stg_${domain}`, `fct_${domain}`];
  if (tool === 'fivetran' || tool === 'airbyte' || tool === 'dlt' || tool === 'stitch') {
    return [...base, `${tool}_${src}_connector`, `${tool}_${domain}`, src].slice(0, 6);
  }
  if (tool === 'dbt' || tool === 'sqlmesh') {
    return [...base, `${table.toLowerCase()}`, `fivetran_${src}_connector`, `raw_${domain}`].slice(0, 6);
  }
  if (tool === 'snowflake_task' || tool === 'snowpipe' || tool === 'snowflake_stream') {
    return [...base, `${table.toLowerCase()}_task`, domain, schema.toLowerCase()].slice(0, 6);
  }
  return base.slice(0, 4);
}

function isSystemRef(database: string, schema: string, _table: string): boolean {
  const db = database.toUpperCase();
  const sc = schema.toUpperCase();
  if (db === 'SNOWFLAKE' && ['ACCOUNT_USAGE', 'INFORMATION_SCHEMA'].includes(sc)) return true;
  if (['INFORMATION_SCHEMA', 'PG_CATALOG', 'PG_TEMP'].includes(sc)) return true;
  return false;
}

export function extractTablesFromError(errorText: string): TableRef[] {
  const refs: TableRef[] = [];
  const seen = new Set<string>();

  // Pattern 1: Fully-qualified DB.SCHEMA.TABLE
  const fqPattern = /\b([A-Z][A-Z0-9_]{1,63})\.([A-Z][A-Z0-9_]{1,63})\.([A-Z][A-Z0-9_]{1,63})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = fqPattern.exec(errorText)) !== null) {
    const [raw, database, schema, table] = [m[0], m[1], m[2], m[3]];
    if (seen.has(raw.toUpperCase()) || isSystemRef(database, schema, table)) continue;
    seen.add(raw.toUpperCase());
    const layer = schemaToLayer(schema);
    const tool = schemaToTool(schema, table);
    refs.push({
      raw, database, schema, table, layer, tool,
      chainDescription: buildChainDescription(schema, table, tool),
      pipelineHints: tableRefToPipelineHints(schema, table, tool),
    });
  }

  // Pattern 2: dbt ref() / depends on
  const dbtRefPattern = /(?:ref\s*\(\s*['"]|depends on ['"]\w+\.)([a-z][a-z0-9_]+)['"]/gi;
  while ((m = dbtRefPattern.exec(errorText)) !== null) {
    const model = m[1];
    if (seen.has(`dbt::${model}`)) continue;
    seen.add(`dbt::${model}`);
    const layer = inferLayerFromName(model);
    refs.push({
      raw: model, database: 'dbt', schema: 'dbt_model', table: model,
      layer, tool: 'dbt',
      chainDescription: buildChainDescription('dbt', model.toUpperCase(), 'dbt'),
      pipelineHints: tableRefToPipelineHints('dbt', model.toUpperCase(), 'dbt'),
    });
  }

  // Pattern 3: "table/relation X does not exist" — unqualified names
  const unqualifiedPattern = /(?:table|relation|view|dataset)\s+['"`]?([a-z][a-z0-9_]{3,63})['"`]?\s+(?:does not exist|not found|doesn't exist)/gi;
  while ((m = unqualifiedPattern.exec(errorText)) !== null) {
    const tbl = m[1];
    if (seen.has(`unq::${tbl}`)) continue;
    seen.add(`unq::${tbl}`);
    const layer = inferLayerFromName(tbl);
    const tool: ToolOwner = layer === 'raw' ? 'fivetran' : layer !== 'unknown' ? 'dbt' : 'unknown';
    refs.push({
      raw: tbl, database: 'unknown', schema: 'unknown', table: tbl,
      layer, tool,
      chainDescription: buildChainDescription('unknown', tbl.toUpperCase(), tool),
      pipelineHints: tableRefToPipelineHints('unknown', tbl.toUpperCase(), tool),
    });
  }

  // Pattern 4: dlt system tables anywhere (e.g. "_dlt_loads", "_dlt_pipeline_state")
  if (errorText.includes('_dlt_')) {
    const dltPipePattern = /dlt\.pipeline\(['"]([^'"]+)['"]\)/g;
    while ((m = dltPipePattern.exec(errorText)) !== null) {
      const pipeName = m[1];
      if (seen.has(`dlt::${pipeName}`)) continue;
      seen.add(`dlt::${pipeName}`);
      refs.push({
        raw: pipeName, database: 'dlt', schema: 'pipeline', table: pipeName,
        layer: 'raw', tool: 'dlt',
        chainDescription: buildChainDescription('pipeline', pipeName.toUpperCase(), 'dlt'),
        pipelineHints: [pipeName, `${pipeName}_raw`, `stg_${pipeName.split('_')[0]}`],
      });
    }
  }

  return refs.slice(0, 12);
}

// Human-readable lineage text for the agent prompt
export function tableRefsToLineageText(refs: TableRef[], detectedTools?: ReturnType<typeof detectToolsFromLog>): string {
  const parts: string[] = [];

  if (detectedTools && detectedTools.length > 0) {
    parts.push('TOOL CHAIN DETECTED FROM LOG SIGNATURES:');
    parts.push(`  ${buildToolChain(detectedTools)}`);
    parts.push('');
    // Per-tool notes for tools that aren't the obvious primary
    const secondary = detectedTools.filter(t => !['dbt', 'dagster'].includes(t.tool));
    for (const t of secondary.slice(0, 4)) {
      parts.push(`  [${t.tool}] ${t.note}`);
    }
    parts.push('');
  }

  if (refs.length > 0) {
    parts.push('TABLES REFERENCED IN ERROR (lineage inferred from schema/naming patterns):');
    for (const ref of refs.slice(0, 6)) {
      parts.push(`\n  ${ref.raw} [${ref.layer}, owned by: ${ref.tool}]`);
      parts.push(`  ${ref.chainDescription}`);
      parts.push(`  Search runbooks for: ${ref.pipelineHints.slice(0, 3).join(', ')}`);
    }
  }

  return parts.join('\n') || 'No table references or tool signatures extracted from error text.';
}

// ---------------------------------------------------------------------------
// 1. NAMING CONVENTIONS
// ---------------------------------------------------------------------------

function inferLayerFromName(name: string): LineageNode['layer'] {
  const n = name.toLowerCase();
  if (n.startsWith('mart_') || n.startsWith('fct_') || n.startsWith('dim_')) return 'mart';
  if (n.startsWith('int_') || n.startsWith('intermediate_')) return 'intermediate';
  if (n.startsWith('stg_') || n.startsWith('staging_')) return 'staging';
  if (n.startsWith('raw_') || n.startsWith('src_') || n.startsWith('source_') || n.startsWith('_dlt_')) return 'raw';
  if (n.includes('fivetran') || n.includes('_connector') || n.includes('_sync')) return 'source';
  return 'unknown';
}

function inferToolFromName(name: string): ToolOwner {
  const n = name.toLowerCase();
  if (n.includes('fivetran') || n.includes('_connector')) return 'fivetran';
  if (n.includes('airbyte') || n.includes('_ab_')) return 'airbyte';
  if (n.includes('_dlt_') || n.startsWith('dlt_')) return 'dlt';
  if (n.includes('_task') || n.includes('_procedure') || n.includes('_proc')) return 'snowflake_task';
  if (n.includes('snowpipe') || n.includes('_pipe')) return 'snowpipe';
  if (n.includes('_stream')) return 'snowflake_stream';
  if (n.includes('dagster') || n.includes('_asset')) return 'dagster';
  if (n.includes('airflow') || n.includes('_dag')) return 'airflow';
  if (n.includes('prefect') || n.includes('_flow')) return 'prefect';
  if (n.includes('census') || n.includes('hightouch')) return 'census';
  const layer = inferLayerFromName(n);
  if (layer !== 'unknown' && layer !== 'source') return 'dbt';
  return 'unknown';
}

function inferUpstreamByNaming(name: string): string[] {
  const n = name.toLowerCase();
  const layer = inferLayerFromName(n);
  const domain = n
    .replace(/^(mart_|fct_|dim_|int_|intermediate_|stg_|staging_|raw_|src_|source_)/, '')
    .replace(/_(daily|hourly|weekly|v\d+)$/, '');
  const src = domain.split('_')[0];

  if (layer === 'mart') return [`int_${domain}`, `stg_${domain}`, `dim_${src}`].filter(u => u !== name);
  if (layer === 'intermediate') return [`stg_${domain}`];
  if (layer === 'staging') return [`raw_${domain}`, `fivetran_${src}_connector`, `dlt_${src}_pipeline`];
  if (layer === 'raw') return [`fivetran_${src}_connector`, `dlt_${src}_pipeline`, `airbyte_${src}_connection`];
  return [];
}

function inferDownstreamByNaming(name: string): string[] {
  const n = name.toLowerCase();
  const layer = inferLayerFromName(n);
  const domain = n
    .replace(/^(mart_|fct_|dim_|int_|intermediate_|stg_|staging_|raw_|src_|source_)/, '')
    .replace(/_(daily|hourly|weekly|v\d+)$/, '');

  if (layer === 'source' || n.includes('fivetran') || n.includes('airbyte') || n.includes('dlt')) {
    return [`raw_${domain}`, `stg_${domain}`];
  }
  if (layer === 'raw') return [`stg_${domain}`];
  if (layer === 'staging') return [`int_${domain}`, `mart_${domain}`, `fct_${domain}`];
  if (layer === 'intermediate') return [`mart_${domain}`, `fct_${domain}`];
  if (layer === 'mart') return [`census_${domain}_sync`, `hightouch_${domain}_sync`]; // reverse ETL consumers
  return [];
}

// ---------------------------------------------------------------------------
// 2. CO-FAILURE PATTERNS
// ---------------------------------------------------------------------------
async function findCoFailures(assetName: string, windowHours = 1): Promise<{ upstream: string[]; downstream: string[] }> {
  try {
    const rows = await sql`
      SELECT DISTINCT i2.pipeline_name, i2.failed_at
      FROM incidents i1
      JOIN incidents i2
        ON ABS(EXTRACT(EPOCH FROM (i2.failed_at - i1.failed_at))) < ${windowHours * 3600}
        AND i1.id != i2.id
        AND i2.pipeline_name != i1.pipeline_name
      WHERE i1.pipeline_name ILIKE ${'%' + assetName + '%'}
        AND i1.failed_at > NOW() - INTERVAL '30 days'
      LIMIT 20
    ` as { pipeline_name: string; failed_at: Date }[];

    const upstream: string[] = [];
    const downstream: string[] = [];
    for (const row of rows) {
      const layer = inferLayerFromName(row.pipeline_name);
      const tool = inferToolFromName(row.pipeline_name);
      if (['source', 'raw'].includes(layer) || ['fivetran', 'airbyte', 'dlt', 'snowpipe'].includes(tool)) {
        upstream.push(row.pipeline_name);
      } else if (layer === 'mart' || ['census', 'hightouch'].includes(tool)) {
        downstream.push(row.pipeline_name);
      } else {
        upstream.push(row.pipeline_name);
      }
    }
    return { upstream: [...new Set(upstream)], downstream: [...new Set(downstream)] };
  } catch {
    return { upstream: [], downstream: [] };
  }
}

// ---------------------------------------------------------------------------
// 3. RUNBOOK CROSS-REFERENCES
// ---------------------------------------------------------------------------
async function findRunbookMentions(assetName: string): Promise<{ upstreamMentions: string[]; downstreamMentions: string[] }> {
  try {
    const mentionsThisAsset = (await sql`
      SELECT pipeline_name, title FROM runbooks
      WHERE content ILIKE ${'%' + assetName + '%'}
        AND pipeline_name NOT ILIKE ${'%' + assetName + '%'}
      LIMIT 10
    `) as { pipeline_name: string; title: string }[];

    const thisAssetRunbooks = (await sql`
      SELECT content FROM runbooks
      WHERE pipeline_name ILIKE ${'%' + assetName + '%'}
      LIMIT 5
    `) as { content: string }[];

    const upstreamMentions: string[] = [];
    // Broader pattern — includes dlt, airbyte, sqlmesh, snowpipe, etc.
    const pipelineNamePattern = /\b(mart_|int_|stg_|raw_|fct_|dim_|fivetran_|airbyte_|dlt_|snowpipe_|_stream|_task)\w+\b/gi;
    for (const rb of thisAssetRunbooks) {
      const matches = rb.content.match(pipelineNamePattern) ?? [];
      upstreamMentions.push(...matches.filter((m: string) => m.toLowerCase() !== assetName.toLowerCase()));
    }

    return {
      upstreamMentions: [...new Set(upstreamMentions)].slice(0, 6),
      downstreamMentions: mentionsThisAsset.map(r => r.pipeline_name).slice(0, 5),
    };
  } catch {
    return { upstreamMentions: [], downstreamMentions: [] };
  }
}

// ---------------------------------------------------------------------------
// ORCHESTRATOR DEPENDENCY INFERENCE
//
// Airflow, Prefect, and GitHub Actions don't declare lineage — but the
// dependencies are encoded in the code and naming. We extract them from:
//
// CODE SIGNALS (read from GitHub when repo is connected):
//   Airflow:  ExternalTaskSensor(external_dag_id=...)  — explicit upstream
//             TriggerDagRunOperator(trigger_dag_id=...)  — downstream trigger
//             FileSensor / S3KeySensor shared paths    — implicit shared data
//             on_failure_callback / SLAs              — dependency timing hints
//   Prefect:  run_deployment('flow/deployment', wait_for_completion=True)
//             Shared block references (same S3Block, SnowflakeConnector)
//             Flow-of-flows: @flow calling other @flow decorated functions
//   GitHub Actions: on.workflow_run.workflows: ['upstream-workflow']
//             needs: [job1, job2]                      — job-level deps
//             Shared artifact upload-artifact/download-artifact names
//
// NAMING SIGNALS (always available, no GitHub needed):
//   Numeric prefixes:   01_ingest → 02_transform → 03_load
//   Stage keywords:     ingest/extract < transform/clean/dbt < load/mart/export
//   Shared domain word: daily_ingest_orders + daily_transform_orders → same domain
//   Schedule times:     earlier cron = likely upstream (heuristic only)
//
// CO-FAILURE TIMING:
//   If DAG A consistently fails before DAG B, A is upstream regardless of naming.
// ---------------------------------------------------------------------------

// Stage weight — lower number = earlier in the pipeline
const STAGE_WEIGHTS: Record<string, number> = {
  // Ingestion stage
  extract: 1, ingest: 1, fetch: 1, pull: 1, import: 1, sync: 1, load_raw: 1, raw: 1,
  // Validation / quality
  validate: 2, check: 2, quality: 2, test: 2,
  // Transformation
  transform: 3, clean: 3, normalize: 3, enrich: 3, dbt: 3, model: 3, build: 3,
  // Materialization / aggregation
  aggregate: 4, mart: 4, materialize: 4, publish: 4, snapshot: 4,
  // Export / downstream delivery
  export: 5, deliver: 5, push: 5, notify: 5, report: 5, sync_crm: 5, reverse_etl: 5,
};

export interface OrchestratorDep {
  upstreamDag: string;
  downstreamDag: string;
  confidence: 'explicit' | 'naming' | 'timing';
  signal: string;  // human-readable reason
}

// Infer dependencies between a failing DAG/workflow and its likely neighbors
// using naming conventions alone. No GitHub access needed.
export function inferOrchestratorDeps(
  dagName: string,
  allKnownDags?: string[]   // pass if available — enables cross-DAG domain matching
): { upstream: OrchestratorDep[]; downstream: OrchestratorDep[] } {
  const name = dagName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const upstream: OrchestratorDep[] = [];
  const downstream: OrchestratorDep[] = [];

  // --- Numeric prefix ordering: 02_transform depends on 01_ingest ---
  const numericMatch = name.match(/^(\d+)[_\-](.+)/);
  if (numericMatch) {
    const seq = parseInt(numericMatch[1], 10);
    const base = numericMatch[2];
    if (seq > 1) {
      upstream.push({
        upstreamDag: `${String(seq - 1).padStart(2, '0')}_${base}`,
        downstreamDag: dagName,
        confidence: 'naming',
        signal: `Numeric prefix ${seq} → likely depends on ${seq - 1}_* in the same sequence`,
      });
    }
    downstream.push({
      upstreamDag: dagName,
      downstreamDag: `${String(seq + 1).padStart(2, '0')}_${base}`,
      confidence: 'naming',
      signal: `Numeric prefix ${seq} → likely triggers ${seq + 1}_* next`,
    });
  }

  // --- Stage keyword ordering ---
  // Find the stage weight of this DAG name
  const stageWord = Object.keys(STAGE_WEIGHTS).find(kw => name.includes(kw));
  const stageWeight = stageWord ? STAGE_WEIGHTS[stageWord] : null;

  // Extract the domain (e.g. "orders" from "daily_transform_orders")
  const domainMatch = name
    .replace(/^(daily_|hourly_|weekly_|nightly_|morning_|01_|02_|03_|04_|05_)/, '')
    .replace(/(_(daily|hourly|weekly|nightly|v\d+|prod|staging|test))$/, '');

  if (stageWeight !== null && stageWeight > 1) {
    // Find the stage one level below
    const prevStageWord = Object.entries(STAGE_WEIGHTS)
      .filter(([, w]) => w === stageWeight - 1)
      .map(([k]) => k)[0];
    if (prevStageWord) {
      const prevDag = domainMatch.replace(stageWord!, prevStageWord);
      if (prevDag !== name) {
        upstream.push({
          upstreamDag: prevDag,
          downstreamDag: dagName,
          confidence: 'naming',
          signal: `Stage keyword '${stageWord}' (weight ${stageWeight}) → likely preceded by '${prevStageWord}' stage`,
        });
      }
    }
  }
  if (stageWeight !== null) {
    const nextStageWord = Object.entries(STAGE_WEIGHTS)
      .filter(([, w]) => w === stageWeight + 1)
      .map(([k]) => k)[0];
    if (nextStageWord && stageWord) {
      const nextDag = domainMatch.replace(stageWord, nextStageWord);
      if (nextDag !== name) {
        downstream.push({
          upstreamDag: dagName,
          downstreamDag: nextDag,
          confidence: 'naming',
          signal: `Stage keyword '${stageWord}' → next stage likely '${nextStageWord}'`,
        });
      }
    }
  }

  // --- Cross-DAG domain matching (if we have the full list) ---
  if (allKnownDags && allKnownDags.length > 0) {
    const domain = name
      .replace(/^(daily_|hourly_|weekly_|\d+_)/, '')
      .replace(/(extract|ingest|transform|clean|dbt|load|export|mart)_?/g, '')
      .replace(/_(prod|staging|test|v\d+)$/, '')
      .trim();

    if (domain.length > 3) {
      // Other DAGs sharing the same domain keyword
      const siblings = allKnownDags.filter(d =>
        d !== dagName &&
        d.toLowerCase().includes(domain) &&
        d.toLowerCase() !== name
      );

      for (const sib of siblings.slice(0, 4)) {
        const sibStage = Object.keys(STAGE_WEIGHTS).find(kw => sib.toLowerCase().includes(kw));
        const sibWeight = sibStage ? STAGE_WEIGHTS[sibStage] : null;
        if (sibWeight !== null && stageWeight !== null) {
          if (sibWeight < stageWeight) {
            upstream.push({
              upstreamDag: sib,
              downstreamDag: dagName,
              confidence: 'naming',
              signal: `Shared domain '${domain}' + earlier stage keyword '${sibStage}' → inferred upstream`,
            });
          } else if (sibWeight > stageWeight) {
            downstream.push({
              upstreamDag: dagName,
              downstreamDag: sib,
              confidence: 'naming',
              signal: `Shared domain '${domain}' + later stage keyword '${sibStage}' → inferred downstream`,
            });
          }
        }
      }
    }
  }

  return { upstream, downstream };
}

// Detect explicit dependency declarations in code pulled from GitHub or logs
export function extractExplicitOrchestratorDeps(codeOrLogText: string, dagName?: string): OrchestratorDep[] {
  const deps: OrchestratorDep[] = [];
  const self = dagName ?? 'current';

  // --- Airflow: ExternalTaskSensor ---
  const etSensorPattern = /ExternalTaskSensor\s*\([^)]*external_dag_id\s*=\s*['"]([^'"]+)['"]/gi;
  let m: RegExpExecArray | null;
  while ((m = etSensorPattern.exec(codeOrLogText)) !== null) {
    deps.push({
      upstreamDag: m[1],
      downstreamDag: self,
      confidence: 'explicit',
      signal: `ExternalTaskSensor(external_dag_id='${m[1]}') — waits for upstream DAG to complete`,
    });
  }

  // --- Airflow: TriggerDagRunOperator ---
  const triggerPattern = /TriggerDagRunOperator\s*\([^)]*trigger_dag_id\s*=\s*['"]([^'"]+)['"]/gi;
  while ((m = triggerPattern.exec(codeOrLogText)) !== null) {
    deps.push({
      upstreamDag: self,
      downstreamDag: m[1],
      confidence: 'explicit',
      signal: `TriggerDagRunOperator(trigger_dag_id='${m[1]}') — explicitly triggers downstream DAG`,
    });
  }

  // --- Airflow: FileSensor / S3KeySensor shared path ---
  const sensorPathPattern = /(?:FileSensor|S3KeySensor|GCSObjectSensor)\s*\([^)]*(?:filepath|bucket_key|object)\s*=\s*['"]([^'"]+)['"]/gi;
  while ((m = sensorPathPattern.exec(codeOrLogText)) !== null) {
    deps.push({
      upstreamDag: `(writer of ${m[1]})`,
      downstreamDag: self,
      confidence: 'naming',
      signal: `Sensor waiting on path/key '${m[1]}' — another DAG writes this file`,
    });
  }

  // --- Airflow 2.4+ Datasets / Airflow 3.x Assets ---
  // @task(outlets=[Dataset('s3://bucket/path')]) — this task WRITES a dataset
  // @dag(schedule=[Dataset('s3://bucket/path')]) — this DAG READS a dataset (triggered when updated)
  // schedule_on=[Asset(...)] — Airflow 3.x alias
  const datasetOutletPattern = /@task\s*\([^)]*outlets\s*=\s*\[Dataset\s*\(\s*['"]([^'"]+)['"]\s*\)/gi;
  while ((m = datasetOutletPattern.exec(codeOrLogText)) !== null) {
    deps.push({
      upstreamDag: self,
      downstreamDag: `(DAGs scheduled on Dataset('${m[1]}'))`,
      confidence: 'explicit',
      signal: `@task(outlets=[Dataset('${m[1]}')]) — this task marks dataset as updated, triggering downstream DAGs`,
    });
  }

  const datasetSchedulePattern = /@dag\s*\([^)]*schedule\s*=\s*\[(?:Dataset|Asset)\s*\(\s*['"]([^'"]+)['"]\s*\)/gi;
  while ((m = datasetSchedulePattern.exec(codeOrLogText)) !== null) {
    deps.push({
      upstreamDag: `(task that writes Dataset('${m[1]}'))`,
      downstreamDag: self,
      confidence: 'explicit',
      signal: `@dag(schedule=[Dataset('${m[1]}')]) — triggers when upstream task updates this dataset`,
    });
  }

  // Airflow 3.x @asset decorator — defines an asset-producing task
  const assetDecoratorPattern = /@asset\s*\(\s*(?:uri\s*=\s*)?['"]([^'"]+)['"]/gi;
  while ((m = assetDecoratorPattern.exec(codeOrLogText)) !== null) {
    deps.push({
      upstreamDag: self,
      downstreamDag: `(consumers of asset '${m[1]}')`,
      confidence: 'explicit',
      signal: `Airflow 3.x @asset('${m[1]}') — declares this task as an asset producer`,
    });
  }

  // Inline Dataset() in schedule (non-decorator form)
  const inlineDatasetPattern = /schedule\s*=\s*\[?Dataset\s*\(\s*['"]([^'"]+)['"]\s*\)\]?/gi;
  while ((m = inlineDatasetPattern.exec(codeOrLogText)) !== null) {
    deps.push({
      upstreamDag: `(producer of '${m[1]}')`,
      downstreamDag: self,
      confidence: 'explicit',
      signal: `schedule=[Dataset('${m[1]}')] — this DAG runs when the dataset is updated by an upstream task`,
    });
  }

  // --- Prefect: run_deployment ---
  const prefectRunPattern = /run_deployment\s*\(\s*['"]([^'"]+)['"]/gi;
  while ((m = prefectRunPattern.exec(codeOrLogText)) !== null) {
    deps.push({
      upstreamDag: self,
      downstreamDag: m[1],
      confidence: 'explicit',
      signal: `run_deployment('${m[1]}') — Prefect flow triggers downstream deployment`,
    });
  }

  // --- Prefect: Shared block names (implicit shared data) ---
  const prefectBlockPattern = /(?:SnowflakeConnector|S3Bucket|GCSBucket|AzureBlobStorageCredentials)\.load\s*\(\s*['"]([^'"]+)['"]\)/gi;
  while ((m = prefectBlockPattern.exec(codeOrLogText)) !== null) {
    deps.push({
      upstreamDag: `(other flows using block '${m[1]}')`,
      downstreamDag: self,
      confidence: 'naming',
      signal: `Shared Prefect block '${m[1]}' — multiple flows access same data resource`,
    });
  }

  // --- GitHub Actions: workflow_run trigger ---
  const workflowRunPattern = /workflow_run:\s*\n\s*workflows:\s*\[?\s*['"]([^'"]+)['"]/gi;
  while ((m = workflowRunPattern.exec(codeOrLogText)) !== null) {
    deps.push({
      upstreamDag: m[1],
      downstreamDag: self,
      confidence: 'explicit',
      signal: `GitHub Actions on.workflow_run — explicitly waits for '${m[1]}' workflow to complete`,
    });
  }

  // --- GitHub Actions: upload-artifact / download-artifact with shared name ---
  const artifactPattern = /(?:actions\/download-artifact|download-artifact)\s*.*?name:\s*([^\n]+)/gi;
  while ((m = artifactPattern.exec(codeOrLogText)) !== null) {
    const artifactName = m[1].trim().replace(/['"]/g, '');
    deps.push({
      upstreamDag: `(workflow uploading artifact '${artifactName}')`,
      downstreamDag: self,
      confidence: 'naming',
      signal: `Artifact download '${artifactName}' — another workflow must upload this first`,
    });
  }

  // --- GitHub Actions: needs: [...] ---
  const needsPattern = /needs:\s*\[([^\]]+)\]/gi;
  while ((m = needsPattern.exec(codeOrLogText)) !== null) {
    const deps_list = m[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
    for (const dep of deps_list) {
      deps.push({
        upstreamDag: dep,
        downstreamDag: self,
        confidence: 'explicit',
        signal: `GitHub Actions job 'needs: ${dep}' — explicit job dependency`,
      });
    }
  }

  return deps;
}

// Human-readable text for orchestrator deps to inject into the agent prompt
export function orchestratorDepsToPromptText(
  dagName: string,
  deps: { upstream: OrchestratorDep[]; downstream: OrchestratorDep[] },
  explicitDeps?: OrchestratorDep[]
): string {
  const parts: string[] = [`ORCHESTRATOR DEPENDENCY INFERENCE for '${dagName}':`];
  parts.push('(Airflow/Prefect/GitHub Actions have no built-in lineage — inferred from naming + code signals)\n');

  if (explicitDeps && explicitDeps.length > 0) {
    parts.push('EXPLICIT DEPENDENCIES (from code):');
    for (const d of explicitDeps) {
      const arrow = d.upstreamDag === dagName
        ? `  ${dagName} → triggers → ${d.downstreamDag}`
        : `  ${d.upstreamDag} → blocks → ${dagName}`;
      parts.push(`${arrow}\n  Reason: ${d.signal}`);
    }
    parts.push('');
  }

  if (deps.upstream.length > 0) {
    parts.push('INFERRED UPSTREAM (likely predecessors):');
    for (const d of deps.upstream) {
      parts.push(`  ← ${d.upstreamDag} [${d.confidence}] — ${d.signal}`);
    }
    parts.push('');
  }

  if (deps.downstream.length > 0) {
    parts.push('INFERRED DOWNSTREAM (what breaks next):');
    for (const d of deps.downstream) {
      parts.push(`  → ${d.downstreamDag} [${d.confidence}] — ${d.signal}`);
    }
    parts.push('');
  }

  if (deps.upstream.length === 0 && deps.downstream.length === 0 && (!explicitDeps || explicitDeps.length === 0)) {
    parts.push('  Could not infer neighbors — try connecting GitHub to read DAG/workflow files for ExternalTaskSensor, TriggerDagRunOperator, workflow_run triggers, and run_deployment() calls.');
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function inferLineage(assetName: string): Promise<InferredLineage> {
  const [coFailures, runbookMentions] = await Promise.all([
    findCoFailures(assetName),
    findRunbookMentions(assetName),
  ]);

  const namingUpstream = inferUpstreamByNaming(assetName);
  const namingDownstream = inferDownstreamByNaming(assetName);

  const allUpstream = [...new Set([
    ...namingUpstream,
    ...coFailures.upstream,
    ...runbookMentions.upstreamMentions,
  ])].filter(u => u !== assetName).slice(0, 10);

  const allDownstream = [...new Set([
    ...namingDownstream,
    ...coFailures.downstream,
    ...runbookMentions.downstreamMentions,
  ])].filter(d => d !== assetName).slice(0, 10);

  const upstreamNodes: LineageNode[] = allUpstream.map(id => ({
    id,
    type: inferToolFromName(id) === 'dbt' ? 'dbt_model' : 'unknown',
    layer: inferLayerFromName(id),
    tool: inferToolFromName(id),
    upstreamIds: inferUpstreamByNaming(id),
    downstreamIds: [assetName],
    inferenceMethod: [
      ...(namingUpstream.includes(id) ? ['naming' as const] : []),
      ...(coFailures.upstream.includes(id) ? ['co_failure' as const] : []),
      ...(runbookMentions.upstreamMentions.includes(id) ? ['runbook_mention' as const] : []),
    ],
  }));

  const downstreamNodes: LineageNode[] = allDownstream.map(id => ({
    id,
    type: inferToolFromName(id) === 'census' || inferToolFromName(id) === 'hightouch' ? 'reverse_etl' : 'unknown',
    layer: inferLayerFromName(id),
    tool: inferToolFromName(id),
    upstreamIds: [assetName],
    downstreamIds: inferDownstreamByNaming(id),
    inferenceMethod: [
      ...(namingDownstream.includes(id) ? ['naming' as const] : []),
      ...(coFailures.downstream.includes(id) ? ['co_failure' as const] : []),
      ...(runbookMentions.downstreamMentions.includes(id) ? ['runbook_mention' as const] : []),
    ],
  }));

  const multiSignal = upstreamNodes.filter(n => n.inferenceMethod.length > 1).length;
  const confidence: 'high' | 'medium' | 'low' =
    multiSignal > 1 ? 'high' : allUpstream.length > 0 ? 'medium' : 'low';

  const methodsUsed = [
    'naming conventions',
    coFailures.upstream.length > 0 ? 'co-failure history' : null,
    runbookMentions.upstreamMentions.length > 0 ? 'runbook cross-references' : null,
  ].filter(Boolean).join(', ');

  return {
    focusNode: assetName,
    upstreamNodes,
    downstreamNodes,
    confidence,
    confidenceNote: `Inferred from ${methodsUsed}. Covers dbt/SQLMesh/dlt/Fivetran/Airbyte/Snowflake-native without OpenLineage.`,
  };
}

export function lineageToPromptText(lineage: InferredLineage): string {
  if (lineage.upstreamNodes.length === 0 && lineage.downstreamNodes.length === 0) {
    return 'Lineage: could not infer upstream/downstream dependencies for this pipeline.';
  }

  const upstreamStr = lineage.upstreamNodes.length > 0
    ? lineage.upstreamNodes
        .map(n => `  ← ${n.id} [${n.layer}, ${n.tool}] (via ${n.inferenceMethod.join('+')})`)
        .join('\n')
    : '  ← (no upstream inferred)';

  const downstreamStr = lineage.downstreamNodes.length > 0
    ? lineage.downstreamNodes
        .map(n => `  → ${n.id} [${n.layer}, ${n.tool}] (will be blocked if this isn't fixed)`)
        .join('\n')
    : '  → (no downstream inferred)';

  return `INFERRED LINEAGE (confidence: ${lineage.confidence}):
UPSTREAM (what this depends on):
${upstreamStr}

DOWNSTREAM (what breaks next if this isn't fixed):
${downstreamStr}

${lineage.confidenceNote}`;
}
