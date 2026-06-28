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
the log text. ALWAYS call this first before any other tool.`,
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
    // No execute() — model fills this from log analysis alone. It's a structured
    // extraction, not a DB call. Separating classification from retrieval keeps
    // each tool single-purpose and testable.
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
      const orgId = 'default'; // TODO: pull from request context via middleware

      // Today: full-text search against Neon runbooks table.
      // Near-term upgrade: switch to vector similarity (<=> cosine) when
      // embedding column is populated. Tool interface doesn't change at all —
      // only this query changes.
      // Longer-term: fan out to Confluence via searchConfluence() and merge results.
      const searchTerm = [failureType, pipelineName, ...keywords]
        .filter(Boolean)
        .join(' ');

      const rows = await sql`
        SELECT title, content, remediation_steps, last_updated, author,
               ts_rank(to_tsvector('english', content || ' ' || title),
                       plainto_tsquery('english', ${searchTerm})) as rank
        FROM runbooks
        WHERE org_id = ${orgId}
          AND to_tsvector('english', content || ' ' || title)
              @@ plainto_tsquery('english', ${searchTerm})
        ORDER BY rank DESC
        LIMIT 3
      `;

      // Also query Confluence if configured (returns [] today if not set).
      const confluenceResults = await searchConfluence(searchTerm, failureType);

      const allResults = [
        ...rows.map(r => ({ ...r, source: 'internal_runbook' })),
        ...confluenceResults,
      ];

      return {
        found: allResults.length > 0,
        runbooks: allResults,
        searchTerm,
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

      const rows = await sql`
        SELECT pipeline_name, failure_type, occurred_at, resolved_at,
               resolution_summary, root_cause, known_flaky, resolved_by
        FROM incidents
        WHERE org_id = ${orgId}
          AND failure_type = ${failureType}
          AND (${pipelineName ?? null} IS NULL OR pipeline_name = ${pipelineName ?? null})
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
      return {
        totalIncidents: rows.length,
        knownFlaky,
        avgResolutionMinutes,
        recentIncidents: rows.slice(0, 3),
        mostCommonResolution: rows[0]?.resolution_summary ?? null,
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
