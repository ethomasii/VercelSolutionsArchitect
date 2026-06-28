import Link from 'next/link';

// Server Component — reads env vars at request time to show real connection status
export default function IntegrationsPage() {
  const integrations = getIntegrationStatus();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition">← Dispatch</Link>
          <span className="text-zinc-700">/</span>
          <span className="text-sm font-medium text-zinc-300">Integrations</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-700">
            {integrations.filter(i => i.status === 'connected').length} of {integrations.length} connected
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">Integrations</h1>
          <p className="text-sm text-zinc-500 max-w-2xl">
            Connect your data stack to unlock real-time context. Every integration lives behind a
            single{' '}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-400">execute()</code>
            {' '}function in{' '}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-400">lib/integrations/</code>
            — wiring up the real API is a one-file change.
          </p>
        </div>

        {/* Status summary bar */}
        <div className="mb-8 flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-4">
          <StatusDot status="connected" />
          <div>
            <p className="text-sm font-medium text-zinc-200">
              {integrations.filter(i => i.status === 'connected').length} integrations active
            </p>
            <p className="text-xs text-zinc-500 mt-0.5">
              {integrations.filter(i => i.status === 'simulated').length} simulated with seed data ·{' '}
              {integrations.filter(i => i.status === 'disabled').length} not configured
            </p>
          </div>
        </div>

        {/* Integration cards */}
        <div className="space-y-3">
          {integrations.map(integration => (
            <IntegrationCard key={integration.id} {...integration} />
          ))}
        </div>

        {/* Dagster MCP callout */}
        <div className="mt-8 rounded-xl border border-blue-500/20 bg-blue-950/10 p-5">
          <div className="flex items-start gap-3">
            <span className="text-xl mt-0.5">🔮</span>
            <div>
              <h3 className="text-sm font-semibold text-blue-300 mb-1">Dagster MCP Server — Cross-Pipeline Context</h3>
              <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                Dagster exposes an{' '}
                <a href="https://docs.dagster.io/guides/operate/model-context-protocol" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                  official MCP server
                </a>{' '}
                that gives Dispatch something no other integration can: visibility across your entire
                asset graph. When{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs font-mono text-zinc-400">dbt_customers_transform</code>{' '}
                fails, Dispatch could query Dagster to see that{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs font-mono text-zinc-400">fivetran_orders_daily</code>{' '}
                failed 20 minutes earlier — identifying the upstream root cause before the on-call
                engineer even looks at the dbt error.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                {[
                  { icon: '🔗', text: 'Asset dependency graph traversal' },
                  { icon: '📋', text: 'Full run logs across all assets' },
                  { icon: '⬆️', text: 'Upstream failure detection' },
                  { icon: '⚡', text: 'Run failure sensor → auto-triage' },
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-zinc-400">
                    <span>{item.icon}</span>
                    <span>{item.text}</span>
                  </div>
                ))}
              </div>
              <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-3">
                <p className="text-xs text-zinc-500 mb-1.5 font-medium">To enable Dagster MCP in Cursor / Dispatch:</p>
                <pre className="text-xs font-mono text-zinc-400 leading-relaxed">{`# .cursor/mcp.json
{
  "dagster": {
    "command": "uvx",
    "args": ["dagster-mcp"],
    "env": {
      "DAGSTER_URL": "https://your-dagster-host.com",
      "DAGSTER_TOKEN": "your-token"
    }
  }
}

# lib/integrations/dagster.ts: replace getRunStatus() body
# with real Dagster GraphQL queries via the MCP server`}</pre>
              </div>
            </div>
          </div>
        </div>

        {/* Full log handling note */}
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
          <div className="flex items-start gap-3">
            <span className="text-xl mt-0.5">📄</span>
            <div>
              <h3 className="text-sm font-semibold text-zinc-200 mb-1">Full Log Handling</h3>
              <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                Production Dagster logs contain thousands of lines across multiple assets. Dispatch
                handles this in two ways today — and has a clear upgrade path to full log analysis:
              </p>
              <div className="space-y-2">
                {[
                  {
                    status: 'done',
                    label: 'Structured extraction',
                    desc: 'classifyFailure extracts key error signals from any log size — the model finds the relevant error in even a 10k-line log',
                  },
                  {
                    status: 'done',
                    label: 'Upstream failure cross-reference',
                    desc: 'lookupIncidentHistory now checks for related failures across all pipelines in the same time window',
                  },
                  {
                    status: 'upgrade',
                    label: 'Full asset graph traversal',
                    desc: 'With Dagster MCP: traverse the asset dependency graph to find the first failing upstream node, not just the reported failure',
                  },
                  {
                    status: 'upgrade',
                    label: 'Log chunking for very large runs',
                    desc: 'For runs > 50k tokens: chunk logs by asset, summarize each chunk, then synthesize — built on the same streamText + tools pattern',
                  },
                ].map((item, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className={`shrink-0 mt-0.5 text-xs ${item.status === 'done' ? 'text-green-500' : 'text-zinc-600'}`}>
                      {item.status === 'done' ? '✓' : '◦'}
                    </span>
                    <div>
                      <span className="text-xs font-medium text-zinc-300">{item.label}</span>
                      <span className="text-xs text-zinc-600"> — {item.desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// Integration status logic (server-side env var check)
// -------------------------------------------------------------------
type IntegrationStatus = 'connected' | 'simulated' | 'disabled';

interface Integration {
  id: string;
  icon: string;
  name: string;
  status: IntegrationStatus;
  description: string;
  dataProvided: string[];
  envVars: string[];
  file: string;
  setupNote?: string;
}

function getIntegrationStatus(): Integration[] {
  return [
    {
      id: 'neon',
      icon: '🐘',
      name: 'Neon Postgres',
      status: process.env.DATABASE_URL ? 'connected' : 'disabled',
      description: 'Runbooks, incident history, git context, eval cases',
      dataProvided: ['Runbook search', 'Incident history (90 days)', 'Simulated git context', 'pgvector for semantic search (ready)'],
      envVars: ['DATABASE_URL'],
      file: 'lib/db.ts',
    },
    {
      id: 'ai-gateway',
      icon: '🔀',
      name: 'Vercel AI Gateway',
      status: process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY ? 'connected' : 'disabled',
      description: 'Model routing, provider fallback, cost tracking, latency observability',
      dataProvided: ['openai/gpt-5.4 primary model', 'anthropic/claude-haiku-4.5 fallback', 'Token cost tracking', 'Latency traces per tool call'],
      envVars: ['VERCEL_OIDC_TOKEN (auto via vercel env pull)', 'AI_GATEWAY_API_KEY (alternative)'],
      file: 'lib/models.ts',
      setupNote: 'vercel env pull .env.local',
    },
    {
      id: 'dagster',
      icon: '⚡',
      name: 'Dagster',
      status: process.env.DAGSTER_HOST ? 'connected' : 'simulated',
      description: 'Run logs, asset materialization status, upstream failure detection',
      dataProvided: [
        'Real run logs and failure descriptions',
        'Asset dependency graph (upstream root cause)',
        'Run failure sensor → automatic triage webhook',
        'Cross-pipeline failure correlation',
      ],
      envVars: ['DAGSTER_HOST', 'DAGSTER_TOKEN'],
      file: 'lib/integrations/dagster.ts',
      setupNote: 'Dagster MCP server available — see callout below',
    },
    {
      id: 'github',
      icon: '🔀',
      name: 'GitHub',
      status: process.env.GITHUB_TOKEN ? 'connected' : 'simulated',
      description: 'Recent commits and PRs that may have caused failures',
      dataProvided: [
        'Real commit history for affected files',
        'PR diffs and merge timestamps',
        'Author context for code changes',
        'File-level blame for breaking changes',
      ],
      envVars: ['GITHUB_TOKEN'],
      file: 'lib/integrations/github.ts',
      setupNote: 'GitHub → Settings → Developer settings → Personal access tokens',
    },
    {
      id: 'slack',
      icon: '💬',
      name: 'Slack',
      status: process.env.SLACK_WEBHOOK_URL ? 'connected' : 'disabled',
      description: 'Post triage reports to #data-alerts automatically',
      dataProvided: [
        'Auto-post on Dagster run failure',
        'Manual "Share to Slack" from triage UI',
        'Formatted report with runbook and remediation steps',
      ],
      envVars: ['SLACK_WEBHOOK_URL'],
      file: 'lib/integrations/slack.ts',
      setupNote: 'Slack → Your workspace → Apps → Incoming Webhooks',
    },
    {
      id: 'confluence',
      icon: '📖',
      name: 'Confluence',
      status: process.env.CONFLUENCE_BASE_URL ? 'connected' : 'disabled',
      description: 'Search external team runbooks alongside internal ones',
      dataProvided: [
        'Fan-out runbook search to Confluence spaces',
        'Merged results with internal runbooks',
        'Self-improving: Dispatch gets smarter as team updates docs',
      ],
      envVars: ['CONFLUENCE_BASE_URL', 'CONFLUENCE_TOKEN', 'CONFLUENCE_SPACE_KEY'],
      file: 'lib/integrations/confluence.ts',
      setupNote: 'Confluence → Profile → Manage account → Security → API tokens',
    },
    {
      id: 'pagerduty',
      icon: '🔔',
      name: 'PagerDuty',
      status: 'disabled',
      description: 'Trigger incidents and check on-call schedule',
      dataProvided: [
        'Auto-page on High confidence failures',
        'Check who is on-call before escalating',
        'Link triage report to incident',
      ],
      envVars: ['PAGERDUTY_API_KEY', 'PAGERDUTY_SERVICE_ID'],
      file: 'lib/integrations/pagerduty.ts',
      setupNote: 'Add lib/integrations/pagerduty.ts — same pattern as slack.ts',
    },
  ];
}

// -------------------------------------------------------------------
// Card component
// -------------------------------------------------------------------
function IntegrationCard(props: Integration) {
  const { icon, name, status, description, dataProvided, envVars, file, setupNote } = props;

  return (
    <div className={`rounded-xl border px-5 py-4 ${
      status === 'connected' ? 'border-green-800/40 bg-green-950/10' :
      status === 'simulated' ? 'border-amber-800/30 bg-amber-950/5' :
      'border-zinc-800 bg-zinc-900/20'
    }`}>
      <div className="flex items-start gap-3">
        <span className="text-xl mt-0.5">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-zinc-200">{name}</h3>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-500 mb-3">{description}</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Data provided */}
            <div>
              <p className="text-xs font-medium text-zinc-600 mb-1.5">Provides</p>
              <ul className="space-y-0.5">
                {dataProvided.map((d, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-500">
                    <span className={`mt-0.5 shrink-0 ${status === 'connected' ? 'text-green-600' : status === 'simulated' ? 'text-amber-600' : 'text-zinc-700'}`}>•</span>
                    {d}
                  </li>
                ))}
              </ul>
            </div>

            {/* Setup */}
            <div>
              <p className="text-xs font-medium text-zinc-600 mb-1.5">
                {status === 'connected' ? 'Configured' : 'Setup'}
              </p>
              <div className="space-y-1">
                {envVars.map((v, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                      status === 'connected' ? 'bg-green-500' :
                      v.toLowerCase().includes('auto') ? 'bg-zinc-600' :
                      'bg-zinc-700'
                    }`} />
                    <code className="text-xs font-mono text-zinc-500">{v.split(' (')[0]}</code>
                    {v.includes('(') && <span className="text-xs text-zinc-700">{v.match(/\(([^)]+)\)/)?.[0]}</span>}
                  </div>
                ))}
                <p className="text-xs text-zinc-700 mt-1">
                  → <code className="font-mono">{file}</code>
                </p>
                {setupNote && status !== 'connected' && (
                  <p className="text-xs text-zinc-600 mt-1 italic">{setupNote}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: IntegrationStatus }) {
  if (status === 'connected')
    return <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-400"><span className="h-1.5 w-1.5 rounded-full bg-green-500" />Connected</span>;
  if (status === 'simulated')
    return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />Simulated</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-500"><span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />Not configured</span>;
}

function StatusDot({ status }: { status: IntegrationStatus }) {
  const colors = { connected: 'bg-green-500', simulated: 'bg-amber-500', disabled: 'bg-zinc-600' };
  return <span className={`h-2.5 w-2.5 rounded-full ${colors[status]} shrink-0`} />;
}
