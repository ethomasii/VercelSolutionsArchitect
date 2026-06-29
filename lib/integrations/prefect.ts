// Prefect integration — REST API + MCP bridge
//
// MCP: PrefectHQ/prefect-mcp-server (official, self-hosted)
//   Run locally:  uvx --from prefect-mcp prefect-mcp-server
//   Team setup:   deploy to FastMCP Cloud → get URL → add to Dispatch /settings
//   Auth:         PREFECT_API_KEY (Cloud) or PREFECT_API_AUTH_STRING (self-hosted)
//   Multi-tenant: credentials pass per-request via HTTP headers
//
// REST API:
//   Prefect Cloud:     https://api.prefect.cloud/api/accounts/{id}/workspaces/{id}
//   Self-hosted:       http://your-server:4200/api
//   Auth: Bearer token (API key) or basic auth
//
// KEY LINEAGE INSIGHT — Prefect flow dependencies come from three places:
//
// 1. run_deployment('flow/deployment', wait_for_completion=True)
//    — explicit: this flow calls and waits for another flow
//
// 2. Shared blocks: two flows loading the same SnowflakeConnector.load('prod')
//    or S3Bucket.load('data-lake') share the same data resource.
//    If flow A writes to it and flow B reads from it, B depends on A.
//
// 3. .serve() / .deploy() schedule alignment — flows scheduled sequentially
//    with the same data resources implies ordering.
//
// 4. Flow-of-flows: a parent @flow that calls child @flow functions directly
//    (not via run_deployment). The function call IS the dependency.
//
// The Prefect MCP exposes: get_flow_run, get_task_run_logs, list_flow_runs,
// get_deployment, list_deployments — enough to reconstruct the chain.

import { getSetting } from '../settings';

interface PrefectCredentials {
  apiUrl: string;
  apiKey?: string;
  authString?: string;  // basic auth: "user:password"
}

export interface PrefectFlowRun {
  id: string;
  name: string;
  flowName: string;
  deploymentName?: string;
  state: 'COMPLETED' | 'FAILED' | 'CRASHED' | 'CANCELLED' | 'RUNNING' | 'PENDING' | 'SCHEDULED';
  stateMessage?: string;
  startTime?: string;
  endTime?: string;
  totalRunTime?: number;     // seconds
  parameters?: Record<string, unknown>;
  parentTaskRunId?: string;  // set when triggered by another flow's run_deployment call
  source: 'live' | 'synthetic';
}

export interface PrefectTaskRun {
  id: string;
  name: string;
  taskKey: string;
  state: string;
  startTime?: string;
  endTime?: string;
  runCount: number;           // how many retries happened
  stateMessage?: string;
}

export interface PrefectDeployment {
  id: string;
  name: string;
  flowName: string;
  schedule?: string;
  tags: string[];
  workPool?: string;
  // Parameters often reveal shared data resources
  parameters?: Record<string, unknown>;
}

