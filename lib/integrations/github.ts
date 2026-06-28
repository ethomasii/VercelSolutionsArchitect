import { getSetting, getIntegrationSettings } from '../settings';

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
  // File content for the likely-cause files — lets agent see the exact broken line
  fileSnippets?: Array<{
    path: string;
    content: string;
    repo: string;
  }>;
  source: 'simulated' | 'github_api';
}

// Read a file from any configured GitHub repo instance.
// Used for: reading dbt sources.yml for lineage, reading the exact broken SQL model,
// reading Dagster asset definitions to understand dependencies.
export async function readRepoFile(
  filePath: string,
  instanceName = 'default'
): Promise<{ content: string; sha: string; repo: string } | null> {
  const token = await getSetting('github', 'GITHUB_TOKEN', instanceName);
  const owner = await getSetting('github', 'GITHUB_REPO_OWNER', instanceName);
  const repo = await getSetting('github', 'GITHUB_REPO_NAME', instanceName);

  if (!token || !owner || !repo) return null;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as { content?: string; sha?: string };
    const content = data.content
      ? Buffer.from(data.content, 'base64').toString('utf8')
      : '';
    return { content, sha: data.sha ?? '', repo: `${owner}/${repo}` };
  } catch {
    return null;
  }
}

// Search for a file pattern across a repo — used to find sources.yml, schema.yml etc.
export async function searchRepoFiles(
  query: string,
  extension: string,
  instanceName = 'default'
): Promise<Array<{ path: string; url: string }>> {
  const token = await getSetting('github', 'GITHUB_TOKEN', instanceName);
  const owner = await getSetting('github', 'GITHUB_REPO_OWNER', instanceName);
  const repo = await getSetting('github', 'GITHUB_REPO_NAME', instanceName);

  if (!token || !owner || !repo) return [];

  try {
    const q = encodeURIComponent(`${query} extension:${extension} repo:${owner}/${repo}`);
    const res = await fetch(`https://api.github.com/search/code?q=${q}&per_page=5`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { items?: Array<{ path: string; html_url: string }> };
    return (data.items ?? []).map(i => ({ path: i.path, url: i.html_url }));
  } catch {
    return [];
  }
}

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
  // Try real GitHub API first (works across all configured repo instances)
  const token = await getSetting('github', 'GITHUB_TOKEN', 'default');
  const owner = await getSetting('github', 'GITHUB_REPO_OWNER', 'default');
  const repo = await getSetting('github', 'GITHUB_REPO_NAME', 'default');

  if (token && owner && repo) {
    return fetchRealGitContext(pipelineName, hoursBack, token, owner, repo);
  }

  // Fall back to simulated data from Neon
  const { sql } = await import('../db');
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

async function fetchRealGitContext(
  pipelineName: string,
  hoursBack: number,
  token: string,
  owner: string,
  repo: string
): Promise<GitResult> {
  const since = new Date(Date.now() - hoursBack * 3600000).toISOString();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  try {
    // Search for merged PRs that touched files related to this pipeline
    const searchTerms = pipelineName.split('_').filter(w => w.length > 3).join('+');
    const prRes = await fetch(
      `${base}/pulls?state=closed&sort=updated&direction=desc&per_page=10`,
      { headers, signal: AbortSignal.timeout(8000) }
    );
    const prs = prRes.ok ? await prRes.json() as Array<{
      number: number; title: string; user: { login: string };
      merged_at: string | null; head: { sha: string };
    }> : [];

    // Filter to PRs merged in the hoursBack window
    const recentPRs = prs.filter(pr => pr.merged_at && new Date(pr.merged_at) > new Date(since));

    // Get file changes for recent PRs
    const commits: GitResult['commits'] = [];
    const pullRequests: GitResult['pullRequests'] = [];
    const fileSnippets: GitResult['fileSnippets'] = [];

    for (const pr of recentPRs.slice(0, 5)) {
      const filesRes = await fetch(`${base}/pulls/${pr.number}/files?per_page=20`, {
        headers, signal: AbortSignal.timeout(6000),
      });
      const files = filesRes.ok ? await filesRes.json() as Array<{ filename: string }> : [];
      const filePaths = files.map(f => f.filename);

      // Check if this PR is likely the cause (touches pipeline-relevant files)
      const isLikelyCause = filePaths.some(f =>
        f.includes(pipelineName.replace(/_/g, '/')) ||
        f.includes(pipelineName.replace(/_/g, '-')) ||
        f.toLowerCase().includes(pipelineName.split('_')[1] ?? '')
      );

      commits.push({
        sha: pr.head.sha.slice(0, 7),
        message: pr.title,
        author: pr.user.login,
        files: filePaths,
        committedAt: pr.merged_at ?? new Date().toISOString(),
        isLikelyCause,
      });

      pullRequests.push({
        number: pr.number,
        title: pr.title,
        author: pr.user.login,
        mergedAt: pr.merged_at,
        files: filePaths,
      });

      // For likely-cause PRs, fetch content of relevant SQL/YAML files
      if (isLikelyCause) {
        for (const filePath of filePaths.filter(f => f.endsWith('.sql') || f.endsWith('.yml')).slice(0, 2)) {
          const fileData = await readRepoFile(filePath);
          if (fileData) {
            fileSnippets.push({
              path: filePath,
              content: fileData.content.slice(0, 800) + (fileData.content.length > 800 ? '\n...' : ''),
              repo: `${owner}/${repo}`,
            });
          }
        }
      }
    }

    return { commits, pullRequests, fileSnippets, source: 'github_api' };
  } catch (err) {
    console.warn('[github] fetchRealGitContext failed:', err);
    return { commits: [], pullRequests: [], source: 'github_api' };
  }
}
