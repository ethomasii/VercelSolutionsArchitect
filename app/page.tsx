import Link from 'next/link';
import { checkVendorStatus } from '@/lib/vendor-status';

const SAMPLE_INCIDENTS = [
  {
    id: 'orders',
    label: 'fivetran_orders_daily failed — 0 rows loaded for last 6 hours',
    log: `WARNING 2026-06-28 03:02:11 UTC [dagster] Asset materialization failed: fivetran_orders_daily
FivetranSyncError: No new data available from connector orders_shopify
Last successful sync: 2026-06-28 01:15:00 UTC
Expected freshness: 60 minutes
Current lag: 107 minutes
Connector status: SYNCING (rate limited)
Shopify API error: 429 Too Many Requests
Pipeline: fivetran_orders_daily`,
  },
  {
    id: 'customers',
    label: "dbt.customers KeyError: 'customer_tier' — column not found",
    log: `ERROR 2026-06-28 02:14:33 UTC [dbt] KeyError: 'customer_tier'
  Database Error in model fct_customer_orders
    column "customer_tier" of relation "dim_customers" does not exist
    LINE 47: SELECT c.customer_tier, SUM(o.order_amount) as revenue
  Pipeline: dbt_customers_transform`,
  },
  {
    id: 'snowflake',
    label: 'PermissionError: User DISPATCH_SVC_ACCT lacks privilege on RAW.SALESFORCE',
    log: `ERROR 2026-06-28 06:15:44 UTC [snowflake] Pipeline failed: snowflake_raw_ingestion
sqlalchemy.exc.ProgrammingError: (snowflake.connector.errors.ProgrammingError) 003001 (42501):
Insufficient privileges to operate on schema 'RAW.SALESFORCE'
User: DISPATCH_SVC_ACCT
Role: DISPATCH_ROLE
Pipeline: snowflake_raw_ingestion`,
  },
];

const VENDOR_STATUS_NAMES = ['fivetran', 'snowflake', 'dbt', 'github', 'shopify'];

