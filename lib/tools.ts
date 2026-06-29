import { tool } from 'ai';
import { z } from 'zod';
import { sql } from './db';
import { getRecentChanges, readRepoFile } from './integrations/github';
import { searchRunbooks as searchConfluence } from './integrations/confluence';
import { checkVendorStatus, detectVendors } from './vendor-status';
import { findConnectorsForPipeline, getConnectorStatus } from './integrations/fivetran';

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
      // Stack trace extraction — enables file reading and code fix proposals
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
    // Passthrough execute so the multi-step loop can continue with a result.
    // The model fills this from log analysis; we just echo back the input.
    // Separating classification from retrieval keeps each tool single-purpose.
    execute: async (input) => input,
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

      // Avoid passing undefined as a SQL parameter — Neon's driver may not handle
      // it correctly. Build two separate queries instead.
      const rows = pipelineName
        ? await sql`
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
        : await sql`
            SELECT pipeline_name, failure_type, occurred_at, resolved_at,
                   resolution_summary, root_cause, known_flaky, resolved_by
            FROM incidents
            WHERE org_id = ${orgId}
              AND failure_type = ${failureType}
              AND occurred_at > now() - (${lookbackDays} || ' days')::interval
            ORDER BY occurred_at DESC
            LIMIT 10
          `;

      const knownFlaky = rows.some(r => r.known_flaky);
      const resolvedRows = rows.filter(r => r.resolved_at);
      const avgResolutionMinutes =
        resolvedRows.length > 0
          ? Math.round(
              resolvedRows
                .map(
                  r =>
                    (new Date(r.resolved_at).getTime() -
                      new Date(r.occurred_at).getTime()) /
                    60000
                )
                .reduce((a, b) => a + b, 0) / resolvedRows.length
            )
          : null;

      // The knownFlaky flag is one of the most useful outputs. If a pipeline has
      // fired 8 times in 90 days and always resolved itself, the recommendation
      // should be "wait 20 minutes" not "page someone." That's institutional
      // knowledge no vendor can provide.

      // Cross-pipeline context: find OTHER pipelines that failed in the same window.
      // This surfaces upstream failures that caused the current failure
      // (e.g., fivetran_orders_daily failing 30min before dbt_customers_transform).
      // With Dagster MCP this would traverse the asset dependency graph instead.
      const recentUpstreamFailures = pipelineName
        ? await sql`
            SELECT DISTINCT pipeline_name, failure_type, occurred_at, resolution_summary
            FROM incidents
            WHERE org_id = ${orgId}
              AND pipeline_name != ${pipelineName}
              AND occurred_at > now() - interval '6 hours'
              AND (resolved_at IS NULL OR resolved_at > now() - interval '4 hours')
            ORDER BY occurred_at DESC
            LIMIT 5
          `
        : [];

      return {
        totalIncidents: rows.length,
        knownFlaky,
        avgResolutionMinutes,
        recentIncidents: rows.slice(0, 3),
        mostCommonResolution: rows[0]?.resolution_summary ?? null,
        recentUpstreamFailures: recentUpstreamFailures.map(r => ({
          pipelineName: r.pipeline_name,
          failureType: r.failure_type,
          occurredAt: r.occurred_at,
          resolutionSummary: r.resolution_summary,
        })),
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

This is what turns a stack trace from a vague hint into an exact line to fix.`,
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
        }
      }

      return {
        ...gitResult,
        codeContext,
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
      let fivetranConnectors: Array<{ id: string; service: string; schema: string; status: unknown }> = [];
      if (vendorList.includes('fivetran') && pipelineName) {
        const connectors = await findConnectorsForPipeline(pipelineName);
        fivetranConnectors = await Promise.all(
          connectors.map(async c => ({
            ...c,
            status: await getConnectorStatus(c.id),
          }))
        );
      }

      const silentFailures = fivetranConnectors.filter(
        c => (c.status as { isSilentFailure?: boolean }).isSilentFailure
      );

      return {
        checked: results,
        hasActiveIncidents: incidents.length > 0,
        degradedVendors: degraded.map(r => r.vendor),
        fivetranConnectors: fivetranConnectors.length > 0 ? fivetranConnectors : undefined,
        hasSilentFivetranFailure: silentFailures.length > 0,
        summary: silentFailures.length > 0
          ? `⚠️ Fivetran SILENT FAILURE: ${silentFailures.map(c => `${c.service} (0 rows, abnormally fast sync)`).join(', ')}`
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

CRITICAL: Distinguish root cause from immediate failure:
- If lookupIncidentHistory found upstream failures (recentUpstreamFailures), the ROOT CAUSE
  is upstream — do NOT propose a code fix for the downstream symptom.
  Instead: propose actions to fix the upstream issue (Fivetran sync, Dagster rerun).
  Include a rootCauseNote explaining why a code fix would be wrong here.
  
- If searchGitContext found a likely-cause PR AND no upstream failures: the code change
  IS the root cause. Propose create_pr with the specific fix.

- If BOTH upstream AND code issues: propose fixing upstream first, note code fix is secondary.

Always include:
- rootCauseNote: one sentence explaining what actually caused this failure
  (e.g., "Fivetran loaded 0 rows 2h before dbt ran — fixing dbt code won't help until data arrives")
- Whether actions address root cause or just restart the symptom

Action types:
- "rerun_dagster": ONLY if the pipeline explicitly ran in Dagster AND you have the runId from the logs
  For Airflow → do NOT use rerun_dagster, use open_dashboard with the Airflow run URL
  For Prefect → do NOT use rerun_dagster, use open_dashboard with the Prefect flow run URL
  For Step Functions / cron / GitHub Actions → use open_dashboard or create_slack_alert instead
- "trigger_fivetran_sync": upstream_data_missing + Fivetran identified as source
- "create_pr": code regression or schema_mismatch where exact file + change is known
- "open_dashboard": link to the relevant tool (Dagster UI, GitHub PR, Airflow DAG, vendor status page)
  Use this for any orchestrator that isn't Dagster, or when no run ID is available
- "create_jira_ticket": any High confidence failure worth tracking  
- "create_slack_alert": always useful to notify the team
- "mark_resolved": when pattern is "wait and it resolves"

NEVER use "custom" as an action id. NEVER assume the orchestrator is Dagster unless explicitly stated.
For Airflow, Prefect, Step Functions, or cron pipelines: use open_dashboard with the correct URL.`,
    inputSchema: z.object({
      failureType: z.string(),
      affectedPipeline: z.string(),
      confidence: z.enum(['High', 'Medium', 'Low']),
      actions: z.array(z.object({
        id: z.enum(['rerun_dagster', 'trigger_fivetran_sync', 'create_jira_ticket', 'create_slack_alert', 'mark_resolved', 'open_dashboard', 'create_pr', 'custom']),        label: z.string().describe('Short button label, e.g. "Trigger Fivetran re-sync"'),
        description: z.string().describe('One sentence: what this does and why'),
        risk: z.enum(['none', 'low', 'medium']),
        actionConfidence: z.enum(['High', 'Medium', 'Low']).describe('How confident you are this fixes the issue'),
        requiresApproval: z.boolean(),
        params: z.record(z.string(), z.string()).optional().describe('Specific params from the log: connector IDs, run IDs, pipeline names'),
      })).max(4),
      reasoning: z.string().describe('Why these specific actions, in order of priority'),
      rootCauseNote: z.string().describe(
        'One sentence: what actually caused this failure and whether the proposed actions address the root cause or just the symptom. E.g. "Fivetran loaded 0 rows 2h before dbt ran — fixing dbt code would not help; trigger Fivetran sync first."'
      ),
    }),
    // Passthrough — model proposes actions, UI renders them as buttons, /api/remediate executes
    execute: async (input) => input,
  }),
};
