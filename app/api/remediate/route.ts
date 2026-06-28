// Remediation execution endpoint.
// The triage UI proposes actions from proposeActions tool output.
// This route executes them with human-in-the-loop approval.
//
// Supported action IDs:
//   rerun_dagster         → Dagster MCP rerun_run
//   trigger_fivetran_sync → Fivetran API sync_connection
//   create_jira_ticket    → Atlassian Rovo MCP (or REST)
//   create_slack_alert    → Slack webhook
//   mark_resolved         → Neon incidents table update
//   open_dashboard        → Returns URL (client navigates)

import { sql } from '@/lib/db';
import { getSetting } from '@/lib/settings';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface RemediateRequest {
  actionId: string;
  params?: Record<string, string>;
  pipelineName?: string;
  failureType?: string;
  triageReport?: string;
}

export async function POST(req: Request) {
  const body = await req.json() as RemediateRequest;
  const { actionId, params = {}, pipelineName, failureType, triageReport } = body;

  switch (actionId) {

    case 'mark_resolved': {
      // Mark the most recent open incident for this pipeline as resolved
      if (!pipelineName) return Response.json({ ok: false, error: 'pipelineName required' }, { status: 400 });

      await sql`
        UPDATE incidents
        SET resolved_at = now(),
            resolution_summary = ${params.resolutionNote ?? 'Resolved via Dispatch triage'},
            resolved_by = 'dispatch-auto'
        WHERE org_id = 'default'
          AND pipeline_name = ${pipelineName}
          AND resolved_at IS NULL
          AND occurred_at > now() - interval '24 hours'
      `;
      return Response.json({ ok: true, message: `Marked ${pipelineName} incidents as resolved` });
    }

    case 'rerun_dagster': {
      const token = await getSetting('dagster', 'DAGSTER_TOKEN');
      const org = await getSetting('dagster', 'DAGSTER_ORG');
      const deployment = await getSetting('dagster', 'DAGSTER_DEPLOYMENT') ?? 'data-eng-prod';

      if (!token || !org) {
        return Response.json({
          ok: false,
          error: 'Dagster credentials not configured',
          setup: 'Go to /settings → Dagster and add your token',
        }, { status: 400 });
      }

      const runId = params.runId;
      if (!runId) return Response.json({ ok: false, error: 'runId required' }, { status: 400 });

      try {
        const response = await fetch('https://mcp.agent.dagster.cloud/mcp/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${token}`,
            'Dagster-Cloud-Organization': org,
            'X-Dagster-Delegation-Token': token,
          },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'tools/call', id: Date.now(),
            params: { name: 'rerun_run', arguments: { deployment_name: deployment, run_id: runId } },
          }),
          signal: AbortSignal.timeout(10000),
        });

        const raw = await response.text();
        const dataLine = raw.split('\n').find(l => l.startsWith('data: '));
        const data = dataLine ? JSON.parse(dataLine.slice(6)) as { result?: { isError?: boolean; content?: Array<{ text: string }> } } : null;

        if (data?.result?.isError) {
          return Response.json({ ok: false, error: data.result.content?.[0]?.text });
        }
        return Response.json({ ok: true, message: `Rerun triggered for run ${runId}`, detail: data?.result?.content?.[0]?.text });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    case 'trigger_fivetran_sync': {
      const apiKey = await getSetting('fivetran', 'FIVETRAN_API_KEY');
      const apiSecret = await getSetting('fivetran', 'FIVETRAN_API_SECRET');

      if (!apiKey || !apiSecret) {
        return Response.json({
          ok: false,
          error: 'Fivetran credentials not configured',
          setup: 'Go to /settings → Fivetran and add your API key + secret',
        }, { status: 400 });
      }

      const connectorId = params.connectorId;
      if (!connectorId) return Response.json({ ok: false, error: 'connectorId required' }, { status: 400 });

      try {
        const creds = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
        const resp = await fetch(`https://api.fivetran.com/v1/connectors/${connectorId}/sync`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: false }),
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return Response.json({ ok: false, error: `Fivetran API ${resp.status}` });
        return Response.json({ ok: true, message: `Sync triggered for connector ${connectorId}` });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    case 'create_slack_alert': {
      const webhookUrl = await getSetting('slack', 'SLACK_WEBHOOK_URL');
      if (!webhookUrl) {
        return Response.json({
          ok: false, error: 'Slack webhook not configured',
          setup: 'Go to /settings → Slack',
        }, { status: 400 });
      }

      const message = triageReport
        ? `*Dispatch Triage: ${pipelineName ?? 'unknown'}*\n${triageReport.slice(0, 2000)}`
        : `Pipeline failure: ${pipelineName} (${failureType}). Check Dispatch for full triage.`;

      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
      return Response.json({ ok: true, message: 'Posted to Slack' });
    }

    case 'create_jira_ticket': {
      // TODO: Implement via Atlassian Rovo MCP or REST API
      // POST /rest/api/3/issue with summary + description
      return Response.json({
        ok: false,
        error: 'Jira integration not yet implemented',
        workaround: 'Configure Atlassian credentials in /settings to enable',
      }, { status: 501 });
    }

    case 'open_dashboard': {
      const url = params.url;
      return Response.json({ ok: true, url, message: 'Open this URL in your browser' });
    }

    default:
      return Response.json({ ok: false, error: `Unknown action: ${actionId}` }, { status: 400 });
  }
}
