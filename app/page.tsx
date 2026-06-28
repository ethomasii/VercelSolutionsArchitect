import Link from 'next/link';

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
  File "models/marts/customers/fct_customer_orders.sql", line 47
  Database Error in model fct_customer_orders (models/marts/customers/fct_customer_orders.sql)
    column "customer_tier" of relation "dim_customers" does not exist
    LINE 47: SELECT c.customer_tier, SUM(o.order_amount) as revenue
  Pipeline: dbt_customers_transform
  Asset: dbt_customers_transform`,
  },
  {
    id: 'snowflake',
    label: 'PermissionError: User DISPATCH_SVC_ACCT lacks privilege on RAW.SALESFORCE',
    log: `ERROR 2026-06-28 06:15:44 UTC [snowflake] Pipeline failed: snowflake_raw_ingestion
sqlalchemy.exc.ProgrammingError: (snowflake.connector.errors.ProgrammingError) 002003 (42S02):
SQL compilation error: Object 'RAW.SALESFORCE.ACCOUNTS' does not exist or not authorized.
User: DISPATCH_SVC_ACCT
Role: DISPATCH_ROLE
Error code: 002003
Pipeline: snowflake_raw_ingestion`,
  },
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Hero */}
      <div className="mx-auto max-w-4xl px-6 pt-24 pb-16">
        <div className="mb-4 flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-orange-500/10 px-3 py-1 text-xs font-medium text-orange-400 ring-1 ring-orange-500/20">
            AI-powered triage
          </span>
        </div>

        <h1 className="text-5xl font-bold tracking-tight text-white mb-4">
          Dispatch
        </h1>
        <p className="text-xl text-zinc-400 max-w-2xl mb-3">
          Cross-stack pipeline incident triage.{' '}
          <span className="text-zinc-200">Technical signals + institutional knowledge</span>, synthesized in seconds.
        </p>
        <p className="text-sm text-zinc-500 max-w-xl mb-10">
          Searches your runbooks, incident history, and git context — not just the vendor&apos;s logs.
        </p>

        {/* Sample incident chips */}
        <div className="mb-10">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-3">
            Try a sample incident →
          </p>
          <div className="flex flex-col gap-2">
            {SAMPLE_INCIDENTS.map(inc => (
              <Link
                key={inc.id}
                href={`/triage?log=${encodeURIComponent(inc.log)}`}
                className="group inline-flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-300 transition-all hover:border-orange-500/40 hover:bg-zinc-800 hover:text-zinc-100"
              >
                <span className="mt-0.5 text-orange-500 opacity-60 group-hover:opacity-100">▶</span>
                <code className="font-mono text-xs">{inc.label}</code>
              </Link>
            ))}
          </div>
        </div>

        {/* CTA buttons */}
        <div className="flex items-center gap-4">
          <Link
            href="/triage"
            className="rounded-lg bg-orange-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
          >
            Open Triage
          </Link>
          <Link
            href="/evals"
            className="rounded-lg border border-zinc-700 px-6 py-2.5 text-sm font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
          >
            View Evals
          </Link>
        </div>
      </div>

      {/* Feature callouts */}
      <div className="mx-auto max-w-4xl px-6 pb-24">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {[
            {
              icon: '📚',
              title: 'Runbook Search',
              body: 'Searches your internal runbooks for this exact failure type. No vendor can index your team\'s institutional knowledge.',
            },
            {
              icon: '📋',
              title: 'Incident History',
              body: 'Looks up the last 90 days of similar failures. A pipeline that fires every 2 weeks with a known resolution is different from a first-ever failure.',
            },
            {
              icon: '🔀',
              title: 'Git Context',
              body: 'Checks for PRs merged in the last 24 hours. A column rename 4 hours ago is often the smoking gun.',
            },
          ].map(f => (
            <div
              key={f.title}
              className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5"
            >
              <div className="mb-3 text-2xl">{f.icon}</div>
              <h3 className="mb-2 text-sm font-semibold text-zinc-200">{f.title}</h3>
              <p className="text-xs text-zinc-500 leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-zinc-800 py-6">
        <p className="text-center text-xs text-zinc-600">
          Built on{' '}
          <a href="https://vercel.com" className="hover:text-zinc-400 transition">Vercel</a>
          {' · '}
          <a href="https://sdk.vercel.ai" className="hover:text-zinc-400 transition">AI SDK</a>
          {' · '}
          <a href="https://neon.tech" className="hover:text-zinc-400 transition">Neon</a>
        </p>
      </div>
    </main>
  );
}
