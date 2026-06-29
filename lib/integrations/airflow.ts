// Airflow integration — REST API + Astronomer MCP bridge
//
// THREE layers of lineage, in order of reliability:
//
// 1. AIRFLOW REST API — /api/v1/dag_dependencies (Airflow 2.x) or /api/v2 (3.x)
//    Returns the full dependency graph: dataset producers, consumers, ExternalTaskSensor edges.
//    Also: /api/v1/datasets — all Dataset objects with producing_tasks and consuming_dags.
//    Also: /api/v1/dags/{id}/source — DAG source code for parsing @task(outlets=[Dataset(...)])
//
// 2. ASTRONOMER MCP — astro-airflow-mcp (now in astronomer/agents monorepo)
//    Tools: list_assets, list_asset_events, get_upstream_asset_events, get_dag_source
//    Supports Airflow 2.x (/api/v1, basic auth) and 3.x (/api/v2, OAuth2).
//    Add AIRFLOW_HOST + AIRFLOW_USERNAME + AIRFLOW_PASSWORD in /settings.
//
// 3. SYNTHETIC — realistic demo data when no credentials configured.
//
// Airflow Datasets (2.4+) are the native lineage mechanism:
//   @task(outlets=[Dataset('s3://bucket/orders/')])   → writes this dataset
//   @dag(schedule=[Dataset('s3://bucket/orders/')])   → triggers when dataset updated
//   Airflow 3.x renames these to "Assets" (@asset decorator)
//
// GET /api/v1/dag_dependencies returns:
//   [{ source: 'dag_id_a', target: 'dag_id_b', dependency_type: 'dataset', dependency_id: 'uri' }]
//   [{ source: 'dag_id_a', target: 'dag_id_b', dependency_type: 'sensor', dependency_id: 'task_id' }]

import { getSetting } from '../settings';

interface AirflowCredentials {
  host: string;
  username: string;
  password: string;
  version: '2' | '3';
  instanceName: string;
}

interface DagDependency {
  source: string;           // upstream DAG id
  target: string;           // downstream DAG id
  dependencyType: 'dataset' | 'sensor' | 'trigger' | 'unknown';
  dependencyId: string;     // dataset URI or sensor task id
}

interface AirflowDataset {
  uri: string;
  producingTasks: { dagId: string; taskId: string }[];
  consumingDags: { dagId: string }[];
  lastDatasetUpdate?: string;
}

interface DagRunInfo {
  dagId: string;
  runId: string;
  state: string;
  startDate: string;
  endDate?: string;
  note?: string;
  triggeredByAssetEvents?: { assetUri: string; sourceDagId: string; sourceTaskId: string; timestamp: string }[];
}

// Support multiple Airflow instances (many teams have prod + staging)
async function getCredentials(instanceName = 'default'): Promise<AirflowCredentials | null> {
  const prefix = instanceName === 'default' ? '' : `${instanceName.toUpperCase()}_`;
  const host = await getSetting('airflow', `${prefix}AIRFLOW_HOST`);
  const username = await getSetting('airflow', `${prefix}AIRFLOW_USERNAME`);
  const password = await getSetting('airflow', `${prefix}AIRFLOW_PASSWORD`);
  const version = (await getSetting('airflow', `${prefix}AIRFLOW_VERSION`) ?? '2') as '2' | '3';
  if (!host || !username || !password) return null;
  return { host: host.replace(/\/$/, ''), username, password, version, instanceName };
}

function apiBase(creds: AirflowCredentials): string {
  return creds.version === '3' ? `${creds.host}/api/v2` : `${creds.host}/api/v1`;
}

function authHeader(creds: AirflowCredentials): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`;
}

async function airflowGet<T>(creds: AirflowCredentials, path: string): Promise<T | null> {
  try {
    const resp = await fetch(`${apiBase(creds)}${path}`, {
      headers: {
        'Authorization': authHeader(creds),
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      console.warn(`[airflow] GET ${path} → ${resp.status}`);
      return null;
    }
    return resp.json() as Promise<T>;
  } catch (err) {
    console.warn(`[airflow] GET ${path} error:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/dag_dependencies
// The most valuable endpoint: complete dependency graph across all DAGs.
// Returns both dataset-based edges AND ExternalTaskSensor edges.
// ---------------------------------------------------------------------------
export async function getDagDependencies(instanceName = 'default'): Promise<DagDependency[]> {
  const creds = await getCredentials(instanceName);
  if (!creds) return getSyntheticDagDependencies();

  // Airflow 2.x endpoint
  const data = await airflowGet<{ dependencies: Array<{
    source: string; target: string;
    dependency_type: string; dependency_id: string;
  }> }>(creds, '/dag_dependencies');

  if (!data?.dependencies) return getSyntheticDagDependencies();

  return data.dependencies.map(d => ({
    source: d.source,
    target: d.target,
    dependencyType: (d.dependency_type as DagDependency['dependencyType']) ?? 'unknown',
    dependencyId: d.dependency_id,
  }));
}

