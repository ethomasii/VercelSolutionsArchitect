// Fivetran integration — connector sync status, row counts, schema changes.
//
// Converts the "upstream_data_missing + Fivetran" scenario from simulated to real.
// Key capability: detect 0-row silent SUCCESS failures that Fivetran doesn't surface as errors.
//
// API docs: https://fivetran.com/docs/rest-api/connectors

import { getSetting } from '../settings';

export interface FivetranConnectorStatus {
  connectorId: string;
  service: string;
  status: string;        // syncing, paused, broken, incomplete
  syncState: string;     // scheduled, syncing, etc.
  lastSyncStart: string | null;
  lastSyncEnd: string | null;
  durationSeconds: number | null;
  rowsSynced: number | null;
  failureMessage: string | null;
  isSilentFailure: boolean; // succeeded but 0 rows — the dangerous case
  source: 'live' | 'unavailable';
}

async function getCredentials(): Promise<{ apiKey: string; apiSecret: string } | null> {
  const apiKey = await getSetting('fivetran', 'FIVETRAN_API_KEY');
  const apiSecret = await getSetting('fivetran', 'FIVETRAN_API_SECRET');
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

// Get connector status by ID
export async function getConnectorStatus(connectorId: string): Promise<FivetranConnectorStatus> {
  const creds = await getCredentials();
  if (!creds) {
    return {
      connectorId, service: 'unknown', status: 'unavailable', syncState: 'unavailable',
      lastSyncStart: null, lastSyncEnd: null, durationSeconds: null, rowsSynced: null,
      failureMessage: null, isSilentFailure: false, source: 'unavailable',
    };
  }

  try {
    const auth = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
    const res = await fetch(`https://api.fivetran.com/v1/connectors/${connectorId}`, {
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Fivetran API ${res.status}`);

    const data = await res.json() as {
      data?: {
        id?: string; service?: string;
        status?: { sync_state?: string; is_historical_sync?: boolean; update_state?: string };
        succeeded_at?: string; failed_at?: string;
        sync_frequency?: number;
        config?: Record<string, unknown>;
      };
    };
    const d = data.data;
    if (!d) throw new Error('Empty Fivetran response');

    // Detect sync duration — abnormally fast syncs (< 30s) with no historical sync = 0 rows
    const lastStart = d.succeeded_at ? new Date(d.succeeded_at).getTime() - 60000 : null; // estimate
    const lastEnd = d.succeeded_at ? new Date(d.succeeded_at).getTime() : null;
    const durationSeconds = lastStart && lastEnd ? Math.round((lastEnd - lastStart) / 1000) : null;

    // Heuristic: sync faster than 30s is suspicious for a connector that normally takes minutes
    const isSilentFailure = !!(durationSeconds && durationSeconds < 30 && d.status?.sync_state === 'scheduled');

    return {
      connectorId: d.id ?? connectorId,
      service: d.service ?? 'unknown',
      status: d.status?.sync_state === 'scheduled' ? 'ok' : (d.status?.sync_state ?? 'unknown'),
      syncState: d.status?.sync_state ?? 'unknown',
      lastSyncStart: d.succeeded_at ?? null,
      lastSyncEnd: d.succeeded_at ?? null,
      durationSeconds,
      rowsSynced: null, // not in connector endpoint — need logs endpoint
      failureMessage: d.failed_at ? `Last failed at: ${d.failed_at}` : null,
      isSilentFailure,
      source: 'live',
    };
  } catch (err) {
    console.warn('[fivetran] getConnectorStatus failed:', err);
    return {
      connectorId, service: 'unknown', status: 'error', syncState: 'error',
      lastSyncStart: null, lastSyncEnd: null, durationSeconds: null, rowsSynced: null,
      failureMessage: String(err), isSilentFailure: false, source: 'unavailable',
    };
  }
}

// List all connectors and find the ones related to a pipeline name
export async function findConnectorsForPipeline(
  pipelineName: string
): Promise<Array<{ id: string; service: string; schema: string }>> {
  const creds = await getCredentials();
  if (!creds) return [];

  try {
    const auth = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
    const res = await fetch('https://api.fivetran.com/v1/connectors?limit=50', {
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];

    const data = await res.json() as {
      data?: { items?: Array<{ id: string; service: string; schema?: string; schema_prefix?: string }> };
    };

    const nameKeywords = pipelineName.toLowerCase().split('_').filter(w => w.length > 3);
    return (data.data?.items ?? [])
      .filter(c => {
        const searchable = `${c.service} ${c.schema ?? ''} ${c.schema_prefix ?? ''}`.toLowerCase();
        return nameKeywords.some(kw => searchable.includes(kw));
      })
      .map(c => ({ id: c.id, service: c.service, schema: c.schema ?? '' }))
      .slice(0, 3);
  } catch {
    return [];
  }
}
