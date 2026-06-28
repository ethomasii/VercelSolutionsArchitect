// GitHub Actions integration — uses GITHUB_TOKEN (same credential as git context).
//
// Real implementation uses GitHub REST API:
//   GET /repos/{owner}/{repo}/actions/runs/{run_id}       → run metadata
//   GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs  → steps + status
//   GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs  → full log text
//
// Run ID format: numeric (e.g. 9012345678)
// Detection: /^\d{9,12}$/ — numeric IDs in that range are GitHub Actions runs
//
// Data pipelines commonly run as GitHub Actions:
//   - dbt runs triggered on merge to main
//   - Fivetran triggers via API call in workflow  
//   - Python ETL scripts as workflow steps
//   - Data validation workflows

import { getSetting } from '../settings';

export interface GitHubActionsRunResult {
  runId: string;
  status: string | null;
  conclusion: string | null;
  workflowName: string | null;
  repoFullName: string | null;
  headCommitMessage: string | null;
  headSha: string | null;
  triggeredBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedJobs: Array<{
    id: number;
    name: string;
    conclusion: string | null;
    failedSteps: Array<{ name: string; conclusion: string }>;
  }>;
  source: 'live' | 'unavailable';
}

export async function getWorkflowRun(
  runId: string,
  instanceName = 'default'
): Promise<GitHubActionsRunResult> {
  const token = await getSetting('github', 'GITHUB_TOKEN', instanceName);
  const owner = await getSetting('github', 'GITHUB_REPO_OWNER', instanceName);
  const repo = await getSetting('github', 'GITHUB_REPO_NAME', instanceName);

  if (!token || !owner || !repo) {
    return {
      runId, status: null, conclusion: null, workflowName: null,
      repoFullName: null, headCommitMessage: null, headSha: null,
      triggeredBy: null, startedAt: null, completedAt: null,
      failedJobs: [], source: 'unavailable',
    };
  }

  try {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    // Get run metadata
    const runRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`,
      { headers, signal: AbortSignal.timeout(8000) }
    );
    if (!runRes.ok) throw new Error(`GitHub API ${runRes.status}`);
    const run = await runRes.json() as {
      status?: string; conclusion?: string; name?: string;
      repository?: { full_name?: string };
      head_commit?: { message?: string; id?: string };
      triggering_actor?: { login?: string };
      run_started_at?: string; updated_at?: string;
    };

    // Get jobs to find failed steps
    const jobsRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
      { headers, signal: AbortSignal.timeout(8000) }
    );
    const jobsData = await jobsRes.json() as {
      jobs?: Array<{
        id: number; name: string; conclusion: string | null;
        steps?: Array<{ name: string; conclusion: string | null }>;
      }>;
    };

    const failedJobs = (jobsData.jobs ?? [])
      .filter(j => j.conclusion === 'failure')
      .map(j => ({
        id: j.id,
        name: j.name,
        conclusion: j.conclusion,
        failedSteps: (j.steps ?? [])
          .filter(s => s.conclusion === 'failure')
          .map(s => ({ name: s.name, conclusion: s.conclusion ?? 'failure' })),
      }));

    return {
      runId,
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      workflowName: run.name ?? null,
      repoFullName: run.repository?.full_name ?? `${owner}/${repo}`,
      headCommitMessage: run.head_commit?.message?.split('\n')[0] ?? null,
      headSha: run.head_commit?.id?.slice(0, 7) ?? null,
      triggeredBy: run.triggering_actor?.login ?? null,
      startedAt: run.run_started_at ?? null,
      completedAt: run.updated_at ?? null,
      failedJobs,
      source: 'live',
    };
  } catch (err) {
    console.warn('[github-actions] getWorkflowRun failed:', err);
    return {
      runId, status: null, conclusion: null, workflowName: null,
      repoFullName: null, headCommitMessage: null, headSha: null,
      triggeredBy: null, startedAt: null, completedAt: null,
      failedJobs: [], source: 'unavailable',
    };
  }
}