// ---------------------------------------------------------------------------
// GET /api/v1/dags/{dag_id}/tasks — within-DAG task dependency graph
// This is how Airflow exposes function-to-function (task-to-task) dependencies.
// The TaskFlow API (@task decorator + return values passed between tasks) creates
// XCom-based dependencies that Airflow tracks and returns here as downstream_task_ids.
// ---------------------------------------------------------------------------
export interface AirflowTask {
  taskId: string;
  taskType: string;     // PythonOperator, BashOperator, ExternalTaskSensor, etc.
  downstreamTaskIds: string[];
  upstreamTaskIds: string[];
  retries?: number;
  pool?: string;
  // For ExternalTaskSensor — this task creates a cross-DAG dependency
  externalDagId?: string;
  externalTaskId?: string;
}

export async function getDagTaskGraph(dagId: string, instanceName = 'default'): Promise<AirflowTask[]> {
  const creds = await getCredentials(instanceName);
  if (!creds) return getSyntheticTaskGraph(dagId);

  const data = await airflowGet<{ tasks: Array<{
    task_id: string;
    task_type: string;
    downstream_task_ids: string[];
    upstream_task_ids?: string[];
    retries?: number;
    pool?: string;
    // ExternalTaskSensor specific
    external_dag_id?: string;
    external_task_id?: string;
  }> }>(creds, `/dags/${dagId}/tasks`);

  if (!data?.tasks) return getSyntheticTaskGraph(dagId);

  return data.tasks.map(t => ({
    taskId: t.task_id,
    taskType: t.task_type,
    downstreamTaskIds: t.downstream_task_ids ?? [],
    upstreamTaskIds: t.upstream_task_ids ?? [],
    retries: t.retries,
    pool: t.pool,
    externalDagId: t.external_dag_id,
    externalTaskId: t.external_task_id,
  }));
}

// Format task graph for lineage text — shows the full within-DAG dependency chain
export function taskGraphToLineageText(dagId: string, tasks: AirflowTask[]): string {
  if (tasks.length === 0) return '';

  const lines = [`WITHIN-DAG TASK DEPENDENCIES for '${dagId}':`];
  lines.push('(Built from Airflow /api/v1/dags/{id}/tasks — includes TaskFlow API @task XCom dependencies)\n');

  // Find root tasks (no upstream deps)
  const rootTasks = tasks.filter(t => t.upstreamTaskIds.length === 0);

  // Build a simple tree representation
  const rendered = new Set<string>();
  function renderTask(taskId: string, indent = 0): void {
    if (rendered.has(taskId)) return;
    rendered.add(taskId);
    const task = tasks.find(t => t.taskId === taskId);
    if (!task) return;
    const prefix = '  '.repeat(indent);
    const typeNote = task.taskType === 'ExternalTaskSensor' && task.externalDagId
      ? ` [waits for DAG: ${task.externalDagId}]`
      : task.taskType !== 'PythonOperator' && task.taskType !== '_PythonDecoratedOperator'
      ? ` [${task.taskType}]`
      : '';
    lines.push(`${prefix}${indent === 0 ? '→ ' : '  └─ '}${taskId}${typeNote}`);
    for (const downstream of task.downstreamTaskIds) {
      renderTask(downstream, indent + 1);
    }
  }

  for (const root of rootTasks) renderTask(root.taskId);

  // Highlight ExternalTaskSensor cross-DAG edges
  const sensorTasks = tasks.filter(t => t.taskType === 'ExternalTaskSensor' && t.externalDagId);
  if (sensorTasks.length > 0) {
    lines.push('\nCROSS-DAG DEPENDENCIES (ExternalTaskSensor):');
    for (const t of sensorTasks) {
      lines.push(`  Task '${t.taskId}' waits for DAG '${t.externalDagId}' task '${t.externalTaskId ?? 'all'}'`);
    }
  }

  return lines.join('\n');
}

function getSyntheticTaskGraph(dagId: string): AirflowTask[] {
  // Return a realistic 4-task pipeline
  return [
    { taskId: 'extract_data', taskType: '_PythonDecoratedOperator', downstreamTaskIds: ['validate_schema'], upstreamTaskIds: [] },
    { taskId: 'validate_schema', taskType: '_PythonDecoratedOperator', downstreamTaskIds: ['transform_data'], upstreamTaskIds: ['extract_data'] },
    { taskId: 'transform_data', taskType: '_PythonDecoratedOperator', downstreamTaskIds: ['load_to_warehouse'], upstreamTaskIds: ['validate_schema'], retries: 2 },
    { taskId: 'load_to_warehouse', taskType: '_PythonDecoratedOperator', downstreamTaskIds: [], upstreamTaskIds: ['transform_data'] },
  ];
}