export default async function HomePage() {
  // Server-side: fetch vendor status at render time
  const vendorStatuses = await Promise.all(
    VENDOR_STATUS_NAMES.map(v => checkVendorStatus(v).catch(() => null))
  );
  const hasVendorIssues = vendorStatuses.some(v => v && v.level !== 'operational' && v.level !== 'unknown');

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">

      {/* Live vendor status banner */}
      <div className={`border-b px-6 py-2 ${hasVendorIssues ? 'border-amber-800/40 bg-amber-950/10' : 'border-zinc-900 bg-zinc-950'}`}>
        <div className="mx-auto max-w-4xl flex items-center gap-4 flex-wrap">
          <span className="text-xs font-medium text-zinc-600 shrink-0">🌐 Vendor status</span>
          {vendorStatuses.map((v, i) => v && (
            <a key={i} href={v.statusPageUrl} target="_blank" rel="noopener noreferrer"
              title={v.description}
              className="inline-flex items-center gap-1.5 text-xs transition hover:opacity-80">
              <span className={`h-1.5 w-1.5 rounded-full ${
                v.level === 'operational' ? 'bg-green-500' :
                v.level === 'outage' ? 'bg-red-500 animate-pulse' :
                v.level === 'degraded' ? 'bg-amber-500' : 'bg-zinc-600'
              }`} />
              <span className={`capitalize ${
                v.level === 'operational' ? 'text-zinc-600' :
                v.level === 'outage' ? 'text-red-400 font-medium' :
                v.level === 'degraded' ? 'text-amber-400 font-medium' : 'text-zinc-700'
              }`}>{v.vendor}</span>
              {(v.level === 'degraded' || v.level === 'outage') && (
                <span className="text-xs">⚠️</span>
              )}
            </a>
          ))}
          {hasVendorIssues && (
            <span className="ml-auto text-xs text-amber-400">Active vendor incidents — check before debugging code</span>
          )}
        </div>
      </div>

      {/* Hero */}
      <div className="mx-auto max-w-4xl px-6 pt-16 pb-10">
        <div className="mb-4 flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-orange-500/10 px-3 py-1 text-xs font-medium text-orange-400 ring-1 ring-orange-500/20">
            AI-powered triage
          </span>
          <span className="inline-flex items-center rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-500">
            Built for Vercel customers
          </span>
        </div>

        <h1 className="text-5xl font-bold tracking-tight text-white mb-4">Dispatch</h1>
        <p className="text-xl text-zinc-400 max-w-2xl mb-3">
          Cross-stack pipeline incident triage.{' '}
          <span className="text-zinc-200">Technical signals + institutional knowledge</span>, synthesized in seconds.
        </p>
        <p className="text-sm text-zinc-500 max-w-xl mb-2">
          Searches runbooks, incident history, git context, and live vendor status —
          across every tool in your stack, not just the one that fired the alert.
        </p>
        <p className="text-xs text-zinc-700 max-w-xl mb-8">
          Already on Vercel? Dispatch is one{' '}
          <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-zinc-500">vercel deploy</code> away.
          Same AI Gateway, same Neon, same platform — your data team gets AI triage with zero new infrastructure.
        </p>

        <div className="flex items-center gap-4 flex-wrap">
          <Link href="/triage" className="rounded-lg bg-orange-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-500">
            Open Triage
          </Link>
          <Link href="/triage" className="rounded-lg border border-zinc-700 px-6 py-2.5 text-sm font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200">
            Try Run ID →
          </Link>
          <Link href="/evals" className="text-sm font-medium text-zinc-600 transition hover:text-zinc-400">Evals</Link>
          <Link href="/integrations" className="text-sm font-medium text-zinc-600 transition hover:text-zinc-400">Integrations</Link>
          <Link href="/settings" className="text-sm font-medium text-zinc-600 transition hover:text-zinc-400">Settings</Link>
        </div>
      </div>

      {/* Sample incidents */}
      <div className="mx-auto max-w-4xl px-6 pb-10">
        <p className="text-xs text-zinc-600 uppercase tracking-wider mb-3">Try a sample →</p>
        <div className="flex flex-col gap-2">
          {SAMPLE_INCIDENTS.map(inc => (
            <Link key={inc.id} href={`/triage?log=${encodeURIComponent(inc.log)}`}
              className="group inline-flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-300 transition-all hover:border-orange-500/40 hover:bg-zinc-800 hover:text-zinc-100">
              <span className="mt-0.5 text-orange-500 opacity-60 group-hover:opacity-100">▶</span>
              <code className="font-mono text-xs">{inc.label}</code>
            </Link>
          ))}
        </div>
      </div>

      {/* Context cards grid */}
      <div className="mx-auto max-w-4xl px-6 pb-12">
        <p className="text-xs text-zinc-600 uppercase tracking-wider mb-4">What Dispatch synthesizes</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              icon: '📚', title: 'Runbooks',
              body: 'Internal playbooks for this exact failure type. The remediation steps your team has already figured out.',
              badge: 'Layer 2 — institutional',
            },
            {
              icon: '📋', title: 'Incident History',
              body: '90 days of similar failures. A pipeline that fires every 2 weeks and always self-resolves is different from a first-ever failure.',
              badge: 'Layer 2 — institutional',
            },
            {
              icon: '🔀', title: 'Git Context',
              body: 'PRs merged in the last 24 hours. A column rename 4 hours ago is often the smoking gun for a schema mismatch.',
              badge: 'Layer 2 — institutional',
            },
            {
              icon: '⚡', title: 'Orchestrator Context',
              body: 'Asset dependency graph, upstream run results, concurrent workloads. Run IDs unlock full cross-pipeline context.',
              badge: 'Layer 1 — technical',
            },
            {
              icon: '🌐', title: 'Live Vendor Status',
              body: 'Real-time status from Fivetran, Snowflake, dbt Cloud, and others. Vendor outage → wait, not debug.',
              badge: 'Layer 1 — technical',
            },
            {
              icon: '🗺️', title: 'Cross-Vendor Lineage',
              body: 'dbt sources.yml maps Fivetran → models. Dagster asset graph shows the full chain. Runbooks fill the gaps no tool covers.',
              badge: 'Both layers',
            },
          ].map(f => (
            <div key={f.title} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <div className="mb-2 flex items-start justify-between">
                <span className="text-2xl">{f.icon}</span>
                <span className={`text-xs rounded-full px-2 py-0.5 ${
                  f.badge.startsWith('Layer 1') ? 'bg-blue-500/10 text-blue-400' :
                  f.badge.startsWith('Layer 2') ? 'bg-orange-500/10 text-orange-400' :
                  'bg-zinc-800 text-zinc-500'
                }`}>{f.badge}</span>
              </div>
              <h3 className="mb-1.5 text-sm font-semibold text-zinc-200">{f.title}</h3>
              <p className="text-xs text-zinc-500 leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Cross-vendor lineage explainer */}
      <div className="mx-auto max-w-4xl px-6 pb-12">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
          <h2 className="text-sm font-semibold text-zinc-300 mb-1">
            🗺️ Where do cross-vendor relationships live?
          </h2>
          <p className="text-xs text-zinc-500 mb-4">
            If a Snowflake query fails, how does Dispatch know it was fed by Fivetran, transformed by dbt, and triggered by Dagster?
            The answer: the information exists in four places simultaneously.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            {[
              {
                icon: '🔄',
                title: 'dbt sources.yml',
                desc: 'Defines which Fivetran/Airbyte connectors feed which models. The dependency graph is in the code — parse it with the GitHub integration.',
                status: 'machine-readable',
              },
              {
                icon: '⚡',
                title: 'Dagster asset catalog',
                desc: 'The most complete picture: every asset, its upstream dependencies, and which tools run them. The Dagster MCP exposes this as queryable context.',
                status: 'machine-readable',
              },
              {
                icon: '📚',
                title: 'Runbooks',
                desc: '"When dbt_customers fails, check Fivetran Salesforce connector first." Human-curated cross-tool knowledge that no vendor can auto-generate.',
                status: 'institutional',
              },
              {
                icon: '🔍',
                title: 'Incident history',
                desc: 'Pattern: fivetran_orders_daily failed 30min before dbt_customers 8 times in 90 days → that IS the lineage map, discovered empirically.',
                status: 'institutional',
              },
            ].map((item, i) => (
              <div key={i} className="flex gap-3 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5">
                <span className="text-lg shrink-0 mt-0.5">{item.icon}</span>
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-zinc-300">{item.title}</span>
                    <span className={`text-xs rounded px-1.5 py-0.5 ${
                      item.status === 'machine-readable' ? 'bg-blue-500/10 text-blue-400' : 'bg-orange-500/10 text-orange-400'
                    }`}>{item.status}</span>
                  </div>
                  <p className="text-xs text-zinc-600 leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3">
            <p className="text-xs text-zinc-500 mb-1.5 font-medium">Full lineage chain example</p>
            <pre className="text-xs font-mono text-zinc-600 leading-relaxed">{`Shopify API
  └── Fivetran connector (orders_shopify)     ← sources.yml: source('shopify', 'orders')
      └── RAW.SHOPIFY.ORDERS (Snowflake)
          └── stg_orders (dbt staging model)  ← ref() chain in dbt project
              └── fct_orders (dbt mart)
                  └── dbt_orders_mart (Dagster asset)  ← Dagster asset graph
                      └── revenue_report (downstream)

If fct_orders fails:
  • Check Fivetran status first (was data loaded?)
  • Check dbt sources.yml for the connector name
  • Check Dagster for upstream asset failures
  • Check Snowflake QUERY_HISTORY for contention
  • Check runbook: "when fct_orders fails, check orders_shopify sync first"`}</pre>
          </div>

          <p className="text-xs text-zinc-700 mt-3">
            With Dagster MCP + GitHub integration: Dispatch traverses this chain automatically from a run ID.
            Without it: runbooks + incident history surface the same patterns from institutional knowledge.
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-zinc-800 py-6">
        <p className="text-center text-xs text-zinc-700">
          Built on{' '}
          <a href="https://vercel.com" className="hover:text-zinc-500 transition">Vercel</a>
          {' · '}
          <a href="https://sdk.vercel.ai" className="hover:text-zinc-500 transition">AI SDK v7</a>
          {' · '}
          <a href="https://neon.tech" className="hover:text-zinc-500 transition">Neon</a>
          {' · '}
          <a href="https://ai-gateway.vercel.sh" className="hover:text-zinc-500 transition">AI Gateway</a>
        </p>
      </div>
    </main>
  );
}
