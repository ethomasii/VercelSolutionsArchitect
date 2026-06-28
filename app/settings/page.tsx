'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

// Config schema for each integration — what fields to show
const INTEGRATION_CONFIGS: Array<{
  id: string;
  name: string;
  icon: string;
  group: string;
  description: string;
  docsUrl?: string;
  fields: Array<{
    key: string;
    label: string;
    placeholder: string;
    isSecret: boolean;
    hint?: string;
  }>;
}> = [
  {
    id: 'dagster',
    name: 'Dagster',
    icon: '⚡',
    group: 'Orchestration',
    description: 'Run logs, asset dependency graph, upstream failure detection. Has official MCP server.',
    docsUrl: 'https://docs.dagster.io/guides/operate/model-context-protocol',
    fields: [
      { key: 'DAGSTER_HOST', label: 'Host URL', placeholder: 'https://your-org.dagster.cloud', isSecret: false, hint: 'Your Dagster+ organization URL' },
      { key: 'DAGSTER_TOKEN', label: 'API Token', placeholder: 'dagster-user-token-...', isSecret: true, hint: 'Admin → User Tokens → Create token' },
      { key: 'DAGSTER_ORG', label: 'Organization slug', placeholder: 'your-org', isSecret: false, hint: 'Used for Dagster MCP: Dagster-Cloud-Organization header' },
    ],
  },
  {
    id: 'airflow',
    name: 'Airflow / Astronomer',
    icon: '🌬️',
    group: 'Orchestration',
    description: 'DAG run context, task logs, resource contention across shared warehouses.',
    fields: [
      { key: 'AIRFLOW_HOST', label: 'Airflow host', placeholder: 'https://your-airflow.astronomer.io', isSecret: false },
      { key: 'AIRFLOW_API_KEY', label: 'API key', placeholder: 'astronomer-api-key', isSecret: true, hint: 'Astronomer workspace → API keys' },
    ],
  },
  {
    id: 'prefect',
    name: 'Prefect',
    icon: '🌀',
    group: 'Orchestration',
    description: 'Flow run context, task state, deployment history.',
    fields: [
      { key: 'PREFECT_API_URL', label: 'API URL', placeholder: 'https://api.prefect.cloud/api/accounts/YOUR_ID/workspaces/YOUR_WS', isSecret: false },
      { key: 'PREFECT_API_KEY', label: 'API key', placeholder: 'pnu_...', isSecret: true },
    ],
  },
  {
    id: 'fivetran',
    name: 'Fivetran',
    icon: '🔌',
    group: 'Ingestion',
    description: 'Connector sync status, row counts, schema changes. Detects silent 0-row failures.',
    docsUrl: 'https://fivetran.com/docs/rest-api',
    fields: [
      { key: 'FIVETRAN_API_KEY', label: 'API key', placeholder: 'fivetran-api-key', isSecret: true, hint: 'Fivetran → Settings → API Config' },
      { key: 'FIVETRAN_API_SECRET', label: 'API secret', placeholder: 'fivetran-api-secret', isSecret: true },
    ],
  },
  {
    id: 'airbyte',
    name: 'Airbyte',
    icon: '🌊',
    group: 'Ingestion',
    description: 'Connection sync status, schema drift, catalog changes.',
    fields: [
      { key: 'AIRBYTE_API_URL', label: 'API URL', placeholder: 'https://api.airbyte.com', isSecret: false },
      { key: 'AIRBYTE_API_KEY', label: 'API key', placeholder: 'airbyte-api-key', isSecret: true },
    ],
  },
  {
    id: 'snowflake',
    name: 'Snowflake',
    icon: '❄️',
    group: 'Transformation',
    description: 'Query history, warehouse utilization, concurrent job detection, data freshness.',
    fields: [
      { key: 'SNOWFLAKE_ACCOUNT', label: 'Account identifier', placeholder: 'orgname-accountname', isSecret: false, hint: 'e.g. xy12345.us-east-1' },
      { key: 'SNOWFLAKE_USER', label: 'Username', placeholder: 'DISPATCH_SVC_ACCT', isSecret: false },
      { key: 'SNOWFLAKE_PASSWORD', label: 'Password', placeholder: '••••••••', isSecret: true },
      { key: 'SNOWFLAKE_WAREHOUSE', label: 'Warehouse', placeholder: 'COMPUTE_WH', isSecret: false },
    ],
  },
  {
    id: 'dbt_cloud',
    name: 'dbt Cloud',
    icon: '🔄',
    group: 'Transformation',
    description: 'Job run details, model test results, lineage, source freshness.',
    docsUrl: 'https://docs.getdbt.com/dbt-cloud/api-v2',
    fields: [
      { key: 'DBT_CLOUD_API_KEY', label: 'API key', placeholder: 'dbt-cloud-api-key', isSecret: true, hint: 'Profile → API Access → Generate new key' },
      { key: 'DBT_CLOUD_ACCOUNT_ID', label: 'Account ID', placeholder: '12345', isSecret: false, hint: 'From your dbt Cloud URL: cloud.getdbt.com/accounts/{id}' },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: '🐙',
    group: 'Knowledge',
    description: 'Real commit history and PRs. Finds the code change that caused the failure.',
    fields: [
      { key: 'GITHUB_TOKEN', label: 'Personal access token', placeholder: 'ghp_...', isSecret: true, hint: 'Settings → Developer settings → Personal access tokens → repo scope' },
      { key: 'GITHUB_REPO_OWNER', label: 'Repo owner', placeholder: 'your-org', isSecret: false },
      { key: 'GITHUB_REPO_NAME', label: 'dbt repo name', placeholder: 'data-platform', isSecret: false },
    ],
  },
  {
    id: 'confluence',
    name: 'Confluence',
    icon: '📖',
    group: 'Knowledge',
    description: 'Search external runbooks alongside internal ones.',
    fields: [
      { key: 'CONFLUENCE_BASE_URL', label: 'Base URL', placeholder: 'https://your-org.atlassian.net', isSecret: false },
      { key: 'CONFLUENCE_TOKEN', label: 'API token', placeholder: 'confluence-api-token', isSecret: true, hint: 'id.atlassian.com → Security → Create and manage API tokens' },
      { key: 'CONFLUENCE_SPACE_KEY', label: 'Space key', placeholder: 'DATA', isSecret: false, hint: 'The space containing your runbooks' },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    icon: '📝',
    group: 'Knowledge',
    description: 'Pull runbooks and incident post-mortems from Notion databases.',
    fields: [
      { key: 'NOTION_API_KEY', label: 'Integration token', placeholder: 'secret_...', isSecret: true, hint: 'notion.so/my-integrations → Create integration' },
      { key: 'NOTION_DATABASE_ID', label: 'Runbook database ID', placeholder: '32-char UUID from page URL', isSecret: false },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    icon: '💬',
    group: 'Alerting',
    description: 'Post triage reports to #data-alerts automatically on failure.',
    fields: [
      { key: 'SLACK_WEBHOOK_URL', label: 'Incoming webhook URL', placeholder: 'https://hooks.slack.com/services/...', isSecret: true, hint: 'api.slack.com/apps → Incoming Webhooks → Add New Webhook' },
      { key: 'SLACK_CHANNEL', label: 'Default channel', placeholder: '#data-alerts', isSecret: false },
    ],
  },
  {
    id: 'pagerduty',
    name: 'PagerDuty',
    icon: '🔔',
    group: 'Alerting',
    description: 'Auto-page on High confidence failures, check on-call schedule.',
    fields: [
      { key: 'PAGERDUTY_API_KEY', label: 'API key', placeholder: 'pagerduty-api-key', isSecret: true, hint: 'PagerDuty → Integrations → API Access Keys' },
      { key: 'PAGERDUTY_SERVICE_ID', label: 'Service ID', placeholder: 'P1234AB', isSecret: false },
    ],
  },
];

const GROUPS = ['Orchestration', 'Ingestion', 'Transformation', 'Knowledge', 'Alerting'];

// --- Types ---
type SettingValue = { value: string | null; source: 'db' | 'env' | 'unset'; isSecret: boolean; updatedAt?: string };
type SavedSettings = Record<string, Record<string, SettingValue>>;
type DraftSettings = Record<string, Record<string, string>>;

export default function SettingsPage() {
  const [savedSettings, setSavedSettings] = useState<SavedSettings>({});
  const [drafts, setDrafts] = useState<DraftSettings>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings');
      const data = await res.json() as SavedSettings;
      setSavedSettings(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const getFieldValue = (integrationId: string, key: string): string => {
    // Show draft first, then saved value
    return drafts[integrationId]?.[key] ?? savedSettings[integrationId]?.[key]?.value ?? '';
  };

  const isConnected = (integrationId: string): boolean => {
    const intSaved = savedSettings[integrationId];
    if (!intSaved) return false;
    return Object.values(intSaved).some(v => v.value && v.source !== 'unset');
  };

  const handleFieldChange = (integrationId: string, key: string, value: string) => {
    setDrafts(prev => ({
      ...prev,
      [integrationId]: { ...(prev[integrationId] ?? {}), [key]: value },
    }));
  };

  const handleSave = async (integration: typeof INTEGRATION_CONFIGS[0]) => {
    setSaving(integration.id);
    try {
      const fieldValues = integration.fields.map(f => ({
        key: f.key,
        value: drafts[integration.id]?.[f.key] ?? '',
        isSecret: f.isSecret,
      })).filter(f => f.value && f.value !== '••••••••');

      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationId: integration.id, settings: fieldValues }),
      });

      // Clear drafts for this integration and reload
      setDrafts(prev => { const next = { ...prev }; delete next[integration.id]; return next; });
      await loadSettings();
      setSaved(integration.id);
      setTimeout(() => setSaved(null), 3000);
    } finally {
      setSaving(null);
    }
  };

  const handleClear = async (integrationId: string) => {
    await fetch(`/api/settings?integrationId=${integrationId}`, { method: 'DELETE' });
    setDrafts(prev => { const next = { ...prev }; delete next[integrationId]; return next; });
    await loadSettings();
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition">← Dispatch</Link>
          <span className="text-zinc-700">/</span>
          <span className="text-sm font-medium text-zinc-300">Settings</span>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/integrations" className="text-xs text-zinc-600 hover:text-zinc-400 transition">Integration docs →</Link>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">Integration Settings</h1>
          <p className="text-sm text-zinc-500 max-w-2xl">
            Configure your data stack connections. Values are stored in Neon and used at runtime
            alongside environment variables. Secrets are masked after saving.
          </p>
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-amber-800/30 bg-amber-950/10 px-3 py-1.5">
            <span className="text-xs text-amber-400">⚠️</span>
            <span className="text-xs text-amber-400/80">
              Demo mode: values stored in plaintext. Production: use Vercel env vars or a secrets manager.
            </span>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex items-center gap-2 text-zinc-500 text-sm">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              Loading settings...
            </div>
          </div>
        ) : (
          GROUPS.map(group => {
            const groupIntegrations = INTEGRATION_CONFIGS.filter(i => i.group === group);
            return (
              <div key={group} className="mb-8">
                <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-3">{group}</h2>
                <div className="space-y-4">
                  {groupIntegrations.map(integration => {
                    const connected = isConnected(integration.id);
                    const hasDraft = Object.keys(drafts[integration.id] ?? {}).some(
                      k => drafts[integration.id][k]
                    );

                    return (
                      <div key={integration.id} className={`rounded-xl border px-5 py-4 ${
                        connected ? 'border-green-800/30 bg-green-950/5' : 'border-zinc-800 bg-zinc-900/20'
                      }`}>
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">{integration.icon}</span>
                            <div>
                              <div className="flex items-center gap-2">
                                <h3 className="text-sm font-semibold text-zinc-200">{integration.name}</h3>
                                {connected ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-400">
                                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />Connected
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-500">
                                    <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />Not configured
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-zinc-600 mt-0.5">{integration.description}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {integration.docsUrl && (
                              <a href={integration.docsUrl} target="_blank" rel="noopener noreferrer"
                                className="text-xs text-zinc-700 hover:text-zinc-400 transition">docs →</a>
                            )}
                            {connected && (
                              <button onClick={() => handleClear(integration.id)}
                                className="text-xs text-zinc-700 hover:text-red-400 transition">clear</button>
                            )}
                          </div>
                        </div>

                        <div className="space-y-2.5">
                          {integration.fields.map(field => {
                            const currentValue = getFieldValue(integration.id, field.key);
                            const savedVal = savedSettings[integration.id]?.[field.key];
                            const isFromEnv = savedVal?.source === 'env';

                            return (
                              <div key={field.key}>
                                <div className="flex items-center gap-2 mb-1">
                                  <label className="text-xs font-medium text-zinc-400">{field.label}</label>
                                  <code className="text-xs font-mono text-zinc-600">{field.key}</code>
                                  {isFromEnv && (
                                    <span className="text-xs text-zinc-600 italic">set via env var</span>
                                  )}
                                </div>
                                <input
                                  type={field.isSecret ? 'password' : 'text'}
                                  value={currentValue}
                                  onChange={e => handleFieldChange(integration.id, field.key, e.target.value)}
                                  placeholder={isFromEnv ? '(overrides env var)' : field.placeholder}
                                  disabled={isFromEnv}
                                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-700 outline-none transition focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed font-mono"
                                />
                                {field.hint && (
                                  <p className="mt-0.5 text-xs text-zinc-600">{field.hint}</p>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div className="mt-3 flex items-center justify-between">
                          <div />
                          <button
                            onClick={() => handleSave(integration)}
                            disabled={!hasDraft || saving === integration.id}
                            className={`inline-flex items-center gap-2 rounded-lg px-4 py-1.5 text-xs font-semibold transition ${
                              saved === integration.id
                                ? 'bg-green-600 text-white'
                                : hasDraft
                                ? 'bg-orange-600 text-white hover:bg-orange-500'
                                : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                            }`}
                          >
                            {saving === integration.id ? (
                              <>
                                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                                </svg>
                                Saving...
                              </>
                            ) : saved === integration.id ? (
                              <>✓ Saved</>
                            ) : (
                              'Save'
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
