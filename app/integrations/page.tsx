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
            Every integration is a one-file change in{' '}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-400">lib/integrations/</code>.
            Each shows what visibility Dispatch currently has vs. what remains a gap.
          </p>
        </div>

        {/* Visibility coverage map */}
        <div className="mb-8 rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
          <h2 className="text-sm font-semibold text-zinc-300 mb-1">🗺️ Cross-Vendor Visibility Coverage</h2>
          <p className="text-xs text-zinc-500 mb-4">
            No single tool gives you full visibility across a heterogeneous data stack. This is what Dispatch closes.
          </p>
          <div className="space-y-2">
            {COVERAGE_ITEMS.map((item, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className={`mt-0.5 text-xs shrink-0 w-4 ${
                  item.coverage === 'full' ? 'text-green-500' :
                  item.coverage === 'partial' ? 'text-amber-500' :
                  item.coverage === 'gap' ? 'text-red-500/70' :
                  'text-zinc-600'
                }`}>
                  {item.coverage === 'full' ? '✓' : item.coverage === 'partial' ? '◑' : item.coverage === 'gap' ? '✗' : '◦'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-zinc-300">{item.signal}</span>
                    <span className={`text-xs rounded px-1.5 py-0.5 ${
                      item.coverage === 'full' ? 'bg-green-500/10 text-green-400' :
                      item.coverage === 'partial' ? 'bg-amber-500/10 text-amber-400' :
                      item.coverage === 'gap' ? 'bg-red-500/10 text-red-400' :
                      'bg-zinc-800 text-zinc-600'
                    }`}>{item.coverage}</span>
                    {item.tool && <span className="text-xs text-zinc-600">via {item.tool}</span>}
                  </div>
                  <p className="text-xs text-zinc-600 leading-relaxed mt-0.5">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-zinc-700 mt-4 pt-3 border-t border-zinc-800">
            <strong className="text-zinc-500">Synthetic demo mode:</strong>{' '}
            Before adding credentials, Dispatch uses realistic synthetic data per scenario — 
            Fivetran silent failures, Snowflake warehouse contention, Jira tickets.
            Every synthetic entry is replaced automatically when real credentials are added in{' '}
            <a href="/settings" className="text-zinc-500 hover:text-zinc-300 transition">Settings</a>.{' '}
            <strong className="text-zinc-500">Neon incidents table</strong> is the universal fallback:
            any orchestrator can POST run summaries to unify history without OpenLineage.
          </p>
        </div>

        {/* Orchestrator gaps note */}
        <div className="mb-8 rounded-xl border border-amber-800/25 bg-amber-950/10 p-5">
          <h3 className="text-sm font-semibold text-amber-300 mb-2">⚠️ What if you don&apos;t use Dagster?</h3>
          <p className="text-xs text-zinc-400 leading-relaxed mb-3">
            Dispatch is orchestrator-agnostic by design. Dagster gives the richest context (asset graph + prior runs),
            but the same triage pattern works with any orchestrator — the tool calls don&apos;t change.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[
              { icon: '🐙', name: 'GitHub Actions', note: 'Webhook on workflow failure → enriched prompt via GitHub API. No lineage, but full log access.' },
              { icon: '🔧', name: 'AWS Step Functions', note: 'EventBridge rule on FAILED → CloudWatch Logs for steps. Lineage from CloudFormation / CDK definitions.' },
              { icon: '🌬️', name: 'Airflow', note: 'astro-airflow-mcp diagnose_dag_run gets failed tasks + logs. Lineage via Airflow Datasets (AIP-48).' },
              { icon: '📋', name: 'No orchestrator (cron)', note: 'The hardest case. Log to CloudWatch or Datadog. Dispatch ingests via webhook on failure. Runbooks fill the lineage gap.' },
              { icon: '⚙️', name: 'Databricks Workflows', note: 'Databricks has a Jobs API. Lineage via Unity Catalog lineage graph (similar to Dagster asset graph).' },
              { icon: '🔄', name: 'dbt Cloud', note: 'dbt Cloud has webhooks on job failure. Full model-level test results + lineage via dbt compile graph.' },
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
                <span className="text-base shrink-0">{item.icon}</span>
                <div>
                  <p className="text-xs font-medium text-zinc-300">{item.name}</p>
                  <p className="text-xs text-zinc-600 leading-relaxed mt-0.5">{item.note}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* MCP hosting model */}
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/20 p-4">
          <p className="text-xs font-medium text-zinc-400 mb-2">MCP hosting model — matters for how you connect</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div>
              <p className="text-green-400 font-medium mb-1">✅ Hosted (remote HTTP — just add credentials)</p>
              <p className="text-zinc-600">Dagster · Stripe · Vercel · Neon · Prefect (FastMCP Cloud) · Notion · Atlassian (Confluence + Jira) · Salesforce</p>
              <p className="text-zinc-700 mt-0.5">All GA as of 2026. Atlassian Rovo covers Confluence + Jira in one connection. Salesforce requires enabling in Setup → API Catalog → MCP Servers.</p>
            </div>
            <div>
              <p className="text-amber-400 font-medium mb-1">⚠️ Self-hosted (local process — run uvx locally)</p>
              <p className="text-zinc-600">Fivetran (community) · Airflow (local mode)</p>
              <p className="text-zinc-700 mt-0.5">Airflow can become hosted by deploying the plugin into your webserver.</p>
            </div>
          </div>
        </div>

        {/* Integration groups */}
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

        {/* Cursor + Bugbot integration */}
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/20 p-5">
          <div className="flex items-start gap-3">
            <span className="text-xl mt-0.5">🖱️</span>
            <div>
              <h3 className="text-sm font-semibold text-zinc-200 mb-1">Cursor + Bugbot — IDE-Native Data Engineering</h3>
              <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                With{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-zinc-400">.cursor/mcp.json</code>{' '}
                configured, Cursor agents in your IDE can directly ask "why did run X fail?" using
                the Dagster MCP — without opening the Dispatch UI. Dispatch is the web version;
                Cursor is the IDE version. They share the same MCP servers.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                {[
                  { icon: '🔍', label: 'Bugbot reviews Dispatch PRs', desc: 'When Dispatch creates a fix PR, Bugbot auto-reviews it before merge' },
                  { icon: '🖱️', label: 'Cursor Agent in IDE', desc: '"Why did run a227a58f fail?" → uses Dagster MCP → reads logs → proposes fix in your editor' },
                  { icon: '🔄', label: 'Closed loop', desc: 'Failure → Dispatch triage → create_pr → Bugbot review → merge → Dagster confirms fix' },
                  { icon: '📊', label: 'AI Gateway traces', desc: 'Every Cursor + Dispatch AI call tracked in the same Vercel AI Gateway dashboard' },
                ].map((item, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
                    <span className="text-sm shrink-0">{item.icon}</span>
                    <div>
                      <p className="text-xs font-medium text-zinc-300">{item.label}</p>
                      <p className="text-xs text-zinc-600 mt-0.5">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-3">
                <p className="text-xs font-mono text-zinc-500 leading-relaxed">{`# In Cursor Agent (uses .cursor/mcp.json):
"Why did run a227a58f fail in data-eng-prod?"
→ Dagster MCP: get_run_logs(run_id) → full stack trace
→ GitHub MCP: read fct_customer_orders.sql → broken line
→ Proposes fix → creates PR → Bugbot reviews it`}</p>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/20 p-5">
          <div className="flex items-start gap-3">
            <span className="text-xl mt-0.5">🔗</span>
            <div>
              <h3 className="text-sm font-semibold text-zinc-200 mb-1">OpenLineage — The Missing Standard</h3>
              <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                <a href="https://openlineage.io" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">OpenLineage</a>{' '}
                is the open standard for data lineage events. Airflow, dbt, Spark, Flink, and others emit lineage events
                to a central collector (like Marquez). If your team already emits OpenLineage events, Dispatch could
                consume them to build the cross-vendor dependency graph automatically — without knowing anything about
                your specific orchestrator.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {[
                  { name: 'Airflow', note: 'openlineage-airflow plugin — emits on task start/end' },
                  { name: 'dbt', note: 'dbt-openlineage — emits model lineage on run' },
                  { name: 'Spark / Flink', note: 'OpenLineage Spark/Flink listeners built-in' },
                ].map((item, i) => (
                  <div key={i} className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
                    <p className="text-xs font-medium text-zinc-300">{item.name}</p>
                    <p className="text-xs text-zinc-600 mt-0.5">{item.note}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-zinc-700 mt-3">
                Dispatch upgrade path: add an OpenLineage consumer tool that queries a Marquez instance for the
                dependency graph of any failing asset — works across ALL orchestrators that emit OpenLineage events.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// Coverage map
// -------------------------------------------------------------------
const COVERAGE_ITEMS = [
  { signal: 'Why did THIS run fail?', coverage: 'full', tool: 'Dagster/Airflow MCP → run logs + GraphQL', desc: 'Full error logs via MCP. For Dagster: also queries GraphQL directly for the actual Python exception (not just "STEP_FAILURE"). Direct link to the specific run in the orchestrator UI.' },
  { signal: 'Has this failed before? Is it recurring?', coverage: 'full', tool: 'Neon incidents table + Dagster list_runs + Vercel Cron sync', desc: 'Prior run history + incident DB. Vercel Cron syncs Dagster failures to Neon every 30 min. Recurring vs. first-time failure changes the remediation entirely.' },
  { signal: 'What changed in the code recently?', coverage: 'full', tool: 'GitHub API — commit SHA lookup + time-window search', desc: 'When orchestrator provides a commit hash (Dagster tags, GitHub Actions metadata), Dispatch fetches the REAL diff for that exact commit. Falls back to recent PRs by time window.' },
  { signal: 'Is the upstream vendor having an outage?', coverage: 'full', tool: 'StatusPage APIs (real-time) + Fivetran connector status', desc: '10 vendor status pages checked in real-time. Fivetran connector-level check detects silent 0-row SUCCESS failures. Synthetic demo data tells the right story before credentials are added.' },
  { signal: 'Runbooks for primary + upstream pipelines', coverage: 'full', tool: 'Neon cascade search + Confluence/Notion MCP', desc: 'Cascade search: runbooks for the failing pipeline AND inferred upstream pipelines. Now includes orchestrator-level runbooks (IO Manager, OOM, API rate limits).' },
  { signal: 'What did the upstream Fivetran sync load?', coverage: 'full', tool: 'Fivetran API (real) + synthetic silent failure detection', desc: 'Real: getConnectorStatus() + findConnectorsForPipeline() via Fivetran API when credentials set. Synthetic: demo data shows 0-row silent failures before credentials added. Add FIVETRAN_API_KEY in /settings to go live.' },
  { signal: 'What caused the failure in GitHub Actions / Step Functions?', coverage: 'partial', tool: 'GitHub Actions API + webhook + Step Functions stub', desc: 'GitHub Actions: getWorkflowRun() fetches real job/step details. Webhook at /api/webhooks/github-actions receives failure events. Step Functions: needs CloudWatch integration (AWS SDK stub ready).' },
  { signal: 'Snowflake query history / warehouse contention', coverage: 'partial', tool: 'Synthetic contention data + Snowflake REST API stub', desc: 'Synthetic: realistic concurrent query data for warehouse contention scenarios (e.g., two jobs sharing COMPUTE_WH). Real: Snowflake REST SQL API stub in lib/integrations/snowflake.ts — add SNOWFLAKE_* in /settings.' },
  { signal: 'Open Jira incidents for this pipeline', coverage: 'partial', tool: 'Synthetic Jira issues + Atlassian Rovo MCP (hosted)', desc: 'Synthetic: realistic P2/P3 Jira tickets for each scenario. Real: Atlassian Rovo MCP at mcp.atlassian.com — same OAuth as Confluence, covers Jira + Confluence in one connection.' },
  { signal: 'Which assets depend on the failing one?', coverage: 'partial', tool: 'Dagster asset graph only (via MCP get_assets)', desc: 'Downstream impact analysis via Dagster get_assets with latestFailedToMaterializeTimestamp. Other orchestrators: dbt compile graph (read sources.yml) or OpenLineage if emitting events.' },
  { signal: 'What ran upstream in the last 2 hours?', coverage: 'partial', tool: 'Dagster list_runs + asset health check + cross-pipeline incident query', desc: 'Implemented: recently-failed assets + recentUpstreamFailures from Neon incidents. Gap: cross-orchestrator (Airflow pipeline failed → Dagster downstream sees it only if both write to incidents table).' },
  { signal: 'Full cross-vendor lineage graph', coverage: 'partial', tool: 'dbt sources.yml (via GitHub) + Dagster asset graph + commit SHA lookup', desc: 'Partial: commit SHA from run metadata → GitHub API → actual changed files. dbt sources.yml maps Fivetran connectors. True full lineage requires OpenLineage/Marquez emitting from all tools.' },
  { signal: 'Databricks job context / Unity Catalog lineage', coverage: 'gap', tool: '—', desc: 'Databricks Jobs API + Unity Catalog lineage would provide Databricks-equivalent of Dagster asset graph. Integration stub exists at lib/integrations/databricks.ts — needs AWS SDK + Databricks token.' },
  { signal: 'Legacy cron jobs / no orchestrator', coverage: 'partial', tool: 'Webhook at /api/webhooks/github-actions (any HTTP client)', desc: 'Any cron job can POST to Dispatch on failure. The webhook endpoint receives the failure, logs to incidents table, and Slacks the team. Full triage auto-trigger is one function call from the stub.' },
];

// -------------------------------------------------------------------
// Integration groups
// -------------------------------------------------------------------
const INTEGRATION_GROUPS = [
  { id: 'core', icon: '🏗️', label: 'Core', description: '— always active' },
  { id: 'orchestration', icon: '⚡', label: 'Orchestration', description: '— pipeline execution context' },
  { id: 'ingestion', icon: '📥', label: 'Ingestion / Sources', description: '— upstream failure detection' },
  { id: 'transformation', icon: '🔄', label: 'Transformation', description: '— dbt, Spark, Snowflake' },
  { id: 'knowledge', icon: '📖', label: 'Knowledge Base', description: '— runbooks, docs' },
  { id: 'alerting', icon: '🔔', label: 'Alerting / On-call', description: '— notifications' },
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
      description: 'Runbooks, incident history, git context, settings. pgvector ready.',
      dataProvided: ['Runbook full-text + failure_type search', '90-day incident history', 'Encrypted integration settings', 'pgvector semantic search (column ready)'],
      envVars: ['DATABASE_URL'], file: 'lib/db.ts',
    },
    {
      id: 'ai-gateway', group: 'core', icon: '🔀', name: 'Vercel AI Gateway',
      status: env('VERCEL_OIDC_TOKEN') || env('AI_GATEWAY_API_KEY') ? 'connected' : 'disabled',
      description: 'Model routing, failover, cost tracking. OIDC — no key rotation.',
      dataProvided: ['openai/gpt-5.4 primary', 'anthropic/claude-haiku-4.5 fallback', 'Token cost per tool call', 'Latency traces'],
      envVars: ['VERCEL_OIDC_TOKEN (auto via vercel env pull)'], file: 'lib/models.ts',
      setupNote: 'vercel link && vercel env pull .env.local',
    },
    // Orchestration
    {
      id: 'dagster', group: 'orchestration', icon: '⚡', name: 'Dagster',
      status: env('DAGSTER_HOST') ? 'connected' : 'simulated',
      description: 'Run logs, asset graph, prior runs, upstream failures. Best-in-class for data pipelines.',
      dataProvided: ['get_run + get_run_logs: full step logs', 'list_runs: prior run history (recurring?)', 'get_assets: recently-failed upstream assets', 'Run failure sensor → auto-triage webhook'],
      envVars: ['DAGSTER_HOST', 'DAGSTER_TOKEN', 'DAGSTER_ORG'], file: 'lib/integrations/dagster.ts',
      docsUrl: 'https://docs.dagster.io/guides/operate/model-context-protocol',
      setupNote: '✅ HOSTED MCP: mcp.agent.dagster.cloud/mcp/ (+ X-Dagster-Delegation-Token header)',
    },
    {
      id: 'airflow', group: 'orchestration', icon: '🌬️', name: 'Airflow / Astronomer',
      status: env('AIRFLOW_HOST') ? 'connected' : 'disabled',
      description: 'DAG run context, task logs, data lineage. Can be hosted as Airflow plugin.',
      dataProvided: ['diagnose_dag_run: failed tasks + logs in one call', 'Data lineage via Airflow Datasets (AIP-48)', 'explore_dag: full DAG context + source code', 'Hosted mode: exposes /mcp/v1/ on webserver'],
      envVars: ['AIRFLOW_HOST', 'AIRFLOW_API_KEY'], file: 'lib/integrations/airflow.ts',
      setupNote: 'LOCAL: uvx astro-airflow-mcp | HOSTED: add to requirements.txt → /mcp/v1/ on webserver',
    },
    {
      id: 'github-actions', group: 'orchestration', icon: '🐙', name: 'GitHub Actions',
      status: env('GITHUB_TOKEN') ? 'connected' : 'disabled',
      description: 'Workflow run logs, step failures, trigger context. Very common for non-Dagster data pipelines.',
      dataProvided: ['Workflow run logs via GitHub API', 'Failed step identification', 'Git context already covered by GitHub integration', 'Webhook: POST to /api/webhooks/github-actions on failure'],
      envVars: ['GITHUB_TOKEN (same as GitHub integration)'], file: 'lib/integrations/github.ts',
      setupNote: 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs — same token as git context',
    },
    {
      id: 'step-functions', group: 'orchestration', icon: '🔧', name: 'AWS Step Functions',
      status: env('AWS_ACCESS_KEY_ID') ? 'connected' : 'disabled',
      description: 'Execution history, step failures. Used by many AWS-native data teams.',
      dataProvided: ['GetExecutionHistory: all step events + errors', 'CloudWatch Logs: detailed step output', 'EventBridge rule: trigger triage on FAILED state'],
      envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'], file: 'lib/integrations/step-functions.ts',
      setupNote: 'aws stepfunctions get-execution-history --execution-arn arn:aws:states:...',
    },
    {
      id: 'databricks', group: 'orchestration', icon: '🧱', name: 'Databricks Workflows',
      status: env('DATABRICKS_HOST') ? 'connected' : 'disabled',
      description: 'Job run context, cluster events, Unity Catalog lineage (similar to Dagster asset graph).',
      dataProvided: ['Jobs API: run status and logs', 'Cluster event log: spot preemption / OOM', 'Unity Catalog lineage graph (if enabled)', 'ACCOUNT_USAGE.QUERY_HISTORY for contention'],
      envVars: ['DATABRICKS_HOST', 'DATABRICKS_TOKEN'], file: 'lib/integrations/databricks.ts',
      setupNote: 'GET /api/2.1/jobs/runs/get?run_id={run_id} — Databricks REST API',
    },
    {
      id: 'prefect', group: 'orchestration', icon: '🌀', name: 'Prefect',
      status: env('PREFECT_API_URL') ? 'connected' : 'disabled',
      description: 'Flow run context, task state, concurrency debugging. Hosted MCP via FastMCP Cloud.',
      dataProvided: ['Why is flow X failing? (logs + events)', 'Concurrency limits + work pool status', 'Cancel late runs via MCP', 'Hosted: deploy to FastMCP Cloud → team endpoint'],
      envVars: ['PREFECT_API_KEY'], file: 'lib/integrations/prefect.ts',
      docsUrl: 'https://www.prefect.io/blog/a-prefect-mcp-server',
      setupNote: '✅ HOSTED: uvx --from prefect-mcp prefect-mcp-server → deploy to FastMCP Cloud',
    },
    {
      id: 'dbt-cloud-jobs', group: 'orchestration', icon: '🔄', name: 'dbt Cloud (Scheduler)',
      status: env('DBT_CLOUD_API_KEY') ? 'connected' : 'disabled',
      description: 'dbt Cloud has its own scheduler. Job run details, model test failures, source freshness.',
      dataProvided: ['Run-level status + logs', 'Model-level test failures', 'Source freshness results', 'Webhook: dbt Cloud sends failure events'],
      envVars: ['DBT_CLOUD_API_KEY', 'DBT_CLOUD_ACCOUNT_ID'], file: 'lib/integrations/dbt-cloud.ts',
      setupNote: 'GET /api/v2/accounts/{id}/runs/{run_id}/ + webhook on job failure',
    },
    // Ingestion
    {
      id: 'fivetran', group: 'ingestion', icon: '🔌', name: 'Fivetran',
      status: env('FIVETRAN_API_KEY') ? 'connected' : 'simulated',
      description: 'Connector sync status, row counts, silent failures. Community MCP (self-hosted only).',
      dataProvided: ['get_connection_details: last sync + rows loaded', '0-row silent SUCCESS detection', 'Schema change history', 'sync_connection: trigger re-sync'],
      envVars: ['FIVETRAN_API_KEY', 'FIVETRAN_API_SECRET'], file: 'lib/integrations/fivetran.ts',
      setupNote: '⚠️ SELF-HOSTED: uvx --from git+https://github.com/fivetran/fivetran-mcp fivetran-mcp',
    },
    {
      id: 'airbyte', group: 'ingestion', icon: '🌊', name: 'Airbyte',
      status: env('AIRBYTE_API_KEY') ? 'connected' : 'disabled',
      description: 'Connection sync status, schema drift.',
      dataProvided: ['Sync job status and logs', 'Schema change notifications', 'Source/destination health'],
      envVars: ['AIRBYTE_API_URL', 'AIRBYTE_API_KEY'], file: 'lib/integrations/airbyte.ts',
    },
    // Transformation
    {
      id: 'snowflake', group: 'transformation', icon: '❄️', name: 'Snowflake',
      status: env('SNOWFLAKE_ACCOUNT') ? 'connected' : 'simulated',
      description: 'Query history, warehouse utilization, concurrent job contention.',
      dataProvided: ['QUERY_HISTORY: concurrent queries (contention detection)', 'Warehouse credit consumption', 'Table freshness checks', 'ACCOUNT_USAGE for deep analysis'],
      envVars: ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USER', 'SNOWFLAKE_PASSWORD', 'SNOWFLAKE_WAREHOUSE'], file: 'lib/integrations/snowflake.ts',
    },
    // Knowledge
    {
      id: 'github', group: 'knowledge', icon: '🐙', name: 'GitHub',
      status: env('GITHUB_TOKEN') ? 'connected' : 'simulated',
      description: 'Recent commits, PRs, dbt sources.yml for lineage mapping.',
      dataProvided: ['Real commit history + PR diffs', 'dbt sources.yml: maps Fivetran connectors to models', 'File-level blame for breaking changes', 'GitHub Actions logs (same token)'],
      envVars: ['GITHUB_TOKEN', 'GITHUB_REPO_OWNER', 'GITHUB_REPO_NAME'], file: 'lib/integrations/github.ts',
    },
    {
      id: 'salesforce', group: 'knowledge', icon: '☁️', name: 'Salesforce',
      status: env('SALESFORCE_ACCESS_TOKEN') ? 'connected' : 'disabled',
      description: 'Live Salesforce schema and object data. When a Salesforce field rename causes a dbt failure, the MCP confirms the source-of-truth schema change.',
      dataProvided: [
        'Object schema: did a field get renamed/added in Salesforce?',
        'SOQL queries: verify data directly at the source before debugging dbt',
        'Flow and Apex action inspection (custom server config)',
        'Audit trail: who changed what in Salesforce and when',
      ],
      envVars: ['SALESFORCE_ACCESS_TOKEN', 'SALESFORCE_ORG_URL'], file: 'lib/integrations/salesforce.ts',
      docsUrl: 'https://developer.salesforce.com/blogs/2026/04/salesforce-hosted-mcp-servers-are-now-generally-available',
      setupNote: '✅ HOSTED MCP (GA): Setup → API Catalog → MCP Servers in your Salesforce org. OAuth + PKCE.',
    },
    {
      id: 'confluence', group: 'knowledge', icon: '📖', name: 'Confluence',
      status: env('CONFLUENCE_BASE_URL') ? 'connected' : 'disabled',
      description: 'Fan out runbook search to Confluence spaces. Now available via Atlassian Rovo hosted MCP.',
      dataProvided: ['Runbook search via CQL', 'Architecture diagrams + decision records', 'Post-mortem pages', 'Automatically improving as team updates docs'],
      envVars: ['CONFLUENCE_BASE_URL', 'CONFLUENCE_TOKEN', 'CONFLUENCE_SPACE_KEY'], file: 'lib/integrations/confluence.ts',
      docsUrl: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
      setupNote: '✅ HOSTED MCP: mcp.atlassian.com/v1/mcp/authv2 (OAuth) — covers Confluence + Jira in one connection',
    },
    {
      id: 'jira', group: 'knowledge', icon: '🎫', name: 'Jira',
      status: env('JIRA_API_TOKEN') ? 'connected' : 'disabled',
      description: 'Search open incidents, create triage tickets, link related issues. Via Atlassian Rovo MCP (same connection as Confluence).',
      dataProvided: ['Search open incidents: "any P1 issues for data pipelines?"', 'Create triage ticket from Dispatch report', 'Link Dagster run ID to Jira issue', 'Find related historical incidents in project tracker'],
      envVars: ['JIRA_API_TOKEN (same Atlassian Rovo OAuth session)'], file: 'lib/integrations/jira.ts',
      docsUrl: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
      setupNote: '✅ HOSTED MCP: same mcp.atlassian.com connection as Confluence — Rovo covers both',
    },
    {
      id: 'notion', group: 'knowledge', icon: '📝', name: 'Notion',
      status: env('NOTION_API_KEY') ? 'connected' : 'disabled',
      description: 'Pull runbooks and incident post-mortems from Notion databases. Official hosted MCP.',
      dataProvided: ['Runbook search across all Notion databases', 'Incident post-mortem lookup', 'On-call rotation and team wikis', 'Full workspace read/write access'],
      envVars: ['NOTION_API_KEY'], file: 'lib/integrations/notion.ts',
      docsUrl: 'https://developers.notion.com/guides/mcp/overview',
      setupNote: '✅ HOSTED MCP: api.notion.com/mcp (OAuth one-click install)',
    },
    // Alerting
    {
      id: 'slack', group: 'alerting', icon: '💬', name: 'Slack',
      status: env('SLACK_WEBHOOK_URL') ? 'connected' : 'disabled',
      description: 'Auto-post triage reports to #data-alerts.',
      dataProvided: ['Auto-post on any failure webhook', 'Share to Slack from triage UI', 'Formatted report with remediation steps'],
      envVars: ['SLACK_WEBHOOK_URL'], file: 'lib/integrations/slack.ts',
    },
    {
      id: 'stripe', group: 'alerting', icon: '💳', name: 'Stripe',
      status: env('STRIPE_API_KEY') ? 'connected' : 'disabled',
      description: 'Revenue impact of data failures. Official hosted MCP.',
      dataProvided: ['Revenue during data outage window', 'Payment intent status', 'Connect to existing Stripe monitoring'],
      envVars: ['STRIPE_API_KEY (restricted)'], file: 'lib/integrations/stripe.ts',
      docsUrl: 'https://docs.stripe.com/mcp',
      setupNote: '✅ HOSTED MCP: mcp.stripe.com',
    },
    {
      id: 'pagerduty', group: 'alerting', icon: '🔔', name: 'PagerDuty',
      status: env('PAGERDUTY_API_KEY') ? 'connected' : 'disabled',
      description: 'Auto-page on High confidence failures.',
      dataProvided: ['Auto-trigger incident on High confidence', 'Check on-call before escalating', 'Link triage report to incident'],
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
            {docsUrl && <a href={docsUrl} target="_blank" rel="noopener noreferrer" className="ml-auto text-xs text-zinc-700 hover:text-zinc-400 transition">docs →</a>}
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
              {setupNote && status !== 'connected' && <p className="text-xs text-zinc-600 italic mt-0.5">{setupNote}</p>}
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
