import { tool } from 'ai';
import { z } from 'zod';
import { sql } from './db';
import { getRecentChanges } from './integrations/github';
import { searchRunbooks as searchConfluence } from './integrations/confluence';
import { checkVendorStatus, detectVendors } from './vendor-status';

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
  (Snowflake 002003/42S02 can mean either missing object OR access denied;
  when a service account (e.g., DISPATCH_SVC_ACCT, svc_user) and Role are present,
  lean toward permission_denied)
- "Access Denied", "insufficient privileges", "403 Forbidden" → permission_denied
- "0 rows loaded", "No new data", "connector SYNCING" → upstream_data_missing
- "column X does not exist", "KeyError", "schema change" → schema_mismatch
- "ref is undefined", "not found" in dbt compile output → dbt_compilation_error
- "timeout", "cluster auto-suspend", "out of memory" → resource_exhaustion`,
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
        'Vendor/product names explicitly found in the log or run context (e.g. ["snowflake","fivetran"]). Empty array if none named.'
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
A PR merged hours ago is often the smoking gun. Call this for any code_regression
or schema_mismatch classification.`,
    inputSchema: z.object({
      pipelineName: z.string(),
      failureType: z.string(),
      hoursBack: z.number().default(24),
    }),
    execute: async ({ pipelineName, hoursBack }) => {
      // Delegates to /lib/integrations/github.ts.
      // Today: returns simulated data from Neon (source: 'simulated').
      // To wire up real GitHub: set GITHUB_TOKEN env var and update github.ts.
      // This tool's interface never changes — only the integration implementation.
      return await getRecentChanges(pipelineName, hoursBack);
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

      return {
        checked: results,
        hasActiveIncidents: incidents.length > 0,
        degradedVendors: degraded.map(r => r.vendor),
        summary: incidents.length > 0
          ? `⚠️ Active incidents: ${incidents.map(r => `${r.vendor} (${r.description})`).join(', ')}`
          : degraded.length > 0
          ? `${degraded.map(r => r.vendor).join(', ')} reporting degraded performance`
          : `All checked vendors operational (${vendorList.join(', ')})`,
      };
    },
  }),

  proposeActions: tool({
    description: `After completing the triage (all 5 other tools run), propose concrete remediation
actions the engineer can execute with one click. These turn the runbook from text into buttons.

Call this LAST, after all other tools have run and you have the full picture.

For each action:
- Assign a risk level: "none" (read-only, info) | "low" (retrigger, idempotent) | "medium" (changes state)
- Assign confidence: based on how certain you are this action will fix the problem
- Mark requires_approval: true for anything that writes or costs money
- Include specific params extracted from the log/context (connector names, run IDs, etc.)

Action types and when to propose them:
- "rerun_dagster": resource_exhaustion or code_regression where retrying makes sense
- "trigger_fivetran_sync": upstream_data_missing + Fivetran identified
- "create_pr": code_regression or schema_mismatch where the fix is deterministic
  (you know the old value AND the new value from the git context)
  Include: filePath, oldText (exact string to replace), newText, branchName, prTitle, prBody
  Example: PR renamed customer_segment→customer_tier, dbt ref still says customer_segment
  → create_pr to fix that one line. Include the full triage report in prBody.
- "create_jira_ticket": any High confidence failure worth tracking  
- "create_slack_alert": always useful to notify the team
- "mark_resolved": when the runbook says "wait and monitor"
- "open_dashboard": link to the relevant vendor dashboard`,
    inputSchema: z.object({
      failureType: z.string(),
      affectedPipeline: z.string(),
      confidence: z.enum(['High', 'Medium', 'Low']),
      actions: z.array(z.object({
        id: z.enum(['rerun_dagster', 'trigger_fivetran_sync', 'create_jira_ticket', 'create_slack_alert', 'mark_resolved', 'open_dashboard', 'create_pr', 'custom']),
        label: z.string().describe('Short button label, e.g. "Trigger Fivetran re-sync"'),
        description: z.string().describe('One sentence: what this does and why'),
        risk: z.enum(['none', 'low', 'medium']),
        actionConfidence: z.enum(['High', 'Medium', 'Low']).describe('How confident you are this fixes the issue'),
        requiresApproval: z.boolean(),
        params: z.record(z.string(), z.string()).optional().describe('Specific params from the log: connector IDs, run IDs, pipeline names'),
      })).max(4),
      reasoning: z.string().describe('Why these specific actions, in order of priority'),
    }),
    // Passthrough — model proposes actions, UI renders them as buttons, /api/remediate executes
    execute: async (input) => input,
  }),
};
