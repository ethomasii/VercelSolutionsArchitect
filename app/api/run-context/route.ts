import { resolveRunId } from '@/lib/run-context';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const { runId } = await req.json();

  if (!runId || typeof runId !== 'string') {
    return Response.json({ error: 'runId is required' }, { status: 400 });
  }

  const context = await resolveRunId(runId.trim());

  if (!context) {
    return Response.json({
      error: `Unknown run ID: ${runId}. Try one of the sample IDs or wire up a real orchestrator API.`,
      suggestion: 'For Dagster: set DAGSTER_HOST + DAGSTER_TOKEN. For dbt Cloud: set DBT_CLOUD_API_KEY.',
    }, { status: 404 });
  }

  return Response.json(context);
}
