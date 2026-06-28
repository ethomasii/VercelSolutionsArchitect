'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

// --- Types ---
type SettingValue = { value: string | null; source: 'db' | 'env'; isSecret: boolean; isSet: boolean; updatedAt?: string };
// { [integrationId]: { [instanceName]: { [key]: SettingValue } } }
type SavedSettings = Record<string, Record<string, Record<string, SettingValue>>>;
type DraftSettings = Record<string, Record<string, Record<string, string>>>;

const MASK = '••••••••';

// --- Integration field definitions ---
interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  isSecret: boolean;
  hint?: string;
}

interface IntegrationDef {
  id: string;
  name: string;
  icon: string;
  group: string;
  description: string;
  supportsMultipleInstances?: boolean;
  docsUrl?: string;
  fields: FieldDef[];
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'dagster', name: 'Dagster', icon: '⚡', group: 'Orchestration',
    description: 'Run logs, asset graph traversal, upstream failure detection.',
    supportsMultipleInstances: true,
    docsUrl: 'https://docs.dagster.io/guides/operate/model-context-protocol',
    fields: [
      { key: 'DAGSTER_HOST', label: 'Host URL', placeholder: 'https://your-org.dagster.cloud', isSecret: false, hint: 'Your Dagster+ organization URL' },
      { key: 'DAGSTER_TOKEN', label: 'API Token', placeholder: 'dagster-user-token-...', isSecret: true, hint: 'Admin → User Tokens → Create token' },
      { key: 'DAGSTER_ORG', label: 'Organization slug', placeholder: 'your-org', isSecret: false, hint: 'Used as the Dagster-Cloud-Organization header' },
    ],
  },
  {
    id: 'airflow', name: 'Airflow / Astronomer', icon: '🌬️', group: 'Orchestration',
    description: 'DAG run context, task logs, resource contention detection.',
    supportsMultipleInstances: true,
    fields: [
      { key: 'AIRFLOW_HOST', label: 'Airflow host', placeholder: 'https://your-airflow.astronomer.io', isSecret: false, hint: 'e.g. production, staging, us-east' },
      { key: 'AIRFLOW_API_KEY', label: 'API key', placeholder: 'astronomer-api-key', isSecret: true, hint: 'Astronomer → workspace → API keys' },
    ],
  },
  {
    id: 'prefect', name: 'Prefect', icon: '🌀', group: 'Orchestration',
    supportsMultipleInstances: true,
    description: 'Flow run context, task state, deployment history.',
    fields: [
      { key: 'PREFECT_API_URL', label: 'API URL', placeholder: 'https://api.prefect.cloud/api/accounts/ID/workspaces/WS', isSecret: false },
      { key: 'PREFECT_API_KEY', label: 'API key', placeholder: 'pnu_...', isSecret: true },
    ],
  },
  {
    id: 'fivetran', name: 'Fivetran', icon: '🔌', group: 'Ingestion',
    description: 'Connector sync status, row counts, schema changes. Detects silent 0-row failures.',
    docsUrl: 'https://fivetran.com/docs/rest-api',
    fields: [
      { key: 'FIVETRAN_API_KEY', label: 'API key', placeholder: 'fivetran-api-key', isSecret: true, hint: 'Settings → API Config' },
      { key: 'FIVETRAN_API_SECRET', label: 'API secret', placeholder: 'fivetran-api-secret', isSecret: true },
    ],
  },
  {
    id: 'airbyte', name: 'Airbyte', icon: '🌊', group: 'Ingestion',
    description: 'Connection sync status, schema drift.',
    fields: [
      { key: 'AIRBYTE_API_URL', label: 'API URL', placeholder: 'https://api.airbyte.com', isSecret: false },
      { key: 'AIRBYTE_API_KEY', label: 'API key', placeholder: 'airbyte-api-key', isSecret: true },
    ],
  },
  {
    id: 'snowflake', name: 'Snowflake', icon: '❄️', group: 'Transformation',
    description: 'Query history, warehouse utilization, concurrent job detection.',
    supportsMultipleInstances: true,
    fields: [
      { key: 'SNOWFLAKE_ACCOUNT', label: 'Account', placeholder: 'orgname-accountname', isSecret: false, hint: 'e.g. xy12345.us-east-1' },
      { key: 'SNOWFLAKE_USER', label: 'Username', placeholder: 'DISPATCH_SVC_ACCT', isSecret: false },
      { key: 'SNOWFLAKE_PASSWORD', label: 'Password', placeholder: '', isSecret: true },
      { key: 'SNOWFLAKE_WAREHOUSE', label: 'Warehouse', placeholder: 'COMPUTE_WH', isSecret: false },
    ],
  },
  {
    id: 'dbt_cloud', name: 'dbt Cloud', icon: '🔄', group: 'Transformation',
    description: 'Job run details, model test results, source freshness.',
    docsUrl: 'https://docs.getdbt.com/dbt-cloud/api-v2',
    fields: [
      { key: 'DBT_CLOUD_API_KEY', label: 'API key', placeholder: 'dbt-cloud-api-key', isSecret: true, hint: 'Profile → API Access' },
      { key: 'DBT_CLOUD_ACCOUNT_ID', label: 'Account ID', placeholder: '12345', isSecret: false },
    ],
  },
  {
    id: 'github', name: 'GitHub', icon: '🐙', group: 'Knowledge',
    description: 'Recent commits, PRs, and actual file content. Add multiple instances for dbt, dagster, airflow repos — Dispatch reads files to pinpoint exact broken lines and propose code fixes.',
    supportsMultipleInstances: true,
    fields: [
      { key: 'GITHUB_TOKEN', label: 'Personal access token', placeholder: 'ghp_...', isSecret: true, hint: 'Settings → Developer settings → PAT → repo + pull_requests scopes' },
      { key: 'GITHUB_REPO_OWNER', label: 'Org / owner', placeholder: 'acme-corp', isSecret: false, hint: 'Add separate instances named "dbt", "dagster", "airflow" for each repo' },
      { key: 'GITHUB_REPO_NAME', label: 'Repo name', placeholder: 'data-platform (dbt), dagster-pipelines, airflow-dags...', isSecret: false },
    ],
  },
  {
    id: 'confluence', name: 'Confluence', icon: '📖', group: 'Knowledge',
    description: 'Fan out runbook search to Confluence spaces.',
    fields: [
      { key: 'CONFLUENCE_BASE_URL', label: 'Base URL', placeholder: 'https://your-org.atlassian.net', isSecret: false },
      { key: 'CONFLUENCE_TOKEN', label: 'API token', placeholder: 'confluence-api-token', isSecret: true, hint: 'id.atlassian.com → Security → API tokens' },
      { key: 'CONFLUENCE_SPACE_KEY', label: 'Space key', placeholder: 'DATA', isSecret: false },
    ],
  },
  {
    id: 'notion', name: 'Notion', icon: '📝', group: 'Knowledge',
    description: 'Pull runbooks and incident post-mortems from Notion databases.',
    fields: [
      { key: 'NOTION_API_KEY', label: 'Integration token', placeholder: 'secret_...', isSecret: true, hint: 'notion.so/my-integrations' },
      { key: 'NOTION_DATABASE_ID', label: 'Runbook database ID', placeholder: '32-char UUID', isSecret: false },
    ],
  },
  {
    id: 'slack', name: 'Slack', icon: '💬', group: 'Alerting',
    description: 'Auto-post triage reports to #data-alerts.',
    fields: [
      { key: 'SLACK_WEBHOOK_URL', label: 'Incoming webhook URL', placeholder: 'https://hooks.slack.com/services/...', isSecret: true, hint: 'api.slack.com/apps → Incoming Webhooks' },
      { key: 'SLACK_CHANNEL', label: 'Default channel', placeholder: '#data-alerts', isSecret: false },
    ],
  },
  {
    id: 'pagerduty', name: 'PagerDuty', icon: '🔔', group: 'Alerting',
    description: 'Auto-page on High confidence failures.',
    fields: [
      { key: 'PAGERDUTY_API_KEY', label: 'API key', placeholder: 'pagerduty-api-key', isSecret: true, hint: 'Integrations → API Access Keys' },
      { key: 'PAGERDUTY_SERVICE_ID', label: 'Service ID', placeholder: 'P1234AB', isSecret: false },
    ],
  },
];

