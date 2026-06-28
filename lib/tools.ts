import { tool } from 'ai';
import { z } from 'zod';
import { sql } from './db';
import { getRecentChanges } from './integrations/github';
import { searchRunbooks as searchConfluence } from './integrations/confluence';

// This file is the architectural core of Dispatch. The tool interface never
// changes — only the execute() function bodies change as we wire up real
// integrations. The agent loop in chat/route.ts never needs to change.

export const dispatchTools = {
  classifyFailure: tool({
    description: `Classify the pipeline failure type and extract key signals from
the log text. ALWAYS call this first before any other tool.

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
      reasoning: z.string(),
    }),
    // Passthrough execute so the multi-step loop can continue with a result.
    // The model fills this from log analysis; we just echo back the input.
    // Separating classification from retrieval keeps each tool single-purpose.
    execute: async (input) => input,
  }),

  searchRunbooks: tool({
    description: `Search internal runbooks for guidance on this failure type.
Call after classifyFailure. Returns matching runbook entries with remediation steps.`,
    inputSchema: z.object({
      failureType: z.string(),
      pipelineName: z.string().optional(),
      keywords: z.array(z.string()),
    }),
    execute: async ({ failureType, pipelineName, keywords }) => {
      const orgId = 'default';

      // Extract the first meaningful word from pipeline name as a vendor/tech tag.
      // e.g. "snowflake_raw_ingestion" → "snowflake", "fivetran_orders_daily" → "fivetran"
      // Used as a secondary search signal to make retrieval robust against misclassification.
      const pipelineTag = pipelineName
        ? pipelineName.split('_')[0].toLowerCase()
        : null;

      // Multi-signal scoring: prefer runbooks that match BOTH failure_type AND
      // pipeline vendor tag. If classification is wrong (e.g. "does not exist or not
      // authorized" classified as upstream_data_missing instead of permission_denied),
      // the pipeline tag match still surfaces the right Snowflake runbook.
      //
      // Score:
      //   failure_type AND pipeline tag match: 15  ← most specific
      //   pipeline tag match only:             10  ← vendor-specific beats wrong-type match
      //   failure_type match only:              5  ← generic type match, lowest priority
      const rows = pipelineTag
        ? await sql`
            SELECT title, content, remediation_steps, last_updated, author,
              (CASE WHEN failure_type = ${failureType} THEN 5 ELSE 0 END +
               CASE WHEN ${pipelineTag} = ANY(pipeline_tags) THEN 10 ELSE 0 END) AS score
            FROM runbooks
            WHERE org_id = ${orgId}
              AND (
                failure_type = ${failureType}
                OR ${pipelineTag} = ANY(pipeline_tags)
              )
            ORDER BY score DESC, last_updated DESC
            LIMIT 3
          `
        : await sql`
            SELECT title, content, remediation_steps, last_updated, author,
              10 AS score
            FROM runbooks
            WHERE org_id = ${orgId}
              AND failure_type = ${failureType}
            ORDER BY last_updated DESC
            LIMIT 3
          `;

      // Fallback: broader text search if nothing matched above
      const fallbackRows =
        rows.length === 0
          ? await sql`
              SELECT title, content, remediation_steps, last_updated, author,
                1 AS score
              FROM runbooks
              WHERE org_id = ${orgId}
                AND to_tsvector('english', content || ' ' || title)
                    @@ plainto_tsquery('english', ${[failureType, pipelineName].filter(Boolean).join(' ')})
              ORDER BY last_updated DESC
              LIMIT 3
            `
          : [];

      const confluenceResults = await searchConfluence(failureType, failureType);

      const allResults = [
        ...rows.map(r => ({ ...r, source: 'internal_runbook' })),
        ...fallbackRows.map(r => ({ ...r, source: 'internal_runbook' })),
        ...confluenceResults,
      ];

      return {
        found: allResults.length > 0,
        runbooks: allResults,
        searchTerm: failureType,
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
};
