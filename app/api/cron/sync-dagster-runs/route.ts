// Vercel Cron Job — runs every 30 minutes to sync recent Dagster run failures to Neon.
//
// This enables two things:
//   1. Cross-orchestrator incident history: the incidents table gets populated from real
//      Dagster runs automatically, without manual webhook setup
//   2. Recurring failure detection: lookupIncidentHistory can detect that run_etl_pipeline
//      has failed 3 times this week even if no webhook was configured
//
// Configure in vercel.json or vercel.ts:
//   "crons": [{ "path": "/api/cron/sync-dagster-runs", "schedule": "*/30 * * * *" }]
//
// Vercel Cron docs: https://vercel.com/docs/cron-jobs

import { sql } from '@/lib/db';
import { getRunStatus } from '@/lib/integrations/dagster';
import { getSetting } from '@/lib/settings';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Vercel invokes cron jobs with a Authorization: Bearer CRON_SECRET header
function verifyCronAuth(req: Request): boolean {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // dev: skip auth
  return authHeader === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
  if (!verifyCronAuth(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = await getSetting('dagster', 'DAGSTER_TOKEN');
  const org = await getSetting('dagster', 'DAGSTER_ORG');
  const deploymentName = await getSetting('dagster', 'DAGSTER_DEPLOYMENT') ?? 'data-eng-prod';

  if (!token || !org) {
    return Response.json({ skipped: true, reason: 'Dagster credentials not configured' });
  }

  try {
    // Fetch recent failed runs from Dagster
    const mcpUrl = 'https://mcp.agent.dagster.cloud/mcp/';
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`,
      'Dagster-Cloud-Organization': org,
      'X-Dagster-Delegation-Token': token,
    };

    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: Date.now(),
        params: {
          name: 'list_runs',
          arguments: { deployment_name: deploymentName, status: 'FAILURE', limit: 20 },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) throw new Error(`Dagster MCP ${response.status}`);

    const raw = await response.text();
    const dataLine = raw.split('\n').find(l => l.startsWith('data: '));
    if (!dataLine) throw new Error('No data in response');

    const json = JSON.parse(dataLine.slice(6)) as {
      result?: { content?: Array<{ type: string; text: string }> };
    };
    const text = json.result?.content?.[0]?.text;
    if (!text) throw new Error('Empty result');

    const runsData = JSON.parse(text) as {
      results?: Array<{
        runId?: string; jobName?: string; status?: string;
        startTime?: number; endTime?: number;
        tags?: Array<{ key: string; value: string }>;
      }>;
    };

    const runs = runsData.results ?? [];
    let synced = 0;

    for (const run of runs) {
      if (!run.runId) continue;
      const tags = Object.fromEntries((run.tags ?? []).map(t => [t.key, t.value]));

      // Check if this run is already in the incidents table
      const existing = await sql`
        SELECT id FROM incidents WHERE dagster_run_id = ${run.runId} LIMIT 1
      `;
      if (existing.length > 0) continue;

      const occurredAt = run.startTime
        ? new Date(run.startTime * 1000).toISOString()
        : new Date().toISOString();
      const resolvedAt = run.endTime
        ? new Date(run.endTime * 1000).toISOString()
        : null;

      await sql`
        INSERT INTO incidents (
          org_id, pipeline_name, failure_type, occurred_at, resolved_at,
          root_cause, known_flaky, dagster_run_id
        ) VALUES (
          'default',
          ${run.jobName ?? 'unknown'},
          'unknown',
          ${occurredAt},
          ${resolvedAt},
          ${`Dagster STEP_FAILURE (run: ${run.runId}, reason: ${tags['dagster/failure_reason'] ?? 'unknown'})`},
          false,
          ${run.runId}
        )
        ON CONFLICT DO NOTHING
      `;
      synced++;
    }

    console.log(`[cron/sync-dagster-runs] Synced ${synced} new failures from ${runs.length} recent runs`);

    return Response.json({
      ok: true,
      deployment: deploymentName,
      totalFailed: runs.length,
      newlySynced: synced,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[cron/sync-dagster-runs] Error:', err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
