// GitHub Actions webhook — triggers auto-triage when a workflow fails.
//
// To connect: GitHub repo → Settings → Webhooks → Add webhook
//   Payload URL: https://dispatch-triage-two.vercel.app/api/webhooks/github-actions
//   Content type: application/json
//   Secret: DISPATCH_WEBHOOK_SECRET
//   Events: Workflow runs
//
// This makes Dispatch proactive: when any GitHub Actions workflow fails,
// Dispatch triages automatically and posts to Slack before the on-call engineer looks.

import { postTriageReport } from '@/lib/integrations/slack';
import { sql } from '@/lib/db';
import crypto from 'crypto';

export async function POST(req: Request) {
  const body = await req.text();
  const secret = process.env.DISPATCH_WEBHOOK_SECRET;

  // Verify GitHub webhook signature
  if (secret) {
    const sig = req.headers.get('x-hub-signature-256');
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    if (sig !== expected) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const event = req.headers.get('x-github-event');
  if (event !== 'workflow_run') {
    return Response.json({ ok: true, skipped: `event: ${event}` });
  }

  const payload = JSON.parse(body) as {
    action?: string;
    workflow_run?: {
      id: number;
      name: string;
      conclusion: string | null;
      html_url: string;
      head_commit?: { id?: string; message?: string };
      repository?: { full_name?: string };
    };
  };

  if (payload.action !== 'completed' || payload.workflow_run?.conclusion !== 'failure') {
    return Response.json({ ok: true, skipped: 'not a failure' });
  }

  const run = payload.workflow_run;
  console.log('[webhook/github-actions] Workflow failure:', run.name, run.id);

  // Record in incidents table
  try {
    await sql`
      INSERT INTO incidents (org_id, pipeline_name, failure_type, occurred_at)
      VALUES ('default', ${run.name}, 'unknown', now())
      ON CONFLICT DO NOTHING
    `;
  } catch { /* non-critical */ }

  // TODO: Wire up full triage pipeline:
  // 1. Call resolveRunId(String(run.id)) to get enriched context
  // 2. Call streamText with tools + system prompt
  // 3. Post result to Slack via postTriageReport()
  // Pattern is identical to the Dagster webhook stub

  await postTriageReport(
    `GitHub Actions workflow "${run.name}" failed. Run ID: ${run.id}. Check ${run.html_url}`,
    run.name
  );

  return Response.json({
    received: true,
    workflowName: run.name,
    runId: run.id,
    status: 'logged — full triage pipeline TODO',
  });
}
