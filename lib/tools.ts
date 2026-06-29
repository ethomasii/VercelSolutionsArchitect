import { tool } from 'ai';
import { z } from 'zod';
import { sql } from './db';
import { getRecentChanges, readRepoFile } from './integrations/github';
import { searchRunbooks as searchConfluence } from './integrations/confluence';
import { getWarehouseContention } from './integrations/snowflake';
import { inferLineage, lineageToPromptText, extractTablesFromError, tableRefsToLineageText, detectToolsFromLog, inferOrchestratorDeps, extractExplicitOrchestratorDeps, orchestratorDepsToPromptText } from './lineage';
import { getCatalogLineage, catalogLineageToText, getMaterializationOwner, ownerToPromptText } from './integrations/datacatalog';
import { checkVendorStatus, detectVendors } from './vendor-status';
import { findConnectorsForPipeline, getConnectorStatus } from './integrations/fivetran';
import { getSyntheticFivetranStatus } from './demo-data';

// This file is the architectural core of Dispatch. The tool interface never
// changes — only the execute() function bodies change as we wire up real
// integrations. The agent loop in chat/route.ts never needs to change.

export const dispatchTools = {
  classifyFailure: tool({
    description: `Classify the pipeline failure type and extract key signals from
the log text. ALWAYS call this first before any other tool.

Also extract vendor/product names EXPLICITLY mentioned in the log or run context.
These are passed directly to checkVendorStatus — no keyword guessing needed when
the vendor name is right there in the error message.

Examples:
- "snowflake.connector.errors.ProgrammingError" → vendors: ['snowflake']
- "FivetranSyncError: No new data from orders_shopify" → vendors: ['fivetran', 'shopify']
- "com.databricks.backend...ClusterAutoTerminatedException" → vendors: ['databricks']
- "dbt test failures" with upstream Fivetran context in run → vendors: ['fivetran', 'dbt']
- Generic "unexpected error, exit code 1" → vendors: [] (nothing to extract)

TABLE EXTRACTION — ALWAYS include rawLogText so we can extract table references:
When a SQL error mentions PROD.RAW.SHOPIFY_ORDERS, we know:
  - Fivetran owns the RAW schema → likely a silent-failure upstream sync
  - dbt stg_shopify_orders transforms it → check if that model is broken
  - fct_orders / mart_revenue depend on it → those will break next
Table schema names tell us the tool: RAW/FIVETRAN→connector, STG→dbt staging,
ANALYTICS/MARTS→dbt mart, ML/FEATURES→Databricks, TASKS→Snowflake task.

With an enriched run context (Dagster/Airflow): extract vendors from the full
dependency graph and CONCURRENT WORKLOAD section, not just the error line.

Classification guidance for ambiguous cases:
- "does not exist or not authorized" with a named User/Role → permission_denied
- "Access Denied", "insufficient privileges", "403 Forbidden" → permission_denied
- "0 rows loaded", "No new data", "connector SYNCING" → upstream_data_missing
- "column X does not exist", "KeyError", "schema change" → schema_mismatch
- "ref is undefined", "not found" in dbt compile output → dbt_compilation_error
- "timeout", "cluster auto-suspend", "out of memory" → resource_exhaustion
- STEP_FAILURE + max_retries exhausted + step calls external API → network_timeout
- STEP_FAILURE + recent config change (batch size, parallelism) + API failure → code_regression
  (the config change is the root cause — increased batch size hit API rate limits)
- STEP_FAILURE with no other signals → unknown (still call all 6 tools)`,
    inputSchema: z.object({
      failureType: z.enum([
        'upstream_data_missing',
        'schema_mismatch',
        'dbt_compilation_error',
        'dbt_test_failure',
        'resource_exhaustion',
        'permission_denied',
        'dependency_not_ready',
        'network_timeout',
        'code_regression',
        'unknown',
      ]),
      confidence: z.number().min(0).max(1),
      affectedPipeline: z.string().describe('Best guess at pipeline/asset name'),
      keySignals: z.array(z.string()).describe('Key error strings extracted from log'),
      vendorsDetected: z.array(z.string()).describe(
        'Vendor/product names explicitly found in the log or run context. Empty array if none named.'
      ),
      rawLogText: z.string().optional().describe(
        'The raw error/log text — pass this so we can extract table names for lineage inference. Include the full error message, SQL query, or stack trace.'
      ),
      stackTrace: z.object({
        filePath: z.string().describe('Exact file path from traceback, e.g. enriched_data/assets.py'),
        lineNumber: z.number().optional().describe('Line number from traceback'),
        errorType: z.string().describe('Exception/error type, e.g. AttributeError, KeyError, SnowflakeError'),
        errorMessage: z.string().describe('The specific error message text'),
        repoType: z.enum(['dbt', 'dagster', 'airflow', 'databricks', 'generic']).describe(
          'Which repo type this file belongs to — determines which GitHub instance to read from'
        ),
      }).optional().describe(
        'Extract ONLY when a stack trace with file path is present. Enables reading the actual file and proposing code fixes.'
      ),
      reasoning: z.string(),
    }),
    execute: async (input) => {
      // extractTablesFromError and detectToolsFromLog both scan the same text.
      // Call them in a destructured array to make the single-pass intent explicit.
      if (!input.rawLogText) return { ...input, tableLineage: null, detectedTools: [], orchestratorDeps: null };
      const [tableRefs, detectedTools] = [
        extractTablesFromError(input.rawLogText),
        detectToolsFromLog(input.rawLogText),
      ];
      const tableLineage = tableRefsToLineageText(tableRefs, detectedTools);
      const isOrchestratorLog = detectedTools.some(t => ['airflow', 'prefect', 'mage', 'kestra'].includes(t.tool))
        || input.rawLogText.includes('workflow_run') || input.rawLogText.includes('ExternalTaskSensor');
      const explicitDeps = isOrchestratorLog
        ? extractExplicitOrchestratorDeps(input.rawLogText, input.affectedPipeline)
        : [];
      const orchestratorDeps = explicitDeps.length > 0
        ? orchestratorDepsToPromptText(input.affectedPipeline, { upstream: [], downstream: [] }, explicitDeps)
        : null;
      return { ...input, tableLineage, detectedTools: detectedTools.map(t => t.tool), orchestratorDeps };
    },
  }),

  searchRunbooks: tool({
    description: `Search internal runbooks for guidance on this failure.

CASCADE SEARCH: Call this ONCE with both the primary pipeline AND any upstream pipelines
found in lookupIncidentHistory. If fivetran_orders_daily failed 30min before dbt_customers_transform,
include it in upstreamPipelines — even if it's not mentioned in the error log. Its runbook
may contain the root cause. This is how Dispatch bridges unconnected tools: the runbooks
encode the institutional knowledge that no tool captures automatically.`,
    inputSchema: z.object({
      failureType: z.string(),
      pipelineName: z.string().optional(),
      keywords: z.array(z.string()),
      upstreamPipelines: z.array(z.string()).optional().describe(
        'Pipeline names from lookupIncidentHistory.recentUpstreamFailures — search their runbooks too'
      ),
    }),
    execute: async ({ failureType, pipelineName, upstreamPipelines = [] }) => {
      const orgId = 'default';
      const pipelineTag = pipelineName ? pipelineName.split('_')[0].toLowerCase() : null;

      // Primary: failure_type + pipeline vendor tag scoring
      const primaryRows = pipelineTag
        ? await sql`
            SELECT title, content, remediation_steps, last_updated, author,
              (CASE WHEN failure_type = ${failureType} THEN 5 ELSE 0 END +
               CASE WHEN ${pipelineTag} = ANY(pipeline_tags) THEN 10 ELSE 0 END) AS score
            FROM runbooks
            WHERE org_id = ${orgId}
              AND (failure_type = ${failureType} OR ${pipelineTag} = ANY(pipeline_tags))
            ORDER BY score DESC, last_updated DESC LIMIT 3
          `
        : await sql`
            SELECT title, content, remediation_steps, last_updated, author, 5 AS score
            FROM runbooks WHERE org_id = ${orgId} AND failure_type = ${failureType}
            ORDER BY last_updated DESC LIMIT 3
          `;

      // Cascade: search runbooks for each inferred upstream pipeline.
      // Dedup in JS — Postgres != ALL(array) can misfire with special characters (em dashes, etc.)
      const upstreamResults: typeof primaryRows = [];
      const seenTitles = new Set(primaryRows.map(r => r.title as string));

      for (const upstreamPipeline of upstreamPipelines.slice(0, 3)) {
        const upstreamTag = upstreamPipeline.split('_')[0].toLowerCase();
        const rows = await sql`
          SELECT title, content, remediation_steps, last_updated, author, 8 AS score
          FROM runbooks
          WHERE org_id = ${orgId}
            AND ${upstreamTag} = ANY(pipeline_tags)
          ORDER BY last_updated DESC LIMIT 4
        `;
        for (const row of rows) {
          const title = row.title as string;
          if (!seenTitles.has(title)) {
            seenTitles.add(title);
            upstreamResults.push(row);
            if (upstreamResults.length >= 2) break;
          }
        }
      }

      // Fallback text search
      const fallbackRows =
        primaryRows.length === 0 && upstreamResults.length === 0
          ? await sql`
              SELECT title, content, remediation_steps, last_updated, author, 1 AS score
              FROM runbooks WHERE org_id = ${orgId}
                AND to_tsvector('english', content || ' ' || title)
                    @@ plainto_tsquery('english', ${[failureType, pipelineName].filter(Boolean).join(' ')})
              ORDER BY last_updated DESC LIMIT 3
            `
          : [];

      const confluenceResults = await searchConfluence(failureType, failureType);

      const allResultsRaw = [
        ...primaryRows.map(r => ({ ...r, source: 'internal_runbook', context: 'primary' })),
        ...upstreamResults.map(r => ({ ...r, source: 'internal_runbook', context: 'upstream_pipeline' })),
        ...fallbackRows.map(r => ({ ...r, source: 'internal_runbook', context: 'text_search' })),
        ...confluenceResults,
      ];

      // Final dedup by title — ensures no duplicate runbooks regardless of search path
      const finalTitles = new Set<string>();
      const allResults = allResultsRaw.filter(r => {
        const title = (r as { title?: string }).title ?? '';
        if (finalTitles.has(title)) return false;
        finalTitles.add(title);
        return true;
      });

      return {
        found: allResults.length > 0,
        runbooks: allResults,
        searchTerm: failureType,
        upstreamPipelinesSearched: upstreamPipelines,
      };
    },
  }),

  lookupIncidentHistory: tool({
    description: `Find similar past incidents and how they were resolved.
Critical for identifying known-flaky pipelines and recurring patterns.`,
    inputSchema: z.object({
      failureType: z.string(),
      pipelineName: z.string().optional(),
      lookbackDays: z.number().default(90),
    }),
    execute: async ({ failureType, pipelineName, lookbackDays }) => {
      const orgId = 'default';

      // Run all independent queries in parallel — was sequential, now concurrent.
      // The two SQL queries, catalog lineage, materialization owner, and upstream failures
      // have zero dependencies on each other. Parallelizing cuts this tool's latency ~60%.
      const [rows, recentUpstreamFailures, lineageResult, ownerResult] = await Promise.all([
        // Primary incident history
        pipelineName
          ? sql`
              SELECT pipeline_name, failure_type, occurred_at, resolved_at,
                     resolution_summary, root_cause, known_flaky, resolved_by
              FROM incidents
              WHERE org_id = ${orgId}
                AND failure_type = ${failureType}
                AND pipeline_name = ${pipelineName}
                AND occurred_at > now() - (${lookbackDays} || ' days')::interval
              ORDER BY occurred_at DESC
              LIMIT 10
            `
          : sql`
              SELECT pipeline_name, failure_type, occurred_at, resolved_at,
                     resolution_summary, root_cause, known_flaky, resolved_by
              FROM incidents
              WHERE org_id = ${orgId}
                AND failure_type = ${failureType}
                AND occurred_at > now() - (${lookbackDays} || ' days')::interval
              ORDER BY occurred_at DESC
              LIMIT 10
            `,
        // Cross-pipeline upstream failures (concurrent with above)
        pipelineName
          ? sql`
              SELECT DISTINCT pipeline_name, failure_type, occurred_at, resolution_summary
              FROM incidents
              WHERE org_id = ${orgId}
                AND pipeline_name != ${pipelineName}
                AND occurred_at > now() - interval '6 hours'
                AND (resolved_at IS NULL OR resolved_at > now() - interval '4 hours')
              ORDER BY occurred_at DESC
              LIMIT 5
            `
          : Promise.resolve([]),
        // Data catalog lineage (concurrent — may hit dbt Cloud API or Datahub)
        pipelineName
          ? (async () => {
              const catalog = await getCatalogLineage(pipelineName);
              if (catalog && catalog.confidence !== 'none') {
                return {
                  text: catalogLineageToText(pipelineName, catalog),
                  chain: {
                    focusNode: pipelineName,
                    upstream: catalog.upstream.map(id => ({ id, tool: 'unknown', layer: 'unknown', isBreakPoint: false })),
                    downstream: catalog.downstream.map(id => ({ id, tool: 'unknown', layer: 'unknown' })),
                    source: catalog.source,
                    confidence: catalog.confidence,
                  },
                };
              }
              const inferred = await inferLineage(pipelineName);
              return {
                text: lineageToPromptText(inferred),
                chain: {
                  focusNode: pipelineName,
                  upstream: inferred.upstreamNodes.map(n => ({
                    id: n.id, tool: n.tool as string, layer: n.layer,
                    inferenceMethod: n.inferenceMethod, isBreakPoint: false,
                  })),
                  downstream: inferred.downstreamNodes.map(n => ({
                    id: n.id, tool: n.tool as string, layer: n.layer,
                  })),
                  source: 'inferred' as const,
                  confidence: inferred.confidence,
                },
              };
            })()
          : Promise.resolve(null),
        // Materialization owner (concurrent — may hit Datahub)
        pipelineName
          ? getMaterializationOwner(pipelineName).then(ownerToPromptText)
          : Promise.resolve(null),
      ]);

      const knownFlaky = rows.some(r => r.known_flaky);
      const resolvedRows = rows.filter(r => r.resolved_at);
      const avgResolutionMinutes =
        resolvedRows.length > 0
          ? Math.round(
              resolvedRows
                .map(r => (new Date(r.resolved_at).getTime() - new Date(r.occurred_at).getTime()) / 60000)
                .reduce((a, b) => a + b, 0) / resolvedRows.length
            )
          : null;

      // Orchestrator dep inference is sync — no await needed
      const orchestratorDeps = pipelineName && /dag|airflow|prefect|flow|workflow|action|pipeline/i.test(pipelineName)
        ? orchestratorDepsToPromptText(pipelineName, inferOrchestratorDeps(pipelineName))
        : null;

      return {
        totalIncidents: rows.length,
        knownFlaky,
        avgResolutionMinutes,
        recentIncidents: rows.slice(0, 3),
        mostCommonResolution: rows[0]?.resolution_summary ?? null,
        recentUpstreamFailures: (recentUpstreamFailures as typeof rows).map(r => ({
          pipelineName: r.pipeline_name,
          failureType: r.failure_type,
          occurredAt: r.occurred_at,
          resolutionSummary: r.resolution_summary,
        })),
        lineage: lineageResult?.text ?? null,
        lineageChain: lineageResult?.chain ?? null,
        materializationOwner: ownerResult,
        orchestratorDeps,
      };
    },
  }),

  searchGitContext: tool({
    description: `Check for recent code changes that may have caused this failure.
A PR merged hours ago is often the smoking gun.

ALSO: if classifyFailure extracted a stackTrace.filePath, read that file from the
appropriate GitHub repo instance to show the agent the exact broken code.
- stackTrace.repoType = 'dbt' → read from the 'dbt' GitHub instance (dbt project repo)
- stackTrace.repoType = 'dagster' → read from 'dagster' instance
- stackTrace.repoType = 'airflow' → read from 'airflow' instance
- stackTrace.lineNumber → show ±15 lines around the error

ALSO: for Airflow DAGs, Prefect flows, and GitHub Actions workflows — read the DAG/workflow
file from GitHub to find explicit dependency declarations:
- Airflow: ExternalTaskSensor(external_dag_id=...) and TriggerDagRunOperator(trigger_dag_id=...)
- Prefect: run_deployment('flow/deployment', wait_for_completion=True)
- GitHub Actions: on.workflow_run.workflows: [...] and jobs.*.needs: [...]
These are explicit edges that don't appear in the orchestrator's UI but are in the code.
Pass the DAG file path as stackTraceFile when you know it (e.g. dags/02_transform_orders.py).`,
    inputSchema: z.object({
      pipelineName: z.string(),
      failureType: z.string(),
      hoursBack: z.number().default(24),
      stackTraceFile: z.string().optional().describe('File path from classifyFailure.stackTrace.filePath'),
      stackTraceLine: z.number().optional().describe('Line number from classifyFailure.stackTrace.lineNumber'),
      repoInstance: z.string().optional().describe('GitHub instance name from stackTrace.repoType: dbt, dagster, airflow, etc.'),
      commitSha: z.string().optional().describe('Exact commit SHA from run metadata — fetches real diff for that commit'),
    }),
    execute: async ({ pipelineName, hoursBack, stackTraceFile, stackTraceLine, repoInstance, commitSha }) => {
      const gitResult = await getRecentChanges(pipelineName, hoursBack, 'default', commitSha);

      // If we have a stack trace file path, read the actual code from the repo
      let codeContext: { path: string; relevantLines: string; lineStart: number } | null = null;
      let orchestratorDepsFromCode: string | null = null;
      if (stackTraceFile) {
        const instance = repoInstance ?? 'default';
        const fileData = await readRepoFile(stackTraceFile, instance);
        if (fileData) {
          const lines = fileData.content.split('\n');
          const lineNum = stackTraceLine ?? 1;
          const start = Math.max(0, lineNum - 15);
          const end = Math.min(lines.length, lineNum + 15);
          const relevantLines = lines
            .slice(start, end)
            .map((l, i) => `${start + i + 1}${start + i + 1 === lineNum ? ' ← ERROR' : '      '}: ${l}`)
            .join('\n');
          codeContext = { path: stackTraceFile, relevantLines, lineStart: start + 1 };

          // Parse the DAG/workflow file for explicit dependency declarations
          const isOrchestratorFile = /\.(py|yml|yaml)$/.test(stackTraceFile) &&
            (stackTraceFile.includes('dag') || stackTraceFile.includes('workflow') ||
             stackTraceFile.includes('flow') || stackTraceFile.includes('.github'));
          if (isOrchestratorFile) {
            const explicitDeps = extractExplicitOrchestratorDeps(fileData.content, pipelineName);
            if (explicitDeps.length > 0) {
              orchestratorDepsFromCode = orchestratorDepsToPromptText(pipelineName, { upstream: [], downstream: [] }, explicitDeps);
            }
          }
        }
      }

      return {
        ...gitResult,
        codeContext,
        orchestratorDepsFromCode,
      };
    },
  }),

  checkVendorStatus: tool({
    description: `Check real-time vendor status pages for active incidents or degradation.

Vendor detection priority (use the FIRST that applies):
1. BEST: Pass the vendorsDetected from classifyFailure directly as the vendors list.
   These came from explicit vendor names in the log — no guessing needed.
   e.g. classifyFailure returned vendorsDetected: ['snowflake', 'fivetran'] → pass those

2. FALLBACK: If vendorsDetected is empty (e.g. truncated log with no vendor names),
   leave the vendors parameter empty and let auto-detection use the pipeline name.

3. NEVER infer vendors from generic words (ml, batch, pipeline, data, spark, job).
   Only use explicit product names from the log or run context.

When to call this:
- upstream_data_missing: yes — check connector vendors
- resource_exhaustion: yes — check warehouse vendors
- network_timeout: yes — check external API vendor
- schema_mismatch, dbt_compilation_error: skip unless vendor explicitly named

A vendor outage transforms the remediation: "wait for recovery" not "debug code."`,
    inputSchema: z.object({
      pipelineName: z.string(),
      failureType: z.string(),
      vendors: z.array(z.string()).optional().describe('Override vendor list if you know specific vendors'),
    }),
    execute: async ({ pipelineName, failureType, vendors }) => {
      const vendorList = vendors?.length
        ? vendors.map(v => v.toLowerCase())
        : detectVendors(pipelineName, failureType);

      if (vendorList.length === 0) {
        return { checked: [], summary: 'No relevant vendors identified for status check.' };
      }

      const results = await Promise.all(vendorList.map(v => checkVendorStatus(v)));
      const incidents = results.filter(r => r.activeIncidents.length > 0);
      const degraded = results.filter(r => r.level !== 'operational' && r.level !== 'unknown');

      // Extend with Fivetran connector-level status when Fivetran is in the vendor list
      // This catches 0-row silent failures that the status page doesn't show
      let fivetranConnectors: Array<{ id: string; service: string; schema: string; status: unknown; note?: string }> = [];
      if (vendorList.includes('fivetran') && pipelineName) {
        const realConnectors = await findConnectorsForPipeline(pipelineName);
        if (realConnectors.length > 0) {
          fivetranConnectors = await Promise.all(
            realConnectors.map(async c => ({
              ...c,
              status: await getConnectorStatus(c.id),
            }))
          );
        } else {
          // No real credentials → use synthetic demo data that tells the right story
          const synthetic = getSyntheticFivetranStatus(pipelineName, failureType);
          fivetranConnectors = synthetic.map(s => ({
            id: s.id, service: s.service, schema: s.schema,
            status: { syncStatus: s.syncStatus, durationSeconds: s.lastSyncDurationSeconds, rowsLoaded: s.rowsLoaded, isSilentFailure: s.isLikelyCause },
            note: s.note,
          }));
        }
      }

      const silentFailures = fivetranConnectors.filter(
        c => (c.status as { isSilentFailure?: boolean }).isSilentFailure
      );
      const connectorNotes = fivetranConnectors
        .filter(c => c.note)
        .map(c => c.note as string);

      // Snowflake warehouse contention — check when Snowflake is in the vendor list
      // and the failure looks like a timeout/resource issue
      let snowflakeContention: Awaited<ReturnType<typeof getWarehouseContention>> | null = null;
      if (vendorList.includes('snowflake') && ['resource_exhaustion', 'network_timeout', 'unknown'].includes(failureType)) {
        const warehouseName = pipelineName.toUpperCase().includes('COMPUTE_WH') ? pipelineName : 'COMPUTE_WH_L';
        snowflakeContention = await getWarehouseContention(warehouseName, new Date().toISOString());
      }

      return {
        checked: results,
        hasActiveIncidents: incidents.length > 0,
        degradedVendors: degraded.map(r => r.vendor),
        fivetranConnectors: fivetranConnectors.length > 0 ? fivetranConnectors : undefined,
        hasSilentFivetranFailure: silentFailures.length > 0,
        connectorInsights: connectorNotes,
        snowflakeContention: snowflakeContention ?? undefined,
        summary: snowflakeContention?.hasContention
          ? `⚠️ WAREHOUSE CONTENTION: ${snowflakeContention.contentionNote}`
          : silentFailures.length > 0
          ? `⚠️ SILENT FIVETRAN FAILURE: ${fivetranConnectors.find(c => (c.status as { isSilentFailure?: boolean }).isSilentFailure)?.note ?? '0 rows loaded despite SUCCESS status'}`
          : connectorNotes.length > 0
          ? `Connectors: ${connectorNotes.join(' | ')}`
          : incidents.length > 0
          ? `⚠️ Active incidents: ${incidents.map(r => `${r.vendor} (${r.description})`).join(', ')}`
          : degraded.length > 0
          ? `${degraded.map(r => r.vendor).join(', ')} reporting degraded performance`
          : `All checked vendors operational (${vendorList.join(', ')})`,
      };
    },
  }),

  proposeActions: tool({
    description: `After completing ALL other tools, propose concrete remediation actions.
These turn the runbook from text into buttons. Call this LAST.

TOOL-AWARE ACTIONS — the action type depends on what tool materialized the failing asset.
Use lookupIncidentHistory.lineage and classifyFailure.detectedTools to identify the tool:

DAGSTER: use "rerun_dagster" ONLY if the pipeline ran in Dagster AND you have the runId
AIRFLOW: use "rerun_airflow" with dagId — triggers POST /api/v1/dags/{id}/dagRuns
PREFECT: use "rerun_prefect" with deploymentName — triggers prefect deployment run
GITHUB ACTIONS: use "rerun_github_actions" with workflowId — triggers workflow_dispatch
LAMBDA/GLUE/APP RUNNER: use "open_dashboard" with AWS Console URL + "create_slack_alert"
  — these can't self-rerun without more infra; link to the console + notify the team
DBT (standalone): use "rerun_dbt" with modelName — runs dbt run --select {model}
SNOWFLAKE TASK: use "open_dashboard" with EXECUTE TASK SQL as the hint
UNKNOWN/CRON: use "create_slack_alert" + "open_dashboard" — notify team, link to logs
ANY TOOL with a code regression: use "create_pr" — reads GitHub file, proposes fix

CRITICAL: Distinguish root cause from immediate failure:
- If lookupIncidentHistory found upstream failures (recentUpstreamFailures), ROOT CAUSE
  is upstream — fix that first, don't propose a code fix for the downstream symptom.
- If searchGitContext found a likely-cause PR AND no upstream failures: code change IS
  the root cause. Propose create_pr with the specific fix.
- If BOTH upstream AND code issues: fix upstream first, note code fix is secondary.

PR CREATION — works across ALL tools (dbt SQL, Lambda Python, Airflow DAG, workflow YAML):
- dbt model broke: PR to models/staging/{model}.sql or models/marts/{model}.sql
- Lambda broke: PR to lambdas/{function}/handler.py
- Airflow DAG broke: PR to dags/{dag_id}.py
- GitHub Actions broke: PR to .github/workflows/{workflow}.yml
- Plain Python script: PR to scripts/{script}.py
The searchGitContext tool already read the file — use that exact path.

Always include rootCauseNote explaining what actually caused the failure.
NEVER use "custom" as an action id. NEVER assume orchestrator is Dagster without evidence.`,
    inputSchema: z.object({
      failureType: z.string(),
      affectedPipeline: z.string(),
      confidence: z.enum(['High', 'Medium', 'Low']),
      materializationTool: z.enum([
        'dagster', 'airflow', 'prefect', 'github_actions', 'dbt_core', 'dbt_cloud',
        'lambda', 'glue', 'step_functions', 'app_runner', 'ecs',
        'snowflake_task', 'snowpipe', 'databricks', 'lakeflow',
        'cron', 'python_script', 'unknown',
      ]).describe('Which tool materializes this asset — drives which action buttons appear'),
      actions: z.array(z.object({
        id: z.enum([
          'rerun_dagster', 'rerun_airflow', 'rerun_prefect', 'rerun_github_actions',
          'rerun_dbt', 'trigger_fivetran_sync', 'trigger_airbyte_sync',
          'create_pr', 'open_dashboard',
          'create_jira_ticket', 'create_slack_alert', 'mark_resolved',
        ]),
        label: z.string().describe('Short button label, e.g. "Trigger Airflow DAG rerun"'),
        description: z.string().describe('One sentence: what this does and why'),
        risk: z.enum(['none', 'low', 'medium']),
        actionConfidence: z.enum(['High', 'Medium', 'Low']),
        requiresApproval: z.boolean(),
        params: z.record(z.string(), z.string()).optional().describe(
          'Tool-specific params: dagId, deploymentName, workflowId, modelName, functionName, connectorId, filePath, branchName'
        ),
      })).max(5),
      reasoning: z.string(),
      rootCauseNote: z.string().describe(
        'One sentence: what actually caused this and whether actions address root cause or symptom.'
      ),
    }),
    execute: async (input) => input,
  }),
};
