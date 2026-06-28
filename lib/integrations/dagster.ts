// Today returns null (no live Dagster connection in the demo).
// Real implementation: Dagster GraphQL API at https://<your-dagster-host>/graphql
//
// Key query — RunLogsQuery:
//   query RunLogsQuery($runId: ID!) {
//     pipelineRunOrError(runId: $runId) {
//       ... on PipelineRun {
//         id, status, startTime, endTime
//         tags { key value }
//         assetMaterializations { ... }
//         failureMetadata { description }
//       }
//     }
//   }
//
// Requires: DAGSTER_TOKEN env var, DAGSTER_HOST env var.
// Note: If on Dagster+, use the Cloud API instead of self-hosted GraphQL.

export interface DagsterRunResult {
  runId: string | null;
  status: string | null;
  assetKey: string | null;
  failureDescription: string | null;
  startTime: string | null;
  source: 'live' | 'unavailable';
}

export async function getRunStatus(runId: string): Promise<DagsterRunResult> {
  if (!process.env.DAGSTER_HOST || !process.env.DAGSTER_TOKEN) {
    return {
      runId,
      status: null,
      assetKey: null,
      failureDescription: null,
      startTime: null,
      source: 'unavailable',
    };
  }

  // TODO: Replace with real Dagster GraphQL call
  // const response = await fetch(`${process.env.DAGSTER_HOST}/graphql`, {
  //   method: 'POST',
  //   headers: {
  //     'Content-Type': 'application/json',
  //     'Dagster-Cloud-Api-Token': process.env.DAGSTER_TOKEN,
  //   },
  //   body: JSON.stringify({ query: RUN_LOGS_QUERY, variables: { runId } }),
  // });

  return {
    runId,
    status: null,
    assetKey: null,
    failureDescription: null,
    startTime: null,
    source: 'unavailable',
  };
}
