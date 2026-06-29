// Data catalog integration — the institutional knowledge gold mine.
//
// A data catalog has what no orchestrator has: a COMPLETE, vendor-neutral
// lineage graph built by scanning query history, dbt artifacts, Spark jobs,
// etc. If you have one of these, you don't need to infer lineage — it's there.
//
// Supported catalogs:
//
//   Datahub (open source, LinkedIn)        — REST API, /api/graphql
//   OpenMetadata (open source)             — REST API, /api/v1/lineage
//   Atlan (commercial)                     — GraphQL + REST
//   Select Star (commercial, lightweight)  — REST API
//   dbt Cloud artifact API                 — /api/v2/accounts/{id}/artifacts → manifest.json
//   dbt manifest.json (local/S3/GCS)       — direct parse, EXACT lineage graph
//
// The dbt manifest.json is the most practical:
//   - Every dbt project produces one on each run
//   - nodes[*].depends_on.nodes[] = exact lineage edges
//   - No external service needed — read from S3/GCS or dbt Cloud API
//   - Dispatch can ingest it once and cache in Neon for fast lookups
//
// Architecture diagrams (Lucidchart, Miro, draw.io):
//   - Hard to parse automatically, BUT users can paste a text description
//   - "SHOPIFY API → Fivetran → RAW.SHOPIFY.ORDERS → stg_orders → fct_orders → Looker"
//   - Store as a runbook with pipeline_name = '*' (applies to all pipelines)
//   - Dispatch searches this during triage just like any other runbook
//
// Schema registries (Confluent, Glue Schema Registry):
//   - Kafka topic schemas — helps with streaming lineage + schema drift
//   - Glue: list_schemas(), get_schema_version() via AWS SDK

import { getSetting } from '../settings';
import { sql } from '../db';

