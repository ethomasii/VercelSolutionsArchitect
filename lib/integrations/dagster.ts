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

// Walk the asset graph to find upstream failures.
// Strategy:
//   1. Get recent failed runs for the same job (is this a repeat failure?)
//   2. Get assets with latestFailedToMaterializeTimestamp (upstream failures?)
//   3. Return context to include in enriched prompt
//
// Note: Full graph traversal (deps → upstream deps) requires multiple get_asset calls
// per node. For now: fetch top-level asset health + recent job run history.
// With Dagster MCP's asset graph, a deeper traversal would:
//   - get_asset(key) → asset.definition.dependencies → recursive get_asset calls
// This is the correct long-term implementation once we add pagination + caching.
export async function getUpstreamContext(
  jobName: string,
  runId: string,
  instanceName = 'default'
): Promise<{
  priorFailures: number;
  isRecurring: boolean;
  failedAssets: Array<{ key: string[]; lastFailedAt: string }>;
  recentRuns: Array<{ runId: string; status: string; startTime: string | null }>;
  source: 'live' | 'unavailable';
}> {
  const creds = await getCredentials(instanceName);
  if (!creds) return { priorFailures: 0, isRecurring: false, failedAssets: [], recentRuns: [], source: 'unavailable' };

  try {
    // 1. Recent runs of the same job (last 10) to detect recurring failures
    const runsData = await callDagsterMCP(creds.token, creds.org, 'list_runs', {
      deployment_name: creds.deploymentName,
      limit: 10,
    }) as { results?: Array<{ runId?: string; status?: string; jobName?: string; startTime?: number }> };

    const jobRuns = (runsData.results ?? [])
      .filter(r => r.jobName === jobName && r.runId !== runId);

    const priorFailures = jobRuns.filter(r => r.status === 'FAILURE').length;

    // 2. Assets with recent failures — get the first 20 assets and check health
    const assetsData = await callDagsterMCP(creds.token, creds.org, 'get_assets', {
      deployment_name: creds.deploymentName,
      limit: 20,
    }) as {
      nodes?: Array<{
        key?: { path?: string[] };
        latestFailedToMaterializeTimestamp?: number | null;
      }>;
    };

    const recentlyFailed = (assetsData.nodes ?? [])
      .filter(a =>
        a.latestFailedToMaterializeTimestamp &&
        Date.now() - a.latestFailedToMaterializeTimestamp < 6 * 3600 * 1000
      )
      .map(a => ({
        key: a.key?.path ?? [],
        lastFailedAt: new Date(a.latestFailedToMaterializeTimestamp!).toISOString(),
      }));

    return {
      priorFailures,
      isRecurring: priorFailures >= 2,
      failedAssets: recentlyFailed,
      recentRuns: jobRuns.slice(0, 5).map(r => ({
        runId: r.runId ?? '',
        status: r.status ?? 'UNKNOWN',
        startTime: r.startTime ? new Date(r.startTime * 1000).toISOString() : null,
      })),
      source: 'live',
    };
  } catch (err) {
    console.warn('[dagster] getUpstreamContext failed:', err);
    return { priorFailures: 0, isRecurring: false, failedAssets: [], recentRuns: [], source: 'unavailable' };
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

// Get the actual Python exception directly from Dagster's GraphQL API.
// The MCP event log only shows "STEP_FAILURE" — the real exception is in
// ExecutionStepUpForRetryEvent.error.message and the preceding LogMessageEvents.
export async function getStepFailureDetails(
  runId: string,
  instanceName = 'default'
): Promise<{ errorMessage: string | null; logMessages: string[]; stepKey: string | null }> {
  const creds = await getCredentials(instanceName);
  if (!creds) return { errorMessage: null, logMessages: [], stepKey: null };

  // Use GraphQL directly — more detail than MCP event log
  const graphqlUrl = creds.deploymentName
    ? `https://${creds.org}.dagster.cloud/${creds.deploymentName}/graphql`
    : `https://dagster.cloud/graphql`;

  const query = `query RunLogs($runId: ID!) {
    logsForRun(runId: $runId) {
      ... on EventConnection {
        events {
          __typename
          ... on ExecutionStepUpForRetryEvent { stepKey error { message } }
          ... on ExecutionStepFailureEvent { stepKey error { message } }
          ... on LogMessageEvent { message level }
        }
      }
    }
    pipelineRunOrError(runId: $runId) {
      ... on Run { stepStats { stepKey status } }
    }
  }`;

  try {
    const resp = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Dagster-Cloud-Api-Token': creds.token,
      },
      body: JSON.stringify({ query, variables: { runId } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`GraphQL HTTP ${resp.status}`);

    const data = await resp.json() as {
      data?: {
        logsForRun?: {
          events?: Array<{
            __typename: string;
            stepKey?: string;
            message?: string;
            level?: string;
            error?: { message?: string };
          }>;
        };
        pipelineRunOrError?: {
          stepStats?: Array<{ stepKey: string; status: string }>;
        };
      };
    };

    const events = data.data?.logsForRun?.events ?? [];

    // Get the failed step from stepStats
    const failedStep = data.data?.pipelineRunOrError?.stepStats
      ?.find(s => s.status === 'FAILURE')?.stepKey ?? null;

    // Get retry error messages (the real underlying exception)
    const retryErrors = events
      .filter(e => e.__typename === 'ExecutionStepUpForRetryEvent' || e.__typename === 'ExecutionStepFailureEvent')
      .map(e => e.error?.message ?? '')
      .filter(Boolean);

    // Get relevant log messages (before the failure)
    const logMessages = events
      .filter(e => e.__typename === 'LogMessageEvent' && e.level !== 'DEBUG')
      .map(e => e.message ?? '')
      .filter(Boolean)
      .slice(-10); // last 10 log messages

    return {
      errorMessage: retryErrors[0] ?? null,
      logMessages,
      stepKey: failedStep,
    };
  } catch (err) {
    console.warn('[dagster] getStepFailureDetails GraphQL failed:', err);
    return { errorMessage: null, logMessages: [], stepKey: null };
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

// Traverse the Dagster asset graph to find assets that depend on the failing asset.
// Uses get_assets (returns all assets) then filters by assetDependencies.
// Falls back to extracting "Dependencies for step X failed" from run logs if MCP unavailable.
export async function getDownstreamAssets(
  failingAssetKey: string[],
  runLogs?: string[],
  instanceName = 'default'
): Promise<{ assetKey: string[]; status: string; willBeBlocked: boolean; source: 'live' | 'logs' | 'unavailable' }[]> {
  // First try to extract from run logs — Dagster logs explicitly say what got blocked
  if (runLogs && runLogs.length > 0) {
    const downstream: { assetKey: string[]; status: string; willBeBlocked: boolean; source: 'logs' }[] = [];
    const failingStepName = failingAssetKey.join('.');
    for (const line of runLogs) {
      // "Dependencies for step enriched_data.concat_chunk_list failed: ['enriched_data.process_chunk[9]']"
      const depsMatch = line.match(/Dependencies for step (\S+) failed.*\[('[^']+'(?:, '[^']+')*)\]/);
      if (depsMatch && depsMatch[2].includes(failingStepName.replace(/\[.*\]/, ''))) {
        downstream.push({
          assetKey: depsMatch[1].split('.'),
          status: 'SKIPPED (dependency failed)',
          willBeBlocked: true,
          source: 'logs',
        });
      }
      // "Asset ["enriched_data"] failed to materialize"
      const assetFailed = line.match(/Asset \[\"([^"]+)\"\] failed to materialize/);
      if (assetFailed && assetFailed[1] !== failingAssetKey.join('/')) {
        downstream.push({
          assetKey: assetFailed[1].split('/'),
          status: 'FAILED TO MATERIALIZE',
          willBeBlocked: true,
          source: 'logs',
        });
      }
    }
    if (downstream.length > 0) return downstream;
  }

  // Try live Dagster MCP — get_assets returns asset dependency graph
  const creds = await getCredentials(instanceName);
  if (!creds) return [];

  try {
    const data = await callDagsterMCP(creds.token, creds.org, 'get_assets', {
      deployment_name: creds.deploymentName,
    }) as {
      assets?: Array<{
        assetKey: string[];
        assetDependencies?: string[][];
        latestMaterializationTimestamp?: number;
        latestFailedToMaterializeTimestamp?: number;
      }>;
    };

    const assets = data.assets ?? [];
    const failingKeyStr = failingAssetKey.join('/');

    // Find assets that list the failing asset as a dependency
    return assets
      .filter(a => a.assetDependencies?.some(dep => dep.join('/') === failingKeyStr))
      .map(a => {
        const lastFail = a.latestFailedToMaterializeTimestamp;
        const lastSuccess = a.latestMaterializationTimestamp;
        const status = lastFail && (!lastSuccess || lastFail > lastSuccess) ? 'FAILED' : 'OK';
        return { assetKey: a.assetKey, status, willBeBlocked: true, source: 'live' as const };
      });
  } catch (err) {
    console.warn('[dagster] getDownstreamAssets failed:', err);
    return [];
  }
}
