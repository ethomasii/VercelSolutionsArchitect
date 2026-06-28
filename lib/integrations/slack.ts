// Posts the triage report to a Slack channel.
// Used by two surfaces:
//   1. The Dagster webhook route (/api/webhooks/dagster) — automatic triage on failure
//   2. A "Share to Slack" button in the triage UI — manual share
//
// Real implementation: Slack Incoming Webhook (simplest) or Bot Token + chat.postMessage
// Requires: SLACK_WEBHOOK_URL env var (or SLACK_BOT_TOKEN + SLACK_CHANNEL_ID)
//
// This integration makes Dispatch proactive, not just reactive. When a Dagster
// run fails, the webhook fires, Dispatch triages automatically, and posts to
// #data-alerts before the on-call engineer even opens their laptop.

export async function postTriageReport(
  report: string,
  pipelineName: string,
  _channelId?: string
): Promise<{ ok: boolean; ts?: string }> {
  if (!process.env.SLACK_WEBHOOK_URL) {
    console.log('[slack] No webhook configured, skipping post');
    return { ok: false };
  }

  // TODO: Replace with real Slack API call
  // const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     text: `*Dispatch Triage: ${pipelineName}*\n${report}`,
  //     unfurl_links: false,
  //   }),
  // });
  // return { ok: response.ok };

  console.log(`[slack] Would post triage for ${pipelineName}: ${report.slice(0, 100)}...`);
  return { ok: false };
}