// ---------------------------------------------------------------------------
// The canonical lineage edge from any catalog
// ---------------------------------------------------------------------------
export interface LineageEdge {
  upstreamId: string;   // fully qualified: "snowflake://PROD.RAW.SHOPIFY_ORDERS"
  downstreamId: string; // or "dbt://my_project/fct_orders"
  edgeType: 'data_flow' | 'transformation' | 'copy' | 'unknown';
  sourceCatalog: 'datahub' | 'openmetadata' | 'atlan' | 'dbt_manifest' | 'dbt_cloud' | 'select_star' | 'inferred';
  confidence: 'exact' | 'high' | 'medium';
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// dbt manifest.json — the most practical catalog source
//
// Location options (check in order):
//   1. DISPATCH_DBT_MANIFEST_URL env var — S3/GCS presigned URL or HTTP
//   2. dbt Cloud API: /api/v2/accounts/{id}/runs/latest/artifacts/manifest.json
//   3. GitHub: read from repo artifact storage path
//   4. Neon: cached manifest stored at last dbt run
// ---------------------------------------------------------------------------

interface DbtManifestNode {
  unique_id: string;             // "model.my_project.fct_orders"
  name: string;                  // "fct_orders"
  resource_type: string;         // "model", "seed", "source", "test"
  schema: string;
  database?: string;
  depends_on: { nodes: string[] };
  config?: { materialized?: string };
  description?: string;
  // Sources have fqn but no depends_on (they ARE the source)
  source_name?: string;
  identifier?: string;
}

interface DbtManifest {
  metadata: { dbt_schema_version: string; generated_at: string };
  nodes: Record<string, DbtManifestNode>;
  sources: Record<string, DbtManifestNode>;
}

export async function loadDbtManifest(): Promise<DbtManifest | null> {
  // 1. Env var URL
  const manifestUrl = process.env.DISPATCH_DBT_MANIFEST_URL
    ?? await getSetting('dbt', 'DBT_MANIFEST_URL');

  if (manifestUrl) {
    try {
      const resp = await fetch(manifestUrl, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) return resp.json() as Promise<DbtManifest>;
    } catch (err) {
      console.warn('[datacatalog] manifest fetch failed:', err);
    }
  }

  // 2. dbt Cloud API
  const dbtCloudToken = await getSetting('dbt', 'DBT_CLOUD_TOKEN');
  const dbtCloudAccountId = await getSetting('dbt', 'DBT_CLOUD_ACCOUNT_ID');
  if (dbtCloudToken && dbtCloudAccountId) {
    try {
      const resp = await fetch(
        `https://cloud.getdbt.com/api/v2/accounts/${dbtCloudAccountId}/runs/latest/artifacts/manifest.json`,
        { headers: { 'Authorization': `Token ${dbtCloudToken}` }, signal: AbortSignal.timeout(10000) }
      );
      if (resp.ok) return resp.json() as Promise<DbtManifest>;
    } catch (err) {
      console.warn('[datacatalog] dbt Cloud manifest fetch failed:', err);
    }
  }

  return null;
}

// Convert dbt manifest into LineageEdges — every ref() and source() becomes an edge
export function dbtManifestToEdges(manifest: DbtManifest): LineageEdge[] {
  const edges: LineageEdge[] = [];

  const allNodes = { ...manifest.nodes, ...manifest.sources };

  for (const [nodeId, node] of Object.entries(allNodes)) {
    if (!node.depends_on?.nodes) continue;
    for (const upstreamId of node.depends_on.nodes) {
      edges.push({
        upstreamId,
        downstreamId: nodeId,
        edgeType: 'transformation',
        sourceCatalog: 'dbt_manifest',
        confidence: 'exact',  // dbt manifest edges ARE the lineage — no inference
      });
    }
  }

  return edges;
}

// Find all upstream nodes for a given asset (BFS walk)
export function walkUpstream(
  targetId: string,
  edges: LineageEdge[],
  maxDepth = 5
): { id: string; depth: number; edgeType: string }[] {
  const visited = new Set<string>();
  const result: { id: string; depth: number; edgeType: string }[] = [];

  function bfs(currentId: string, depth: number): void {
    if (depth > maxDepth || visited.has(currentId)) return;
    visited.add(currentId);
    const upstreamEdges = edges.filter(e => e.downstreamId === currentId);
    for (const edge of upstreamEdges) {
      result.push({ id: edge.upstreamId, depth, edgeType: edge.edgeType });
      bfs(edge.upstreamId, depth + 1);
    }
  }

  bfs(targetId, 1);
  return result;
}

// Find all downstream nodes (what breaks if this fails)
export function walkDownstream(
  sourceId: string,
  edges: LineageEdge[],
  maxDepth = 5
): { id: string; depth: number }[] {
  const visited = new Set<string>();
  const result: { id: string; depth: number }[] = [];

  function bfs(currentId: string, depth: number): void {
    if (depth > maxDepth || visited.has(currentId)) return;
    visited.add(currentId);
    const downstreamEdges = edges.filter(e => e.upstreamId === currentId);
    for (const edge of downstreamEdges) {
      result.push({ id: edge.downstreamId, depth });
      bfs(edge.downstreamId, depth + 1);
    }
  }

  bfs(sourceId, 1);
  return result;
}

// ---------------------------------------------------------------------------
// Datahub — open source, REST/GraphQL
// GET /api/graphql — lineage query
// ---------------------------------------------------------------------------

export async function getDatahubLineage(
  entityUrn: string  // e.g. "urn:li:dataset:(urn:li:dataPlatform:snowflake,PROD.ANALYTICS.FCT_ORDERS,PROD)"
): Promise<{ upstream: string[]; downstream: string[] }> {
  const datahubUrl = await getSetting('datahub', 'DATAHUB_GMS_URL');
  const datahubToken = await getSetting('datahub', 'DATAHUB_TOKEN');
  if (!datahubUrl) return { upstream: [], downstream: [] };

  const query = `
    query GetLineage($urn: String!, $direction: LineageDirection!) {
      searchAcrossLineage(input: { urn: $urn, direction: $direction, count: 50 }) {
        searchResults {
          entity { urn }
        }
      }
    }
  `;

  async function queryDirection(direction: 'UPSTREAM' | 'DOWNSTREAM'): Promise<string[]> {
    try {
      const resp = await fetch(`${datahubUrl}/api/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(datahubToken ? { 'Authorization': `Bearer ${datahubToken}` } : {}),
        },
        body: JSON.stringify({ query, variables: { urn: entityUrn, direction } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return [];
      const data = await resp.json() as { data?: { searchAcrossLineage?: { searchResults?: Array<{ entity: { urn: string } }> } } };
      return data.data?.searchAcrossLineage?.searchResults?.map(r => r.entity.urn) ?? [];
    } catch { return []; }
  }

  const [upstream, downstream] = await Promise.all([
    queryDirection('UPSTREAM'),
    queryDirection('DOWNSTREAM'),
  ]);

  return { upstream, downstream };
}

// ---------------------------------------------------------------------------
// Cache manifest edges in Neon — run once per dbt run, fast lookups after
// ---------------------------------------------------------------------------
export async function cacheManifestEdges(edges: LineageEdge[]): Promise<void> {
  // Store as JSON blob in a settings-like table — simple and queryable
  if (edges.length === 0) return;
  try {
    await sql`
      INSERT INTO settings (org_id, integration, key, value_enc, updated_at)
      VALUES ('default', 'dbt', 'MANIFEST_EDGES_CACHE', ${JSON.stringify(edges)}, NOW())
      ON CONFLICT (org_id, integration, key)
      DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = NOW()
    `;
  } catch (err) {
    console.warn('[datacatalog] cache write failed:', err);
  }
}

export async function loadCachedEdges(): Promise<LineageEdge[]> {
  try {
    const rows = await sql`
      SELECT value_enc FROM settings
      WHERE org_id = 'default' AND integration = 'dbt' AND key = 'MANIFEST_EDGES_CACHE'
      LIMIT 1
    ` as { value_enc: string }[];
    if (!rows[0]) return [];
    return JSON.parse(rows[0].value_enc) as LineageEdge[];
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Main lineage lookup — tries catalog sources in priority order
// ---------------------------------------------------------------------------
export async function getCatalogLineage(assetName: string): Promise<{
  upstream: string[];
  downstream: string[];
  source: 'dbt_manifest' | 'datahub' | 'cached' | 'none';
  confidence: 'exact' | 'high' | 'medium' | 'none';
} | null> {
  // 1. Try dbt manifest (freshest, most specific)
  const manifest = await loadDbtManifest();
  if (manifest) {
    const edges = dbtManifestToEdges(manifest);
    await cacheManifestEdges(edges); // keep cache warm

    // Find matching node by name (case-insensitive)
    const nodeId = Object.keys({ ...manifest.nodes, ...manifest.sources })
      .find(k => k.toLowerCase().endsWith(`.${assetName.toLowerCase()}`));

    if (nodeId) {
      const upstream = walkUpstream(nodeId, edges).map(n => n.id.split('.').pop() ?? n.id);
      const downstream = walkDownstream(nodeId, edges).map(n => n.id.split('.').pop() ?? n.id);
      return { upstream, downstream, source: 'dbt_manifest', confidence: 'exact' };
    }
  }

  // 2. Try cached edges (from last dbt run)
  const cached = await loadCachedEdges();
  if (cached.length > 0) {
    const matchingDownstream = cached.filter(e => e.downstreamId.toLowerCase().includes(assetName.toLowerCase()));
    const matchingUpstream = cached.filter(e => e.upstreamId.toLowerCase().includes(assetName.toLowerCase()));
    if (matchingDownstream.length > 0 || matchingUpstream.length > 0) {
      return {
        upstream: [...new Set(matchingDownstream.map(e => e.upstreamId.split('.').pop() ?? e.upstreamId))],
        downstream: [...new Set(matchingUpstream.map(e => e.downstreamId.split('.').pop() ?? e.downstreamId))],
        source: 'cached',
        confidence: 'high',
      };
    }
  }

  // 3. Try Datahub if configured
  const datahubUrl = await getSetting('datahub', 'DATAHUB_GMS_URL');
  if (datahubUrl) {
    // Construct a URN — Snowflake convention
    const urn = `urn:li:dataset:(urn:li:dataPlatform:snowflake,${assetName.toUpperCase()},PROD)`;
    const result = await getDatahubLineage(urn);
    if (result.upstream.length > 0 || result.downstream.length > 0) {
      return {
        upstream: result.upstream.map(u => u.split(',')[1] ?? u),
        downstream: result.downstream.map(d => d.split(',')[1] ?? d),
        source: 'datahub',
        confidence: 'high',
      };
    }
  }

  return null;
}

export function catalogLineageToText(
  assetName: string,
  result: Awaited<ReturnType<typeof getCatalogLineage>>
): string {
  if (!result || result.confidence === 'none') return '';

  const badge = {
    dbt_manifest: '✓ exact (dbt manifest.json)',
    datahub: '✓ exact (Datahub)',
    cached: '~ cached (last dbt run)',
    none: '',
  }[result.source];

  const lines = [`DATA CATALOG LINEAGE for '${assetName}' [${badge}]:`];

  if (result.upstream.length > 0) {
    lines.push('Upstream (what this depends on):');
    result.upstream.forEach(u => lines.push(`  ← ${u}`));
  }
  if (result.downstream.length > 0) {
    lines.push('Downstream (what breaks if this fails):');
    result.downstream.forEach(d => lines.push(`  → ${d}`));
  }
  if (result.source === 'dbt_manifest') {
    lines.push('\nSource: dbt manifest.json — these are EXACT edges from ref() and source() calls.');
    lines.push('No inference. Configure DISPATCH_DBT_MANIFEST_URL or DBT_CLOUD_TOKEN in /settings.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// getMaterializationOwner — the core triage bridge
//
// Given a table or asset name, return who builds it and how to fix/rerun it.
// This is the key function that turns "table X is broken" into
// "Lambda function Y built it — here's its GitHub path — here's how to rerun."
//
// Sources (in priority order):
//   1. Datahub / catalog ownership metadata (who writes to this dataset)
//   2. dbt manifest (nodes have owner config and description fields)
//   3. Naming conventions + error fingerprints (inferred)
//   4. Neon incidents table (which pipeline_name last failed for this table)
// ---------------------------------------------------------------------------

export type MaterializationTool =
  | 'dagster' | 'airflow' | 'prefect' | 'mage'
  | 'dbt_core' | 'dbt_cloud' | 'sqlmesh'
  | 'lambda' | 'glue' | 'step_functions' | 'app_runner' | 'ecs'
  | 'github_actions' | 'databricks' | 'lakeflow'
  | 'snowflake_task' | 'snowpipe' | 'dynamic_table'
  | 'cron' | 'python_script' | 'unknown';

export interface AssetOwner {
  assetName: string;
  tool: MaterializationTool;
  // Where the code lives — enables GitHub read + PR creation
  githubRepo?: string;
  githubPath?: string;    // e.g. "dags/02_transform_orders.py" or "lambdas/transform/handler.py"
  githubBranch?: string;
  // Tool-specific identifiers for rerun
  toolId?: string;        // DAG ID, Lambda ARN/name, workflow name, Dagster job name, etc.
  deploymentName?: string;// Prefect deployment name, dbt job name
  schedule?: string;      // cron expression if known
  // How to trigger a rerun — drives proposeActions buttons
  rerun: {
    method: 'dagster_api' | 'airflow_api' | 'prefect_api' | 'github_actions_api'
          | 'lambda_invoke' | 'dbt_cloud_api' | 'webhook' | 'manual' | 'unknown';
    description: string;  // human-readable e.g. "Trigger Airflow DAG run via REST API"
    apiHint?: string;     // curl / SDK snippet
  };
  source: 'catalog' | 'manifest' | 'inferred' | 'unknown';
  confidence: 'exact' | 'high' | 'medium' | 'low';
}

// Infer the tool from the node unique_id in dbt manifest
// "model.my_project.stg_orders" → dbt_core
// Source nodes often encode the connector type
function inferToolFromDbtNode(nodeId: string, nodeConfig?: { materialized?: string }): MaterializationTool {
  if (nodeId.startsWith('source.')) return 'unknown'; // source = loaded by connector, not dbt
  if (nodeId.startsWith('model.') || nodeId.startsWith('seed.')) return 'dbt_core';
  if (nodeConfig?.materialized === 'incremental' || nodeConfig?.materialized === 'table') return 'dbt_core';
  return 'dbt_core';
}

// Infer from naming conventions alone
function inferToolFromName(name: string): { tool: MaterializationTool; confidence: 'medium' | 'low' } {
  const n = name.toLowerCase();
  if (n.includes('lambda') || n.includes('_fn_') || n.includes('_func_')) return { tool: 'lambda', confidence: 'medium' };
  if (n.includes('glue') || n.includes('_glue_')) return { tool: 'glue', confidence: 'medium' };
  if (n.includes('dagster') || n.includes('_asset')) return { tool: 'dagster', confidence: 'medium' };
  if (n.includes('airflow') || n.includes('_dag_') || n.includes('dag_')) return { tool: 'airflow', confidence: 'medium' };
  if (n.includes('prefect') || n.includes('_flow_')) return { tool: 'prefect', confidence: 'medium' };
  if (n.includes('dbt') || n.startsWith('stg_') || n.startsWith('int_') || n.startsWith('fct_') || n.startsWith('dim_')) return { tool: 'dbt_core' as MaterializationTool, confidence: 'medium' as const };
  if (n.includes('github') || n.includes('_ci_') || n.includes('workflow')) return { tool: 'github_actions' as MaterializationTool, confidence: 'medium' as const };
  if (n.includes('snowpipe') || n.includes('_pipe')) return { tool: 'snowpipe' as MaterializationTool, confidence: 'medium' as const };
  if (n.includes('_task') || n.includes('snowflake_task')) return { tool: 'snowflake_task' as MaterializationTool, confidence: 'medium' as const };
  if (n.includes('databricks') || n.includes('lakeflow') || n.includes('_dlt')) return { tool: 'lakeflow', confidence: 'medium' };
  if (n.includes('cron') || n.includes('scheduled')) return { tool: 'cron', confidence: 'low' };
  return { tool: 'unknown', confidence: 'low' };
}

// Build a rerun descriptor for each tool type
function buildRerunDescriptor(tool: MaterializationTool, toolId?: string, deploymentName?: string): AssetOwner['rerun'] {
  switch (tool) {
    case 'dagster':
      return {
        method: 'dagster_api',
        description: `Rerun Dagster job '${toolId ?? 'unknown'}' via MCP or Dagster Cloud API`,
        apiHint: toolId ? `dagster job execute -j ${toolId}` : undefined,
      };
    case 'airflow':
      return {
        method: 'airflow_api',
        description: `Trigger Airflow DAG '${toolId ?? 'unknown'}' via REST API`,
        apiHint: toolId ? `POST /api/v1/dags/${toolId}/dagRuns` : undefined,
      };
    case 'prefect':
      return {
        method: 'prefect_api',
        description: `Trigger Prefect deployment '${deploymentName ?? toolId ?? 'unknown'}'`,
        apiHint: `prefect deployment run '${deploymentName ?? toolId ?? 'flow/deployment'}'`,
      };
    case 'github_actions':
      return {
        method: 'github_actions_api',
        description: `Trigger GitHub Actions workflow '${toolId ?? 'unknown'}' via workflow_dispatch`,
        apiHint: toolId ? `gh workflow run ${toolId}` : undefined,
      };
    case 'dbt_core':
    case 'dbt_cloud':
      return {
        method: 'dbt_cloud_api',
        description: `Trigger dbt run for model '${toolId ?? 'unknown'}'`,
        apiHint: toolId ? `dbt run --select ${toolId}` : undefined,
      };
    case 'lambda':
      return {
        method: 'lambda_invoke',
        description: `Invoke Lambda function '${toolId ?? 'unknown'}' via AWS CLI or SDK`,
        apiHint: toolId ? `aws lambda invoke --function-name ${toolId} /dev/stdout` : undefined,
      };
    case 'glue':
      return {
        method: 'manual',
        description: `Start AWS Glue job '${toolId ?? 'unknown'}' via console or CLI`,
        apiHint: toolId ? `aws glue start-job-run --job-name ${toolId}` : undefined,
      };
    case 'snowflake_task':
      return {
        method: 'manual',
        description: `Execute Snowflake Task '${toolId ?? 'unknown'}' manually`,
        apiHint: toolId ? `EXECUTE TASK ${toolId};` : undefined,
      };
    case 'cron':
      return { method: 'manual', description: 'Rerun the cron job manually on the host server' };
    default:
      return { method: 'unknown', description: 'Manual rerun required — tool not identified' };
  }
}

export async function getMaterializationOwner(assetName: string): Promise<AssetOwner> {
  const unknown: AssetOwner = {
    assetName,
    tool: 'unknown',
    rerun: { method: 'unknown', description: 'Tool not identified — check error logs for tool fingerprints' },
    source: 'unknown',
    confidence: 'low',
  };

  // 1. Try dbt manifest — it knows exactly which dbt model produces each node
  const manifest = await loadDbtManifest();
  if (manifest) {
    const allNodes = { ...manifest.nodes, ...manifest.sources };
    const nodeEntry = Object.entries(allNodes).find(([id]) =>
      id.toLowerCase().endsWith(`.${assetName.toLowerCase()}`)
    );
    if (nodeEntry) {
      const [nodeId, node] = nodeEntry;
      const tool = inferToolFromDbtNode(nodeId, node.config);
      return {
        assetName,
        tool,
        githubPath: `models/${node.schema}/${node.name}.sql`,
        toolId: node.name,
        rerun: buildRerunDescriptor(tool, node.name),
        source: 'manifest',
        confidence: 'exact',
      };
    }

    // Check if it's a source node — the ingestion tool (Fivetran, Airbyte, etc.) owns it
    const sourceEntry = Object.entries(manifest.sources).find(([, n]) =>
      n.identifier?.toLowerCase() === assetName.toLowerCase() ||
      n.name?.toLowerCase() === assetName.toLowerCase()
    );
    if (sourceEntry) {
      const [, sourceNode] = sourceEntry;
      // Source schema name tells us the tool (RAW/FIVETRAN → Fivetran, AIRBYTE → Airbyte)
      const schema = sourceNode.schema?.toUpperCase() ?? '';
      const tool: MaterializationTool = ['RAW', 'FIVETRAN'].includes(schema) ? 'unknown' :
        schema === 'AIRBYTE' ? 'unknown' : 'unknown'; // ingestion tools handled separately
      return {
        assetName,
        tool,
        toolId: sourceNode.source_name ?? sourceNode.name,
        rerun: { method: 'manual', description: `This is a source table — trigger the ${sourceNode.source_name ?? 'ingestion'} connector sync` },
        source: 'manifest',
        confidence: 'high',
      };
    }
  }

  // 2. Try Datahub — it has ownership metadata on each dataset
  const datahubUrl = await getSetting('datahub', 'DATAHUB_GMS_URL');
  const datahubToken = await getSetting('datahub', 'DATAHUB_TOKEN');
  if (datahubUrl) {
    // Query Datahub for the dataset's ownership + institutional memory
    const urn = `urn:li:dataset:(urn:li:dataPlatform:snowflake,${assetName.toUpperCase()},PROD)`;
    const query = `
      query GetOwnership($urn: String!) {
        dataset(urn: $urn) {
          ownership { owners { owner { ... on CorpUser { username } ... on CorpGroup { name } } } }
          institutionalMemory { elements { url description } }
          subTypes { typeNames }
        }
      }
    `;
    try {
      const resp = await fetch(`${datahubUrl}/api/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(datahubToken ? { 'Authorization': `Bearer ${datahubToken}` } : {}) },
        body: JSON.stringify({ query, variables: { urn } }),
        signal: AbortSignal.timeout(6000),
      });
      if (resp.ok) {
        const data = await resp.json() as {
          data?: { dataset?: { subTypes?: { typeNames?: string[] } } }
        };
        const subTypes = data.data?.dataset?.subTypes?.typeNames ?? [];
        // subType often contains "dbt Model", "Airflow Task", "Lambda", etc.
        const subType = subTypes[0]?.toLowerCase() ?? '';
        if (subType.includes('dbt')) return { ...unknown, tool: 'dbt_core', source: 'catalog', confidence: 'high', rerun: buildRerunDescriptor('dbt_core', assetName) };
        if (subType.includes('airflow')) return { ...unknown, tool: 'airflow', source: 'catalog', confidence: 'high', rerun: buildRerunDescriptor('airflow', assetName) };
        if (subType.includes('lambda')) return { ...unknown, tool: 'lambda', source: 'catalog', confidence: 'high', rerun: buildRerunDescriptor('lambda', assetName) };
      }
    } catch { /* fall through */ }
  }

  // 3. Check Neon incidents — which pipeline_name last touched this asset
  try {
    const { sql } = await import('../db');
    const rows = await sql`
      SELECT pipeline_name, failure_type, occurred_at
      FROM incidents
      WHERE pipeline_name ILIKE ${'%' + assetName + '%'}
         OR error_message ILIKE ${'%' + assetName + '%'}
      ORDER BY occurred_at DESC LIMIT 3
    ` as { pipeline_name: string; failure_type: string }[];

    if (rows.length > 0) {
      const { tool, confidence } = inferToolFromName(rows[0].pipeline_name);
      return {
        assetName,
        tool,
        toolId: rows[0].pipeline_name,
        rerun: buildRerunDescriptor(tool, rows[0].pipeline_name),
        source: 'inferred',
        confidence,
      };
    }
  } catch { /* fall through */ }

  // 4. Pure name inference
  const { tool, confidence } = inferToolFromName(assetName);
  return {
    assetName,
    tool,
    toolId: assetName,
    rerun: buildRerunDescriptor(tool, assetName),
    source: 'inferred',
    confidence,
  };
}

export function ownerToPromptText(owner: AssetOwner): string {
  const lines = [`MATERIALIZATION OWNER for '${owner.assetName}' [${owner.source}, ${owner.confidence} confidence]:`];
  lines.push(`  Tool: ${owner.tool}`);
  if (owner.toolId) lines.push(`  ID: ${owner.toolId}`);
  if (owner.githubPath) lines.push(`  Code: ${owner.githubRepo ?? 'repo'}/${owner.githubPath}`);
  lines.push(`  Rerun: ${owner.rerun.description}`);
  if (owner.rerun.apiHint) lines.push(`  Command: ${owner.rerun.apiHint}`);
  if (owner.confidence === 'low') {
    lines.push('  ⚠️ Low confidence — connect a data catalog (Datahub) or dbt manifest for exact ownership.');
  }
  return lines.join('\n');
}