interface PrefectLineage {
  flowRunId: string;
  flowName: string;
  // Upstream: other flow runs that this run depends on
  parentFlowRun?: PrefectFlowRun;
  subflowRunIds?: string[];     // child flows this run triggered
  // Shared block dependencies inferred from flow code
  sharedBlocks?: string[];
  // Inferred from run_deployment() calls in source
  triggeredDeployments?: string[];
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
async function getCredentials(): Promise<PrefectCredentials | null> {
  const apiUrl = await getSetting('prefect', 'PREFECT_API_URL');
  const apiKey = await getSetting('prefect', 'PREFECT_API_KEY');
  const authString = await getSetting('prefect', 'PREFECT_API_AUTH_STRING');
  if (!apiUrl) return null;
  return { apiUrl: apiUrl.replace(/\/$/, ''), apiKey: apiKey ?? undefined, authString: authString ?? undefined };
}

function authHeader(creds: PrefectCredentials): string {
  if (creds.apiKey) return `Bearer ${creds.apiKey}`;
  if (creds.authString) return `Basic ${Buffer.from(creds.authString).toString('base64')}`;
  return '';
}

async function prefectPost<T>(creds: PrefectCredentials, path: string, body: unknown): Promise<T | null> {
  try {
    const resp = await fetch(`${creds.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader(creds),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) { console.warn(`[prefect] POST ${path} → ${resp.status}`); return null; }
    return resp.json() as Promise<T>;
  } catch (err) { console.warn('[prefect] error:', err); return null; }
}

async function prefectGet<T>(creds: PrefectCredentials, path: string): Promise<T | null> {
  try {
    const resp = await fetch(`${creds.apiUrl}${path}`, {
      headers: { 'Authorization': authHeader(creds), 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) { console.warn(`[prefect] GET ${path} → ${resp.status}`); return null; }
    return resp.json() as Promise<T>;
  } catch (err) { console.warn('[prefect] error:', err); return null; }
}

// ---------------------------------------------------------------------------
// Core API calls
// ---------------------------------------------------------------------------

export async function getFlowRun(flowRunId: string): Promise<PrefectFlowRun | null> {
  const creds = await getCredentials();
  if (!creds) return getSyntheticFlowRun(flowRunId);

  const data = await prefectGet<{
    id: string; name: string; state: { type: string; message?: string };
    start_time?: string; end_time?: string; total_run_time?: number;
    deployment_id?: string; parent_task_run_id?: string;
    parameters?: Record<string, unknown>;
  }>(creds, `/flow_runs/${flowRunId}`);

  if (!data) return getSyntheticFlowRun(flowRunId);

  // Resolve flow name from deployment if available
  let flowName = 'unknown';
  let deploymentName: string | undefined;
  if (data.deployment_id) {
    const dep = await prefectGet<{ name: string; flow: { name: string } }>(creds, `/deployments/${data.deployment_id}`);
    if (dep) { flowName = dep.flow?.name ?? 'unknown'; deploymentName = dep.name; }
  }

  return {
    id: data.id,
    name: data.name,
    flowName,
    deploymentName,
    state: data.state.type as PrefectFlowRun['state'],
    stateMessage: data.state.message,
    startTime: data.start_time,
    endTime: data.end_time,
    totalRunTime: data.total_run_time,
    parameters: data.parameters,
    parentTaskRunId: data.parent_task_run_id,
    source: 'live',
  };
}

// Get all task runs within a flow run — this is the within-flow dependency graph
export async function getFlowRunTaskRuns(flowRunId: string): Promise<PrefectTaskRun[]> {
  const creds = await getCredentials();
  if (!creds) return getSyntheticTaskRuns(flowRunId);

  const data = await prefectPost<Array<{
    id: string; name: string; task_key: string;
    state: { type: string; message?: string };
    start_time?: string; end_time?: string; run_count: number;
  }>>(creds, '/task_runs/filter', {
    flow_run_filter: { id: { any_: [flowRunId] } },
    sort: 'START_TIME_ASC',
    limit: 200,
  });

  if (!data) return getSyntheticTaskRuns(flowRunId);

  return data.map(t => ({
    id: t.id,
    name: t.name,
    taskKey: t.task_key,
    state: t.state.type,
    startTime: t.start_time,
    endTime: t.end_time,
    runCount: t.run_count,
    stateMessage: t.state.message,
  }));
}

// Find recent runs of the same flow — upstream failure detection
export async function getRecentFlowRuns(flowName: string, limit = 5): Promise<PrefectFlowRun[]> {
  const creds = await getCredentials();
  if (!creds) return getSyntheticRecentRuns(flowName);

  const flows = await prefectPost<Array<{ id: string; name: string }>>(creds, '/flows/filter', {
    flows: { name: { any_: [flowName] } },
    limit: 1,
  });

  const flowId = flows?.[0]?.id;
  if (!flowId) return [];

  const runs = await prefectPost<Array<{
    id: string; name: string; state: { type: string }; start_time?: string; end_time?: string;
  }>>(creds, '/flow_runs/filter', {
    flow_filter: { id: { any_: [flowId] } },
    sort: 'START_TIME_DESC',
    limit,
  });

  if (!runs) return [];
  return runs.map(r => ({
    id: r.id, name: r.name, flowName,
    state: r.state.type as PrefectFlowRun['state'],
    startTime: r.start_time, endTime: r.end_time,
    source: 'live' as const,
  }));
}

// Find subflow runs — flows that this flow triggered (run_deployment children)
export async function getSubflowRuns(parentFlowRunId: string): Promise<PrefectFlowRun[]> {
  const creds = await getCredentials();
  if (!creds) return [];

  // Subflow runs have a parent_task_run_id linking them back
  // Prefect API: filter by parent_task_run.flow_run_id
  const data = await prefectPost<Array<{
    id: string; name: string; state: { type: string; message?: string };
    start_time?: string; flow_id?: string;
  }>>(creds, '/flow_runs/filter', {
    flow_run_filter: { parent_flow_run_id: { any_: [parentFlowRunId] } },
    sort: 'START_TIME_ASC',
    limit: 20,
  });

  if (!data) return [];
  return data.map(r => ({
    id: r.id, name: r.name, flowName: 'subflow',
    state: r.state.type as PrefectFlowRun['state'],
    stateMessage: r.state.message,
    startTime: r.start_time,
    source: 'live' as const,
  }));
}

// Build lineage context for triage prompt
export async function getPrefectLineage(flowRunId: string): Promise<PrefectLineage | null> {
  const run = await getFlowRun(flowRunId);
  if (!run) return null;

  const [taskRuns, subflowRuns] = await Promise.all([
    getFlowRunTaskRuns(flowRunId),
    getSubflowRuns(flowRunId),
  ]);

  return {
    flowRunId,
    flowName: run.flowName,
    subflowRunIds: subflowRuns.map(s => s.id),
    triggeredDeployments: subflowRuns.map(s => s.name),
  };
}

// Format for agent prompt
export function prefectLineageToText(
  run: PrefectFlowRun,
  taskRuns: PrefectTaskRun[],
  subflowRuns: PrefectFlowRun[]
): string {
  const lines: string[] = [`PREFECT FLOW RUN: ${run.name} (${run.flowName})`];
  lines.push(`State: ${run.state}${run.stateMessage ? ` — ${run.stateMessage}` : ''}`);
  if (run.startTime) lines.push(`Duration: ${run.totalRunTime ? `${Math.round(run.totalRunTime)}s` : 'unknown'}`);

  // Failed tasks — the within-flow dependency walk
  const failedTasks = taskRuns.filter(t => ['FAILED', 'CRASHED'].includes(t.state));
  if (failedTasks.length > 0) {
    lines.push('\nFAILED TASKS (within-flow dependency graph):');
    for (const t of failedTasks) {
      lines.push(`  ✗ ${t.name} (task_key: ${t.taskKey})`);
      if (t.stateMessage) lines.push(`    Error: ${t.stateMessage}`);
      if (t.runCount > 1) lines.push(`    Retried ${t.runCount - 1} times before failing`);
    }
  }

  // Successful tasks that ran before the failure — context for "what completed upstream"
  const succeededTasks = taskRuns.filter(t => t.state === 'COMPLETED').slice(-5);
  if (succeededTasks.length > 0) {
    lines.push('\nLAST SUCCESSFUL TASKS (upstream context):');
    for (const t of succeededTasks) {
      lines.push(`  ✓ ${t.name}`);
    }
  }

  // Subflow runs (run_deployment children)
  if (subflowRuns.length > 0) {
    lines.push('\nSUBFLOW RUNS (triggered by this flow via run_deployment):');
    for (const s of subflowRuns) {
      lines.push(`  ${s.state === 'COMPLETED' ? '✓' : '✗'} ${s.name} → ${s.state}`);
    }
    lines.push('  Note: subflow failures cascade to parent — fix the earliest failing subflow first');
  }

  if (run.parentTaskRunId) {
    lines.push('\nPARENT CONTEXT: This flow was triggered BY another flow (parent_task_run_id present).');
    lines.push('  Check the parent flow run for the full dependency chain upstream.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Synthetic demo data
// ---------------------------------------------------------------------------
function getSyntheticFlowRun(runId: string): PrefectFlowRun {
  const now = new Date();
  return {
    id: runId,
    name: `${runId.slice(0, 8)}-run`,
    flowName: 'transform-orders',
    deploymentName: 'transform-orders/production',
    state: 'FAILED',
    stateMessage: 'Task run \'normalize_schema-0\' failed: KeyError: \'customer_tier\' — column missing from upstream table',
    startTime: new Date(now.getTime() - 3600000).toISOString(),
    endTime: new Date(now.getTime() - 3540000).toISOString(),
    totalRunTime: 3540,
    source: 'synthetic',
  };
}

function getSyntheticTaskRuns(flowRunId: string): PrefectTaskRun[] {
  return [
    { id: `${flowRunId}-t1`, name: 'extract_orders', taskKey: 'extract_orders-abc123', state: 'COMPLETED', runCount: 1, startTime: new Date(Date.now() - 3600000).toISOString() },
    { id: `${flowRunId}-t2`, name: 'validate_schema', taskKey: 'validate_schema-def456', state: 'COMPLETED', runCount: 1 },
    { id: `${flowRunId}-t3`, name: 'normalize_schema', taskKey: 'normalize_schema-ghi789', state: 'FAILED', runCount: 3, stateMessage: "KeyError: 'customer_tier' — column added to source but not in staging model" },
    { id: `${flowRunId}-t4`, name: 'load_to_warehouse', taskKey: 'load_to_warehouse-jkl012', state: 'PENDING', runCount: 0 },
  ];
}

function getSyntheticRecentRuns(flowName: string): PrefectFlowRun[] {
  const now = new Date();
  return [
    { id: 'run-001', name: 'transform-orders-a1b2', flowName, state: 'FAILED', startTime: new Date(now.getTime() - 3600000).toISOString(), source: 'synthetic' },
    { id: 'run-002', name: 'transform-orders-c3d4', flowName, state: 'COMPLETED', startTime: new Date(now.getTime() - 7200000).toISOString(), source: 'synthetic' },
    { id: 'run-003', name: 'transform-orders-e5f6', flowName, state: 'COMPLETED', startTime: new Date(now.getTime() - 10800000).toISOString(), source: 'synthetic' },
  ];
}
