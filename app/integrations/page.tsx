import Link from 'next/link';

export default function IntegrationsPage() {
  const integrations = getIntegrationStatus();
  const connected = integrations.filter(i => i.status === 'connected').length;
  const simulated = integrations.filter(i => i.status === 'simulated').length;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition">← Dispatch</Link>
          <span className="text-zinc-700">/</span>
          <span className="text-sm font-medium text-zinc-300">Integrations</span>
        </div>
        <span className="text-xs text-zinc-700">{connected} connected · {simulated} simulated</span>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">Integrations</h1>
          <p className="text-sm text-zinc-500 max-w-2xl">
            Every integration lives behind an{' '}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-400">execute()</code>
            {' '}function in{' '}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-400">lib/integrations/</code>.
            Wiring up a real API is a one-file change. Each integration unlocks a different layer of context.
          </p>
        </div>

        {/* Groups */}
        {INTEGRATION_GROUPS.map(group => {
          const groupIntegrations = integrations.filter(i => i.group === group.id);
          return (
            <div key={group.id} className="mb-8">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-base">{group.icon}</span>
                <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">{group.label}</h2>
                <span className="text-xs text-zinc-700">{group.description}</span>
              </div>
              <div className="space-y-2">
                {groupIntegrations.map(integration => (
                  <IntegrationCard key={integration.id} {...integration} />
                ))}
              </div>
            </div>
          );
        })}

        {/* Dagster MCP deep-dive */}
        <div className="mt-4 rounded-xl border border-blue-500/20 bg-blue-950/10 p-5">
          <div className="flex items-start gap-3">
            <span className="text-xl mt-0.5">🔮</span>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-blue-300 mb-1">
                Dagster MCP — The Cross-Pipeline Context Layer
              </h3>
              <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                Dagster exposes a{' '}
                <a href="https://docs.dagster.io/guides/operate/model-context-protocol" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                  remote MCP server
                </a>{' '}
                that gives Dispatch visibility across your entire asset graph. When{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs font-mono text-zinc-400">dbt_customers_transform</code>{' '}
                fails, Dispatch can traverse the dependency graph to find that{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs font-mono text-zinc-400">fivetran_orders_daily</code>{' '}
                failed upstream — even if the dbt error log has no mention of Fivetran.
              </p>

              <div className="grid grid-cols-2 gap-3 mb-4">
                {[
                  { icon: '🔗', title: 'Asset dependency traversal', desc: 'Find the first failing upstream node, not just the reported failure' },
                  { icon: '📋', title: 'Full run logs', desc: 'All asset materializations in a run — not just the error snippet' },
                  { icon: '⬆️', title: 'Cross-pipeline correlation', desc: 'Was something else running that caused resource contention?' },
                  { icon: '⚡', title: 'Run failure sensor', desc: 'Webhook to auto-triage every failure before on-call opens laptop' },
                ].map((item, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
                    <span className="text-sm">{item.icon}</span>
                    <div>
                      <p className="text-xs font-medium text-zinc-300">{item.title}</p>
                      <p className="text-xs text-zinc-600 mt-0.5">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-3">
                <p className="text-xs font-medium text-zinc-400 mb-2">Connect to Dagster+ MCP:</p>
                <pre className="text-xs font-mono text-zinc-500 leading-relaxed whitespace-pre-wrap">{`# 1. Get token: Dagster+ → Admin → User Tokens → Create token
# 2. Add to .cursor/mcp.json (already done — fill in your credentials):

{
  "dagster": {
    "url": "https://mcp.agent.dagster.cloud/mcp/",
    "headers": {
      "Authorization": "Bearer YOUR_DAGSTER_USER_TOKEN",
      "Dagster-Cloud-Organization": "YOUR_ORG_SLUG"
    }
  }
}

# 3. For Dispatch server-side context: set in Vercel env vars:
DAGSTER_HOST=https://your-org.dagster.cloud
DAGSTER_TOKEN=your-token
# → lib/integrations/dagster.ts will use these to fetch run context`}</pre>
              </div>
            </div>
          </div>
        </div>

        {/* Vendor status note */}
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
          <div className="flex items-start gap-3">
            <span className="text-xl mt-0.5">🌐</span>
            <div>
              <h3 className="text-sm font-semibold text-zinc-200 mb-1">Vendor Status — Live</h3>
              <p className="text-xs text-zinc-400 leading-relaxed mb-2">
                Dispatch now calls vendor status pages in real-time as part of triage (tool 5:{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs font-mono text-zinc-400">checkVendorStatus</code>
                ). If Fivetran or Snowflake is having an incident, the agent surfaces this before you spend 20 minutes debugging code.
              </p>
              <div className="flex flex-wrap gap-2">
                {['fivetran', 'snowflake', 'dbt cloud', 'databricks', 'stripe', 'github', 'shopify', 'salesforce', 'airflow'].map(v => (
                  <a key={v} href={`https://status.${v.replace(' ', '')}.com`} target="_blank" rel="noopener noreferrer"
                    className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-mono text-zinc-500 hover:text-zinc-300 transition capitalize">
                    {v}
                  </a>
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
// Integration groups and data
// -------------------------------------------------------------------
const INTEGRATION_GROUPS = [
  { id: 'core', icon: '🏗️', label: 'Core', description: '— always active' },
  { id: 'orchestration', icon: '⚡', label: 'Orchestration', description: '— cross-pipeline context' },
  { id: 'ingestion', icon: '📥', label: 'Ingestion / Sources', description: '— upstream failure detection' },
  { id: 'transformation', icon: '🔄', label: 'Transformation', description: '— dbt, Spark, Snowflake' },
  { id: 'knowledge', icon: '📖', label: 'Knowledge Base', description: '— runbooks, docs, incidents' },
  { id: 'alerting', icon: '🔔', label: 'Alerting / On-call', description: '— notifications and escalation' },
];

type IntegrationStatus = 'connected' | 'simulated' | 'disabled';

interface Integration {
  id: string; group: string; icon: string; name: string;
  status: IntegrationStatus; description: string;
  dataProvided: string[]; envVars: string[]; file: string;
  setupNote?: string; docsUrl?: string;
}

function getIntegrationStatus(): Integration[] {
  const env = (k: string) => !!process.env[k];
  return [
    // Core
    {
      id: 'neon', group: 'core', icon: '🐘', name: 'Neon Postgres',
      status: env('DATABASE_URL') ? 'connected' : 'disabled',
      description: 'Runbooks, incident history, git context, eval cases. pgvector ready for semantic search.',
      dataProvided: ['Runbook full-text search', '90-day incident history', 'Git context (simulated)', 'pgvector for semantic search (ready)'],
      envVars: ['DATABASE_URL'], file: 'lib/db.ts',
    },
    {
      id: 'ai-gateway', group: 'core', icon: '🔀', name: 'Vercel AI Gateway',
      status: env('VERCEL_OIDC_TOKEN') || env('AI_GATEWAY_API_KEY') ? 'connected' : 'disabled',
      description: 'Model routing, failover, cost tracking. OIDC auth — no key rotation needed.',
      dataProvided: ['openai/gpt-5.4 primary', 'anthropic/claude-haiku-4.5 fallback', 'Token cost per tool call', 'Latency traces'],
      envVars: ['VERCEL_OIDC_TOKEN (auto via vercel env pull)'], file: 'lib/models.ts',
      setupNote: 'vercel link && vercel env pull .env.local',
    },
    // Orchestration
    {
      id: 'dagster', group: 'orchestration', icon: '⚡', name: 'Dagster',
      status: env('DAGSTER_HOST') ? 'connected' : 'simulated',
      description: 'Run logs, asset graph traversal, upstream failure detection. Has MCP server.',
      dataProvided: ['Full run logs across all assets', 'Asset dependency graph (upstream root cause)', 'Cross-pipeline failure correlation', 'Run failure sensor → auto-triage'],
      envVars: ['DAGSTER_HOST', 'DAGSTER_TOKEN'], file: 'lib/integrations/dagster.ts',
      docsUrl: 'https://docs.dagster.io/guides/operate/model-context-protocol',
      setupNote: 'MCP: https://mcp.agent.dagster.cloud/mcp/ — see callout above',
    },
    {
      id: 'airflow', group: 'orchestration', icon: '🌬️', name: 'Airflow / Astronomer',
      status: env('AIRFLOW_HOST') ? 'connected' : 'disabled',
      description: 'DAG run context, task logs, resource contention across shared warehouses.',
      dataProvided: ['DAG run task statuses', 'Task-level logs', 'Concurrent job context', 'Schedule and retry history'],
      envVars: ['AIRFLOW_HOST', 'AIRFLOW_API_KEY'], file: 'lib/integrations/airflow.ts',
      setupNote: 'Airflow REST API v1: GET /api/v1/dags/{dag_id}/dagRuns/{run_id}/taskInstances',
    },
    {
      id: 'prefect', group: 'orchestration', icon: '🌀', name: 'Prefect',
      status: env('PREFECT_API_URL') ? 'connected' : 'disabled',
      description: 'Flow run context, task state, deployment history.',
      dataProvided: ['Flow run logs and state', 'Task-level error details', 'Deployment version context'],
      envVars: ['PREFECT_API_URL', 'PREFECT_API_KEY'], file: 'lib/integrations/prefect.ts',
      setupNote: 'Prefect Cloud: GET /api/flow_runs/{id}/logs',
    },
    // Ingestion
    {
      id: 'fivetran', group: 'ingestion', icon: '🔌', name: 'Fivetran',
      status: env('FIVETRAN_API_KEY') ? 'connected' : 'simulated',
      description: 'Connector sync status, row counts, schema changes, silent failures.',
      dataProvided: ['Connector last sync status', 'Rows loaded (detect 0-row silent failures)', 'Schema change history', 'Sync duration anomalies'],
      envVars: ['FIVETRAN_API_KEY', 'FIVETRAN_API_SECRET'], file: 'lib/integrations/fivetran.ts',
      setupNote: 'GET https://api.fivetran.com/v1/connectors/{id} — most critical integration after Dagster',
    },
    {
      id: 'airbyte', group: 'ingestion', icon: '🌊', name: 'Airbyte',
      status: env('AIRBYTE_API_KEY') ? 'connected' : 'disabled',
      description: 'Connection sync status, schema drift, catalog changes.',
      dataProvided: ['Sync job status and logs', 'Schema change notifications', 'Source/destination connection health'],
      envVars: ['AIRBYTE_API_URL', 'AIRBYTE_API_KEY'], file: 'lib/integrations/airbyte.ts',
    },
    // Transformation
    {
      id: 'snowflake', group: 'transformation', icon: '❄️', name: 'Snowflake',
      status: env('SNOWFLAKE_ACCOUNT') ? 'connected' : 'simulated',
      description: 'Query history, warehouse utilization, concurrent job detection, data freshness.',
      dataProvided: ['Query execution history', 'Warehouse credit consumption', 'Concurrent query contention detection', 'Table row count / freshness checks'],
      envVars: ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USER', 'SNOWFLAKE_PASSWORD', 'SNOWFLAKE_WAREHOUSE'], file: 'lib/integrations/snowflake.ts',
      setupNote: 'SELECT * FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY — gold mine for contention',
    },
    {
      id: 'dbt-cloud', group: 'transformation', icon: '🔄', name: 'dbt Cloud',
      status: env('DBT_CLOUD_API_KEY') ? 'connected' : 'disabled',
      description: 'Job run details, model test results, lineage, compilation errors.',
      dataProvided: ['Job run status and logs', 'Model-level test failures', 'Source freshness results', 'Lineage graph for impact analysis'],
      envVars: ['DBT_CLOUD_API_KEY', 'DBT_CLOUD_ACCOUNT_ID'], file: 'lib/integrations/dbt-cloud.ts',
      setupNote: 'GET /api/v2/accounts/{account_id}/runs/{run_id}/ — includes model-level test results',
    },
    {
      id: 'snowflake-cortex', group: 'transformation', icon: '🧠', name: 'Snowflake Cortex',
      status: env('SNOWFLAKE_ACCOUNT') ? 'connected' : 'disabled',
      description: 'Run SQL anomaly detection and data quality checks directly in Snowflake.',
      dataProvided: ['Anomaly detection on row counts / null rates', 'Semantic search over error messages in Snowflake', 'LLM-powered SQL generation for freshness checks'],
      envVars: ['SNOWFLAKE_ACCOUNT (same as Snowflake)'], file: 'lib/integrations/snowflake.ts',
      setupNote: 'SELECT SNOWFLAKE.CORTEX.COMPLETE(...) — runs in your Snowflake account, zero data egress',
    },
    // Knowledge
    {
      id: 'confluence', group: 'knowledge', icon: '📖', name: 'Confluence',
      status: env('CONFLUENCE_BASE_URL') ? 'connected' : 'disabled',
      description: 'Search external team runbooks and incident post-mortems alongside internal ones.',
      dataProvided: ['Fan-out runbook search to Confluence spaces', 'Merged and re-ranked results', 'Auto-improving: smarter as team updates docs'],
      envVars: ['CONFLUENCE_BASE_URL', 'CONFLUENCE_TOKEN', 'CONFLUENCE_SPACE_KEY'], file: 'lib/integrations/confluence.ts',
    },
    {
      id: 'notion', group: 'knowledge', icon: '📝', name: 'Notion',
      status: env('NOTION_API_KEY') ? 'connected' : 'disabled',
      description: 'Pull runbooks and incident post-mortems from Notion databases.',
      dataProvided: ['Runbook search in Notion databases', 'Incident history from Notion tables', 'On-call rotation info'],
      envVars: ['NOTION_API_KEY', 'NOTION_DATABASE_ID'], file: 'lib/integrations/notion.ts',
      setupNote: 'POST https://api.notion.com/v1/databases/{id}/query — same pattern as Confluence',
    },
    {
      id: 'github', group: 'knowledge', icon: '🐙', name: 'GitHub',
      status: env('GITHUB_TOKEN') ? 'connected' : 'simulated',
      description: 'Recent commits and PRs. Finds the code change that caused the failure.',
      dataProvided: ['Real commit history', 'PR diffs and merge timestamps', 'Author context', 'File-level blame'],
      envVars: ['GITHUB_TOKEN'], file: 'lib/integrations/github.ts',
    },
    // Alerting
    {
      id: 'slack', group: 'alerting', icon: '💬', name: 'Slack',
      status: env('SLACK_WEBHOOK_URL') ? 'connected' : 'disabled',
      description: 'Post triage reports to #data-alerts automatically on failure.',
      dataProvided: ['Auto-post on Dagster run failure', 'Manual "Share to Slack" from triage UI', 'Formatted report with remediation steps'],
      envVars: ['SLACK_WEBHOOK_URL'], file: 'lib/integrations/slack.ts',
    },
    {
      id: 'pagerduty', group: 'alerting', icon: '🔔', name: 'PagerDuty',
      status: env('PAGERDUTY_API_KEY') ? 'connected' : 'disabled',
      description: 'Auto-page on High confidence failures, check on-call schedule.',
      dataProvided: ['Auto-trigger incident on High confidence', 'Check who is on-call before escalating', 'Link triage report to incident'],
      envVars: ['PAGERDUTY_API_KEY', 'PAGERDUTY_SERVICE_ID'], file: 'lib/integrations/pagerduty.ts',
    },
  ];
}

function IntegrationCard(props: Integration) {
  const { icon, name, status, description, dataProvided, envVars, file, setupNote, docsUrl } = props;
  return (
    <div className={`rounded-xl border px-4 py-3.5 ${
      status === 'connected' ? 'border-green-800/40 bg-green-950/10'
      : status === 'simulated' ? 'border-amber-800/30 bg-amber-950/5'
      : 'border-zinc-800/60 bg-zinc-900/10'
    }`}>
      <div className="flex items-start gap-3">
        <span className="text-lg mt-0.5">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-zinc-200">{name}</h3>
            <StatusBadge status={status} />
            {docsUrl && (
              <a href={docsUrl} target="_blank" rel="noopener noreferrer"
                className="ml-auto text-xs text-zinc-700 hover:text-zinc-400 transition">docs →</a>
            )}
          </div>
          <p className="text-xs text-zinc-500 mb-2">{description}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <ul className="space-y-0.5">
              {dataProvided.map((d, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-500">
                  <span className={`mt-0.5 shrink-0 ${status === 'connected' ? 'text-green-600' : status === 'simulated' ? 'text-amber-600' : 'text-zinc-700'}`}>•</span>
                  {d}
                </li>
              ))}
            </ul>
            <div className="space-y-0.5">
              {envVars.map((v, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${status === 'connected' ? 'bg-green-500' : 'bg-zinc-700'}`} />
                  <code className="text-xs font-mono text-zinc-600">{v.split(' (')[0]}</code>
                </div>
              ))}
              <p className="text-xs text-zinc-700 mt-0.5">→ <code className="font-mono">{file}</code></p>
              {setupNote && status !== 'connected' && (
                <p className="text-xs text-zinc-600 italic mt-0.5">{setupNote}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: IntegrationStatus }) {
  if (status === 'connected') return <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-400"><span className="h-1.5 w-1.5 rounded-full bg-green-500" />Connected</span>;
  if (status === 'simulated') return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />Simulated</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-500"><span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />Not configured</span>;
}
