import { postTriageReport } from '@/lib/integrations/slack';

// This route makes Dispatch proactive rather than reactive.
// When wired to a Dagster run failure sensor, Dispatch automatically triages
// every failure and posts to Slack before the on-call engineer opens their laptop.
//
// Dagster sensor setup (in your Dagster repo):
//   @run_failure_sensor(request_external_resources=True)
//   def dispatch_triage_sensor(context: RunFailureSensorContext):
//       requests.post(
//           "https://your-dispatch.vercel.app/api/webhooks/dagster",
//           json={
//               "runId": context.pipeline_run.run_id,
//               "pipelineName": context.pipeline_run.pipeline_name,
//               "errorMessage": str(context.failure_event.message),
//               "timestamp": context.failure_event.timestamp,
//           },
//           headers={"Authorization": f"Bearer {os.environ['DISPATCH_WEBHOOK_SECRET']}"}
//       )

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  const secret = process.env.DISPATCH_WEBHOOK_SECRET;

  // Always validate webhook signatures. Even in a stub.
  // This habit prevents the embarrassing situation where you stub auth
  // and forget to add it before going to production.
  if (secret && authHeader !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const { runId, pipelineName, errorMessage } = body;

  console.log('[webhook/dagster] Run failure received:', {
    runId,
    pipelineName,
    errorMessage: errorMessage?.slice(0, 200),
  });

  // TODO: Wire up the full triage pipeline here:
  // 1. Call streamText with the same tools + system prompt as chat/route.ts
  // 2. Accumulate the streamed response into a string
  // 3. Post to Slack via postTriageReport()
  // 4. Store the incident in Neon incidents table with dagster_run_id

  await postTriageReport(
    `Webhook received for run ${runId} — triage pipeline not yet implemented`,
    pipelineName ?? 'unknown'
  );

  return Response.json({
    received: true,
    runId,
    pipelineName,
    status: 'webhook_stub_not_yet_implemented',
  });
}
