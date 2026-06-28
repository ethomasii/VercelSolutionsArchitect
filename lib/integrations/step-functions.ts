// AWS Step Functions integration.
//
// Real implementation uses AWS SDK:
//   @aws-sdk/client-sfn: GetExecutionHistory → all state machine events
//   @aws-sdk/client-cloudwatch-logs: GetLogEvents → step-level logs
//
// Run ID format: ARN (arn:aws:states:us-east-1:123456789:execution:PipelineName:run-id)
//   OR short form: sfn:{execution-name} (Dispatch-specific shorthand)
//
// EventBridge rule to trigger Dispatch on failure:
//   {
//     "source": ["aws.states"],
//     "detail-type": ["Step Functions Execution Status Change"],
//     "detail": { "status": ["FAILED", "TIMED_OUT", "ABORTED"] }
//   }
// → POST to https://dispatch-triage.vercel.app/api/webhooks/step-functions
//
// Lineage context: Step Functions state machine definition (from CloudFormation /
// CDK) defines the DAG. Not as rich as Dagster asset graph, but traversable.

import { getSetting } from '../settings';

export interface StepFunctionsResult {
  executionArn: string | null;
  stateMachineName: string | null;
  status: string | null;
  startDate: string | null;
  stopDate: string | null;
  failedState: string | null;
  failedCause: string | null;
  failedError: string | null;
  recentEvents: Array<{ type: string; timestamp: string; stateEnteredData?: string; cause?: string }>;
  source: 'live' | 'unavailable';
}

export async function getExecution(
  executionArn: string,
  _instanceName = 'default'
): Promise<StepFunctionsResult> {
  // Real implementation: use @aws-sdk/client-sfn
  // const { SFNClient, GetExecutionHistoryCommand, DescribeExecutionCommand } = await import('@aws-sdk/client-sfn');
  // const client = new SFNClient({ region: process.env.AWS_REGION });
  //
  // const [exec, history] = await Promise.all([
  //   client.send(new DescribeExecutionCommand({ executionArn })),
  //   client.send(new GetExecutionHistoryCommand({ executionArn, maxResults: 50, reverseOrder: true })),
  // ]);
  //
  // const failedEvent = history.events?.find(e => e.type === 'ExecutionFailed');
  // return { ... };

  const awsKeyId = await getSetting('step-functions', 'AWS_ACCESS_KEY_ID');
  if (!awsKeyId) {
    return {
      executionArn, stateMachineName: null, status: null,
      startDate: null, stopDate: null, failedState: null,
      failedCause: null, failedError: null, recentEvents: [],
      source: 'unavailable',
    };
  }

  // With real AWS credentials: implement DescribeExecution + GetExecutionHistory
  // For now: return unavailable (real implementation requires @aws-sdk/client-sfn)
  return {
    executionArn, stateMachineName: null, status: null,
    startDate: null, stopDate: null, failedState: null,
    failedCause: null, failedError: null, recentEvents: [],
    source: 'unavailable',
  };
}
