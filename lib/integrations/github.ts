import { sql } from '../db';

// Today this reads from the git_context Neon table (source='simulated').
// Real implementation: replace the Neon query with octokit calls:
//   - repos.listCommits({ owner, repo, path, since })
//   - pulls.list({ state: 'closed', sort: 'updated' })
// Filter to files matching the pipeline name. Same return shape, same tool interface.
// Requires: GITHUB_TOKEN env var, repo owner/name in env or per-org config.

export interface GitResult {
  commits: Array<{
    sha: string;
    message: string;
    author: string;
    files: string[];
    committedAt: string;
    isLikelyCause: boolean;
  }>;
  pullRequests: Array<{
    number: number;
    title: string;
    author: string;
    mergedAt: string | null;
    files: string[];
  }>;
  source: 'simulated' | 'github_api';
}

export async function getRecentChanges(
  pipelineName: string,
  hoursBack: number,
  orgId: string = 'default'
): Promise<GitResult> {
  // TODO: Replace with real GitHub API call using octokit
  // For now: query git_context table in Neon
  const rows = await sql`
    SELECT * FROM git_context
    WHERE org_id = ${orgId}
      AND pipeline_name = ${pipelineName}
      AND committed_at > now() - (${hoursBack} || ' hours')::interval
    ORDER BY committed_at DESC
  `;

  return {
    commits: rows.map(r => ({
      sha: r.commit_sha ?? '',
      message: r.pr_title ?? '',
      author: r.author ?? '',
      files: r.changed_files ?? [],
      committedAt: r.committed_at,
      isLikelyCause: r.is_likely_cause ?? false,
    })),
    pullRequests: rows
      .filter(r => r.pr_number)
      .map(r => ({
        number: r.pr_number,
        title: r.pr_title ?? '',
        author: r.author ?? '',
        mergedAt: r.committed_at,
        files: r.changed_files ?? [],
      })),
    source: 'simulated',
  };
}