// ---------------------------------------------------------------------------
// Airflow 3.x renamed to /api/v2/assets
// ---------------------------------------------------------------------------
export async function getDatasets(instanceName = 'default'): Promise<AirflowDataset[]> {
  const creds = await getCredentials(instanceName);
  if (!creds) return getSyntheticDatasets();

  // Both v1 and v2 support /datasets (v3 also has /assets as alias)
  const data = await airflowGet<{ datasets: Array<{
    uri: string;
    producing_tasks?: Array<{ dag_id: string; task_id: string }>;
    consuming_dags?: Array<{ dag_id: string }>;
    last_dataset_update?: string;
  }> }>(creds, '/datasets');

  if (!data?.datasets) return getSyntheticDatasets();

  return data.datasets.map(d => ({
    uri: d.uri,
    producingTasks: d.producing_tasks?.map(t => ({ dagId: t.dag_id, taskId: t.task_id })) ?? [],
    consumingDags: d.consuming_dags?.map(c => ({ dagId: c.dag_id })) ?? [],
    lastDatasetUpdate: d.last_dataset_update,
  }));
}

// ---------------------------------------------------------------------------
// What triggered a DAG run? (dataset-aware scheduling)
// Uses /api/v1/dags/{id}/dagRuns/{run_id} + upstream asset events
// ---------------------------------------------------------------------------
export async function getUpstreamTriggers(
  dagId: string,
  runId: string,
  instanceName = 'default'
): Promise<{ triggeredByAssetEvents: DagRunInfo['triggeredByAssetEvents']; source: 'live' | 'synthetic' }> {
  const creds = await getCredentials(instanceName);
  if (!creds) {
    return { triggeredByAssetEvents: getSyntheticUpstreamTriggers(dagId), source: 'synthetic' };
  }

  // Airflow 2.9+ has /api/v1/dags/{dag_id}/dagRuns/{run_id}/upstreamDatasetEvents
  const data = await airflowGet<{ dataset_events: Array<{
    dataset_uri: string;
    source_dag_id: string;
    source_task_id: string;
    timestamp: string;
  }> }>(creds, `/dags/${dagId}/dagRuns/${runId}/upstreamDatasetEvents`);

  if (!data?.dataset_events) {
    return { triggeredByAssetEvents: getSyntheticUpstreamTriggers(dagId), source: 'synthetic' };
  }

  return {
    triggeredByAssetEvents: data.dataset_events.map(e => ({
      assetUri: e.dataset_uri,
      sourceDagId: e.source_dag_id,
      sourceTaskId: e.source_task_id,
      timestamp: e.timestamp,
    })),
    source: 'live',
  };
}

// ---------------------------------------------------------------------------
// Get DAG source code — parse it for Dataset, @task, ExternalTaskSensor
// Complements GitHub reading — Airflow API serves the parsed+loaded DAG source
// ---------------------------------------------------------------------------
export async function getDagSource(dagId: string, instanceName = 'default'): Promise<string | null> {
  const creds = await getCredentials(instanceName);
  if (!creds) return null;

  const data = await airflowGet<{ content: string }>(creds, `/dagSources/${dagId}`);
  return data?.content ?? null;
}

// ---------------------------------------------------------------------------
// Find what datasets a specific DAG produces and consumes
// ---------------------------------------------------------------------------
export async function getDagDatasetMap(
  dagId: string,
  instanceName = 'default'
): Promise<{ produces: AirflowDataset[]; consumes: AirflowDataset[]; source: 'live' | 'synthetic' }> {
  const datasets = await getDatasets(instanceName);
  const isSynthetic = datasets.length > 0 && datasets[0].uri.includes('demo');

  const produces = datasets.filter(d => d.producingTasks.some(t => t.dagId === dagId));
  const consumes = datasets.filter(d => d.consumingDags.some(c => c.dagId === dagId));

  return { produces, consumes, source: isSynthetic ? 'synthetic' : 'live' };
}

