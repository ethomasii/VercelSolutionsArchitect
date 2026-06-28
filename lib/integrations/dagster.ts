// Dagster integration — uses Dagster MCP server when credentials are configured.
//
// MCP endpoint: https://mcp.agent.dagster.cloud/mcp/
// Required headers:
//   Authorization: Bearer {DAGSTER_TOKEN}
//   Dagster-Cloud-Organization: {DAGSTER_ORG}
//   X-Dagster-Delegation-Token: {DAGSTER_TOKEN}   ← required for tool execution
//   Accept: application/json, text/event-stream    ← required for SSE transport
//
// Tool names discovered from tools/list:
//   get_run           → run metadata + status
//   get_run_logs      → paginated event logs
//   list_runs         → recent runs filtered by status/job
//   get_asset         → asset health + last materialization
//   get_assets        → paginated asset list
//   list_issues       → Dagster Issues (incidents)
//   detect_asset_metric_anomalies → anomaly detection
//
// To activate: go to /settings and fill in Dagster credentials.
// The /settings UI stores them encrypted in Neon.

import { getSetting } from '../settings';

export interface DagsterRunResult {
  runId: string | null;
  status: string | null;
  jobName: string | null;
  assetKey: string | null;
  failureDescription: string | null;
  failureStep: string | null;
  startTime: string | null;
  endTime: string | null;
  commitHash: string | null;
  repoUrl: string | null;
  source: 'live' | 'unavailable';
}

export interface DagsterRunLogResult {
  events: Array<{
    eventType: string;
    message: string;
    timestamp: string;
    stepKey: string | null;
    level: string;
  }>;
  source: 'live' | 'unavailable';
}

const MCP_URL = 'https://mcp.agent.dagster.cloud/mcp/';

async function callDagsterMCP(
  token: string,
  org: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`,
      'Dagster-Cloud-Organization': org,
      'X-Dagster-Delegation-Token': token,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: Date.now(),
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Dagster MCP HTTP ${response.status}`);
  }

  // Parse SSE response: "event: message\ndata: {...}\n\n"
  const raw = await response.text();
  const dataLine = raw.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) throw new Error('No data in Dagster MCP response');

  const json = JSON.parse(dataLine.slice(6)) as {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
    error?: { message: string };
  };

  if (json.error) throw new Error(json.error.message);
  if (json.result?.isError) {
    const errText = json.result.content?.[0]?.text ?? 'Unknown error';
    throw new Error(errText);
  }

  const text = json.result?.content?.[0]?.text;
  if (!text) throw new Error('Empty Dagster MCP result');

  return JSON.parse(text);
}

async function getCredentials(instanceName = 'default'): Promise<{
  token: string; org: string; deploymentName: string;
} | null> {
  const [token, org] = await Promise.all([
    getSetting('dagster', 'DAGSTER_TOKEN', instanceName),
    getSetting('dagster', 'DAGSTER_ORG', instanceName),
  ]);

  if (!token || !org) return null;

  const deploymentName = await getSetting('dagster', 'DAGSTER_DEPLOYMENT', instanceName)
    ?? 'data-eng-prod';

  return { token, org, deploymentName };
}

export async function getRunStatus(
  runId: string,
  instanceName = 'default'
): Promise<DagsterRunResult> {
  const creds = await getCredentials(instanceName);

  if (!creds) {
    return {
      runId, status: null, jobName: null, assetKey: null,
      failureDescription: null, failureStep: null, startTime: null,
      endTime: null, commitHash: null, repoUrl: null,
      source: 'unavailable',
    };
  }

  try {
    const data = await callDagsterMCP(creds.token, creds.org, 'get_run', {
      deployment_name: creds.deploymentName,
      run_id: runId,
    }) as {
      runId?: string; status?: string; jobName?: string;
      startTime?: number; endTime?: number;
      tags?: Array<{ key: string; value: string }>;
    };

    const tags = Object.fromEntries((data.tags ?? []).map(t => [t.key, t.value]));

    return {
      runId: data.runId ?? runId,
      status: data.status ?? null,
      jobName: data.jobName ?? null,
      assetKey: tags['dagster/asset_key'] ?? null,
      failureDescription: tags['dagster/failure_reason'] ?? null,
      failureStep: null,
      startTime: data.startTime ? new Date(data.startTime * 1000).toISOString() : null,
      endTime: data.endTime ? new Date(data.endTime * 1000).toISOString() : null,
      commitHash: tags['dagster/git_commit_hash'] ?? null,
      repoUrl: tags['dagster/git_project_url'] ?? null,
      source: 'live',
    };
  } catch (err) {
    console.warn('[dagster] getRunStatus failed:', err);
    return {
      runId, status: null, jobName: null, assetKey: null,
      failureDescription: null, failureStep: null, startTime: null,
      endTime: null, commitHash: null, repoUrl: null,
      source: 'unavailable',
    };
  }
}

export async function getRunLogs(
  runId: string,
  limit = 50,
  instanceName = 'default'
): Promise<DagsterRunLogResult> {
  const creds = await getCredentials(instanceName);
  if (!creds) return { events: [], source: 'unavailable' };

  try {
    const data = await callDagsterMCP(creds.token, creds.org, 'get_run_logs', {
      deployment_name: creds.deploymentName,
      run_id: runId,
      limit,
    }) as {
      events?: Array<{
        eventType?: string; message?: string;
        timestamp?: string; stepKey?: string; level?: string;
      }>;
    };

    return {
      events: (data.events ?? []).map(e => ({
        eventType: e.eventType ?? 'UNKNOWN',
        message: e.message ?? '',
        timestamp: e.timestamp ?? '',
        stepKey: e.stepKey ?? null,
        level: e.level ?? 'INFO',
      })),
      source: 'live',
    };
  } catch (err) {
    console.warn('[dagster] getRunLogs failed:', err);
    return { events: [], source: 'unavailable' };
  }
}

export async function getAssetHealth(
  assetKey: string[],
  instanceName = 'default'
): Promise<{ status: string; lastMaterialized: string | null; source: 'live' | 'unavailable' }> {
  const creds = await getCredentials(instanceName);
  if (!creds) return { status: 'unknown', lastMaterialized: null, source: 'unavailable' };

  try {
    const data = await callDagsterMCP(creds.token, creds.org, 'get_asset', {
      deployment_name: creds.deploymentName,
      asset_key: assetKey,
    }) as {
      latestMaterializationTimestamp?: number;
      latestFailedToMaterializeTimestamp?: number;
    };

    const lastSuccess = data.latestMaterializationTimestamp;
    const lastFail = data.latestFailedToMaterializeTimestamp;

    const status = lastFail && (!lastSuccess || lastFail > lastSuccess) ? 'failed' : 'ok';

    return {
      status,
      lastMaterialized: lastSuccess ? new Date(lastSuccess).toISOString() : null,
      source: 'live',
    };
  } catch (err) {
    console.warn('[dagster] getAssetHealth failed:', err);
    return { status: 'unknown', lastMaterialized: null, source: 'unavailable' };
  }
}