const GROUPS = ['Orchestration', 'Ingestion', 'Transformation', 'Knowledge', 'Alerting'];

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-950" />}>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const searchParams = useSearchParams();
  const focusIntegration = searchParams.get('focus');
  const prefillInstance = searchParams.get('instance') ?? 'default';
  const [savedSettings, setSavedSettings] = useState<SavedSettings>({});
  const [drafts, setDrafts] = useState<DraftSettings>({});
  const [newInstanceNames, setNewInstanceNames] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
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

  const getInstances = (integrationId: string): string[] => {
    const saved = Object.keys(savedSettings[integrationId] ?? {});
    if (!saved.includes('default')) saved.unshift('default');
    return [...new Set(saved)];
  };

  const getFieldValue = (integrationId: string, instanceName: string, key: string): string => {
    return drafts[integrationId]?.[instanceName]?.[key]
      ?? savedSettings[integrationId]?.[instanceName]?.[key]?.value
      ?? '';
  };

  const isInstanceConnected = (integrationId: string, instanceName: string): boolean => {
    const inst = savedSettings[integrationId]?.[instanceName];
    return inst ? Object.values(inst).some(v => v.isSet) : false;
  };

  const isLive = (integrationId: string): boolean => {
    return Object.keys(savedSettings[integrationId] ?? {}).some(inst =>
      isInstanceConnected(integrationId, inst)
    );
  };

  const handleFieldChange = (integrationId: string, instanceName: string, key: string, value: string) => {
    setDrafts(prev => ({
      ...prev,
      [integrationId]: {
        ...(prev[integrationId] ?? {}),
        [instanceName]: { ...(prev[integrationId]?.[instanceName] ?? {}), [key]: value },
      },
    }));
  };

  const handleSave = async (integration: IntegrationDef, instanceName: string) => {
    const saveKey = `${integration.id}:${instanceName}`;
    setSaving(saveKey);
    try {
      const fieldValues = integration.fields.map(f => ({
        key: f.key,
        value: drafts[integration.id]?.[instanceName]?.[f.key] ?? '',
        isSecret: f.isSecret,
      })).filter(f => f.value && f.value !== MASK);

      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationId: integration.id, instanceName, settings: fieldValues }),
      });

      setDrafts(prev => {
        const next = { ...prev };
        if (next[integration.id]) {
          const intNext = { ...next[integration.id] };
          delete intNext[instanceName];
          next[integration.id] = intNext;
        }
        return next;
      });
      await loadSettings();
      setSavedKey(saveKey);
      setTimeout(() => setSavedKey(null), 2500);
    } finally {
      setSaving(null);
    }
  };

  const handleAddInstance = async (integration: IntegrationDef) => {
    const name = newInstanceNames[integration.id]?.trim();
    if (!name) return;
    setNewInstanceNames(prev => { const n = { ...prev }; delete n[integration.id]; return n; });
    // Pre-populate the instance in drafts so the form appears
    setDrafts(prev => ({
      ...prev,
      [integration.id]: { ...(prev[integration.id] ?? {}), [name]: {} },
    }));
    setSavedSettings(prev => ({
      ...prev,
      [integration.id]: { ...(prev[integration.id] ?? {}), [name]: {} },
    }));
  };

  const handleClearInstance = async (integrationId: string, instanceName: string) => {
    await fetch(`/api/settings?integrationId=${integrationId}&instanceName=${instanceName}`, { method: 'DELETE' });
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
        <Link href="/integrations" className="text-xs text-zinc-600 hover:text-zinc-400 transition">Integration docs →</Link>
      </header>

      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">Integration Settings</h1>
          <p className="text-sm text-zinc-500 max-w-2xl">
            Configure your data stack. Each integration shows <strong className="text-amber-400 font-medium">DEMO</strong> (synthetic data) or{' '}
            <strong className="text-green-400 font-medium">LIVE</strong> (real API). Secrets are encrypted with AES-256-GCM before storage.
          </p>
          {focusIntegration && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-orange-800/40 bg-orange-950/10 px-3 py-2.5">
              <span className="text-orange-400 shrink-0 text-sm">🔒</span>
              <div>
                <p className="text-xs font-medium text-orange-300">
                  Connect <span className="capitalize font-bold">{focusIntegration}</span> to unlock that action in triage
                </p>
                <p className="text-xs text-orange-400/70 mt-0.5">
                  Scroll to the <span className="capitalize font-medium">{focusIntegration}</span> section below and add your credentials.
                  The action will be available immediately after saving.
                </p>
              </div>
            </div>
          )}
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-blue-800/30 bg-blue-950/10 px-3 py-2">
            <span className="text-blue-400 text-sm shrink-0">🔐</span>
            <div>
              <p className="text-xs text-blue-300 font-medium">Secrets are encrypted at rest</p>
              <p className="text-xs text-blue-400/70 mt-0.5">
                AES-256-GCM using{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-xs">DISPATCH_ENCRYPTION_KEY</code>
                {' '}env var. For production:{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-xs">
                  node -e &ldquo;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;base64&apos;))&rdquo;
                </code>
              </p>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <svg className="h-4 w-4 animate-spin text-zinc-600 mr-2" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            <span className="text-zinc-500 text-sm">Loading settings...</span>
          </div>
        ) : (
          GROUPS.map(group => {
            const groupIntegrations = INTEGRATIONS.filter(i => i.group === group);
            return (
              <div key={group} className="mb-8">
                <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-3">{group}</h2>
                <div className="space-y-4">
                  {groupIntegrations.map(integration => {
                    const live = isLive(integration.id);
                    const instances = getInstances(integration.id);

                    return (
                      <div key={integration.id} className={`rounded-xl border overflow-hidden ${live ? 'border-green-800/30' : 'border-zinc-800'} ${focusIntegration === integration.id ? 'ring-2 ring-orange-500/50' : ''}`}>
                        {/* Integration header */}
                        <div className={`flex items-center gap-3 px-4 py-3 ${live ? 'bg-green-950/10' : 'bg-zinc-900/40'}`}>
                          <span className="text-lg">{integration.icon}</span>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-zinc-200">{integration.name}</span>
                              {live ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-semibold text-green-400">
                                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />LIVE
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-400">
                                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />DEMO
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-zinc-600 mt-0.5">{integration.description}</p>
                          </div>
                          {integration.docsUrl && (
                            <a href={integration.docsUrl} target="_blank" rel="noopener noreferrer"
                              className="text-xs text-zinc-700 hover:text-zinc-400 transition shrink-0">docs →</a>
                          )}
                        </div>

                        {/* Instances */}
                        {instances.map(instanceName => {
                          const instanceConnected = isInstanceConnected(integration.id, instanceName);
                          const saveKey = `${integration.id}:${instanceName}`;
                          const hasDraft = Object.keys(drafts[integration.id]?.[instanceName] ?? {}).some(
                            k => drafts[integration.id]?.[instanceName]?.[k]
                          );

                          return (
                            <div key={instanceName} className="border-t border-zinc-800/60 px-4 py-3">
                              {instances.length > 1 || integration.supportsMultipleInstances ? (
                                <div className="flex items-center justify-between mb-2.5">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium text-zinc-400">
                                      {instanceName === 'default' ? 'Default' : instanceName}
                                    </span>
                                    {instanceConnected && (
                                      <span className="text-xs text-green-600">● connected</span>
                                    )}
                                  </div>
                                  {instanceName !== 'default' && (
                                    <button onClick={() => handleClearInstance(integration.id, instanceName)}
                                      className="text-xs text-zinc-700 hover:text-red-400 transition">remove</button>
                                  )}
                                  {instanceConnected && instanceName === 'default' && (
                                    <button onClick={() => handleClearInstance(integration.id, instanceName)}
                                      className="text-xs text-zinc-700 hover:text-red-400 transition">clear</button>
                                  )}
                                </div>
                              ) : (
                                instanceConnected && (
                                  <div className="flex justify-end mb-2">
                                    <button onClick={() => handleClearInstance(integration.id, instanceName)}
                                      className="text-xs text-zinc-700 hover:text-red-400 transition">clear credentials</button>
                                  </div>
                                )
                              )}

                              <div className="space-y-2">
                                {integration.fields.map(field => {
                                  const currentValue = getFieldValue(integration.id, instanceName, field.key);
                                  const savedVal = savedSettings[integration.id]?.[instanceName]?.[field.key];
                                  const fromEnv = savedVal?.source === 'env';

                                  return (
                                    <div key={field.key}>
                                      <div className="flex items-center gap-2 mb-0.5">
                                        <label className="text-xs font-medium text-zinc-400">{field.label}</label>
                                        <code className="text-xs font-mono text-zinc-700">{field.key}</code>
                                        {fromEnv && <span className="text-xs text-zinc-600 italic">env var</span>}
                                        {savedVal?.isSet && !fromEnv && <span className="text-xs text-green-700">✓ set</span>}
                                      </div>
                                      <input
                                        type={field.isSecret ? 'password' : 'text'}
                                        value={currentValue}
                                        onChange={e => handleFieldChange(integration.id, instanceName, field.key, e.target.value)}
                                        placeholder={fromEnv ? '(set via env var)' : field.placeholder}
                                        disabled={fromEnv}
                                        className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-700 outline-none transition focus:border-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed font-mono"
                                      />
                                      {field.hint && <p className="mt-0.5 text-xs text-zinc-700">{field.hint}</p>}
                                    </div>
                                  );
                                })}
                              </div>

                              <div className="mt-2.5 flex justify-end">
                                <button onClick={() => handleSave(integration, instanceName)}
                                  disabled={!hasDraft || saving === saveKey}
                                  className={`rounded-lg px-4 py-1.5 text-xs font-semibold transition inline-flex items-center gap-1.5 ${
                                    savedKey === saveKey ? 'bg-green-600 text-white'
                                    : hasDraft ? 'bg-orange-600 text-white hover:bg-orange-500'
                                    : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                                  }`}>
                                  {saving === saveKey ? (
                                    <><svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>Saving...</>
                                  ) : savedKey === saveKey ? '✓ Saved'
                                  : 'Save'}
                                </button>
                              </div>
                            </div>
                          );
                        })}

                        {/* Add instance row (for multi-instance integrations) */}
                        {integration.supportsMultipleInstances && (
                          <div className="border-t border-zinc-800/40 px-4 py-2.5 bg-zinc-900/20 flex items-center gap-2">
                            <span className="text-xs text-zinc-700">+ Add instance:</span>
                            <input
                              value={newInstanceNames[integration.id] ?? ''}
                              onChange={e => setNewInstanceNames(prev => ({ ...prev, [integration.id]: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') handleAddInstance(integration); }}
                              placeholder="e.g. production, staging, us-east"
                              className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 placeholder-zinc-700 outline-none focus:border-zinc-700 font-mono"
                            />
                            <button onClick={() => handleAddInstance(integration)}
                              disabled={!newInstanceNames[integration.id]?.trim()}
                              className="rounded px-3 py-1 text-xs font-medium text-zinc-500 border border-zinc-700 hover:text-zinc-300 disabled:opacity-40 transition">
                              Add
                            </button>
                          </div>
                        )}
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