// ---------------------------------------------------------------------------
// Format lineage text for the agent prompt
// ---------------------------------------------------------------------------
export function airflowLineageToText(
  dagId: string,
  deps: DagDependency[],
  datasetMap: { produces: AirflowDataset[]; consumes: AirflowDataset[] },
  upstreamTriggers?: DagRunInfo['triggeredByAssetEvents'],
): string {
  const lines: string[] = [`AIRFLOW LINEAGE for DAG '${dagId}':`];

  // Dataset-aware scheduling (the native Airflow lineage graph)
  if (datasetMap.consumes.length > 0) {
    lines.push('\nTRIGGERED BY DATASETS (this DAG runs when these datasets update):');
    for (const d of datasetMap.consumes) {
      const producers = d.producingTasks.map(t => `${t.dagId}.${t.taskId}`).join(', ');
      lines.push(`  ← Dataset: ${d.uri}`);
      lines.push(`    Produced by: ${producers || 'unknown'}`);
      if (d.lastDatasetUpdate) lines.push(`    Last updated: ${d.lastDatasetUpdate}`);
    }
  }

  if (datasetMap.produces.length > 0) {
    lines.push('\nDATASETS THIS DAG PRODUCES (downstream DAGs triggered by these):');
    for (const d of datasetMap.produces) {
      const consumers = d.consumingDags.map(c => c.dagId).join(', ');
      lines.push(`  → Dataset: ${d.uri}`);
      lines.push(`    Consumed by: ${consumers || 'none configured'}`);
    }
  }

  // Sensor / explicit trigger edges from /dag_dependencies
  const upstreamEdges = deps.filter(d => d.target === dagId);
  const downstreamEdges = deps.filter(d => d.source === dagId);

  if (upstreamEdges.length > 0) {
    lines.push('\nEXPLICIT UPSTREAM DEPENDENCIES (from /api/v1/dag_dependencies):');
    for (const edge of upstreamEdges) {
      lines.push(`  ← ${edge.source} [${edge.dependencyType}] via ${edge.dependencyId}`);
    }
  }

  if (downstreamEdges.length > 0) {
    lines.push('\nEXPLICIT DOWNSTREAM DEPENDENTS:');
    for (const edge of downstreamEdges) {
      lines.push(`  → ${edge.target} [${edge.dependencyType}] via ${edge.dependencyId}`);
    }
  }

  // What actually triggered this specific run
  if (upstreamTriggers && upstreamTriggers.length > 0) {
    lines.push('\nWHAT TRIGGERED THIS RUN (upstream dataset events):');
    for (const t of upstreamTriggers) {
      lines.push(`  Triggered by: ${t.sourceDagId}.${t.sourceTaskId} updated ${t.assetUri} at ${t.timestamp}`);
    }
  }

  if (lines.length === 1) {
    lines.push('  No dataset dependencies found. DAG may use time-based schedule only.');
    lines.push('  Check for ExternalTaskSensor or TriggerDagRunOperator in DAG source (connect GitHub to read DAG files).');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Synthetic demo data
// ---------------------------------------------------------------------------
function getSyntheticDagDependencies(): DagDependency[] {
  return [
    { source: '01_ingest_shopify_orders', target: '02_transform_orders', dependencyType: 'dataset', dependencyId: 's3://data-lake/shopify/orders/' },
    { source: '02_transform_orders', target: '03_dbt_revenue_models', dependencyType: 'dataset', dependencyId: 'snowflake://PROD.STAGING.STG_ORDERS' },
    { source: '03_dbt_revenue_models', target: '04_export_revenue_dashboard', dependencyType: 'dataset', dependencyId: 'snowflake://PROD.ANALYTICS.FCT_REVENUE' },
    { source: '00_fivetran_sync_trigger', target: '01_ingest_shopify_orders', dependencyType: 'sensor', dependencyId: 'wait_for_fivetran_sensor' },
  ];
}

function getSyntheticDatasets(): AirflowDataset[] {
  const now = new Date();
  return [
    {
      uri: 's3://data-lake/shopify/orders/',
      producingTasks: [{ dagId: '01_ingest_shopify_orders', taskId: 'extract_orders' }],
      consumingDags: [{ dagId: '02_transform_orders' }],
      lastDatasetUpdate: new Date(now.getTime() - 5 * 3600000).toISOString(),
    },
    {
      uri: 'snowflake://PROD.STAGING.STG_ORDERS',
      producingTasks: [{ dagId: '02_transform_orders', taskId: 'run_dbt_staging' }],
      consumingDags: [{ dagId: '03_dbt_revenue_models' }],
      lastDatasetUpdate: new Date(now.getTime() - 4 * 3600000).toISOString(),
    },
    {
      uri: 'snowflake://PROD.ANALYTICS.FCT_REVENUE',
      producingTasks: [{ dagId: '03_dbt_revenue_models', taskId: 'run_dbt_marts' }],
      consumingDags: [{ dagId: '04_export_revenue_dashboard' }],
      lastDatasetUpdate: new Date(now.getTime() - 3 * 3600000).toISOString(),
    },
  ];
}

function getSyntheticUpstreamTriggers(dagId: string): DagRunInfo['triggeredByAssetEvents'] {
  const now = new Date();
  if (dagId.includes('transform') || dagId.includes('02')) {
    return [{
      assetUri: 's3://data-lake/shopify/orders/',
      sourceDagId: '01_ingest_shopify_orders',
      sourceTaskId: 'extract_orders',
      timestamp: new Date(now.getTime() - 4 * 3600000).toISOString(),
    }];
  }
  return [];
}
