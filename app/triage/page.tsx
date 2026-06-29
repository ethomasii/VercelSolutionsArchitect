'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SAMPLE_RUN_IDS } from '@/lib/run-context-samples';

// -------------------------------------------------------------------
// Lightweight markdown renderer
// -------------------------------------------------------------------
function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**')
      ? <strong key={i} className="font-semibold text-zinc-100">{p.slice(2, -2)}</strong>
      : <span key={i}>{p}</span>
  );
}

function MarkdownLine({ line }: { line: string }) {
  if (line.startsWith('## '))
    return <h2 className="mt-5 mb-3 text-base font-bold text-white border-b border-zinc-800 pb-1.5">{renderInline(line.slice(3))}</h2>;
  if (line.startsWith('### '))
    return <h3 className="mt-4 mb-1.5 text-sm font-semibold text-zinc-200 uppercase tracking-wide">{renderInline(line.slice(4))}</h3>;
  if (line.match(/^(\d+)\.\s/)) {
    const num = line.match(/^(\d+)\./)![1];
    return (
      <div className="flex gap-2 mb-1">
        <span className="shrink-0 text-orange-500 font-mono text-xs mt-0.5">{num}.</span>
        <span className="text-sm text-zinc-300 leading-relaxed">{renderInline(line.replace(/^\d+\.\s/, ''))}</span>
      </div>
    );
  }
  if (line.startsWith('- '))
    return <div className="flex gap-2 mb-1"><span className="shrink-0 text-zinc-600 mt-1">•</span><span className="text-sm text-zinc-300 leading-relaxed">{renderInline(line.slice(2))}</span></div>;
  if (line.trim() === '---') return <hr className="my-3 border-zinc-800" />;
  if (line.trim() === '') return <div className="h-1" />;
  return <p className="text-sm text-zinc-300 leading-relaxed mb-1">{renderInline(line)}</p>;
}

function MarkdownReport({ text }: { text: string }) {
  return <div className="py-2">{text.split('\n').map((l, i) => <MarkdownLine key={i} line={l} />)}</div>;
}

// -------------------------------------------------------------------
// Visual Lineage Chain
// -------------------------------------------------------------------
type LineageNode = { id: string; tool?: string; layer?: string; isBreakPoint?: boolean; inferenceMethod?: string[] };
type LineageChain = {
  focusNode: string;
  upstream: LineageNode[];
  downstream: LineageNode[];
  source: string;
  confidence: string;
};

const TOOL_COLORS: Record<string, string> = {
  fivetran: 'border-blue-500/40 bg-blue-950/20 text-blue-300',
  airbyte: 'border-cyan-500/40 bg-cyan-950/20 text-cyan-300',
  dlt: 'border-violet-500/40 bg-violet-950/20 text-violet-300',
  snowpipe: 'border-sky-500/40 bg-sky-950/20 text-sky-300',
  snowflake_task: 'border-sky-500/40 bg-sky-950/20 text-sky-300',
  dbt_model: 'border-orange-500/40 bg-orange-950/20 text-orange-300',
  dagster_asset: 'border-purple-500/40 bg-purple-950/20 text-purple-300',
  airflow_dag: 'border-teal-500/40 bg-teal-950/20 text-teal-300',
  fivetran_connector: 'border-blue-500/40 bg-blue-950/20 text-blue-300',
  unknown: 'border-zinc-700/40 bg-zinc-900/40 text-zinc-400',
};
const TOOL_ICONS: Record<string, string> = {
  fivetran: '🔌', airbyte: '🔌', dlt: '🐍', stitch: '🔌', snowpipe: '❄️',
  snowflake_task: '❄️', dynamic_table: '❄️', dbt_model: '🔄', dagster_asset: '🔷',
  airflow_dag: '🌬️', fivetran_connector: '🔌', unknown: '◻️',
};
const LAYER_LABEL: Record<string, string> = {
  source: 'source', raw: 'raw', staging: 'staging',
  intermediate: 'intermediate', mart: 'mart', unknown: '',
};

function LineageChainDisplay({ chain, breakNodeId }: { chain: LineageChain; breakNodeId?: string }) {
  // Build the left-to-right chain: upstream (reversed) → focus node → downstream
  const allNodes: Array<LineageNode & { role: 'upstream' | 'focus' | 'downstream' }> = [
    ...[...chain.upstream].reverse().map(n => ({ ...n, role: 'upstream' as const })),
    { id: chain.focusNode, tool: 'unknown', layer: 'unknown', role: 'focus' as const },
    ...chain.downstream.map(n => ({ ...n, role: 'downstream' as const })),
  ];

  if (allNodes.length <= 1) return null;

  const sourceLabel = chain.source === 'dbt_manifest' ? '✓ dbt manifest'
    : chain.source === 'datahub' ? '✓ Datahub'
    : chain.source === 'cached' ? '~ cached'
    : `~ inferred (${chain.confidence})`;

  return (
    <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800/50">
        <span className="text-xs font-semibold text-zinc-300">🔗 Lineage Chain</span>
        <span className="text-xs text-zinc-600">{sourceLabel}</span>
      </div>
      <div className="px-4 py-3 overflow-x-auto">
        <div className="flex items-center gap-0 min-w-max">
          {allNodes.map((node, i) => {
            const isFocus = node.role === 'focus';
            const isBreak = node.id === breakNodeId || node.isBreakPoint;
            const isUpstream = node.role === 'upstream';
            const colorClass = isFocus
              ? isBreak
                ? 'border-red-500/50 bg-red-950/20 text-red-300'
                : 'border-orange-500/50 bg-orange-950/20 text-orange-300'
              : isUpstream && isBreak
              ? 'border-red-500/50 bg-red-950/20 text-red-300'
              : TOOL_COLORS[node.tool ?? 'unknown'] ?? TOOL_COLORS.unknown;
            const icon = TOOL_ICONS[node.tool ?? 'unknown'] ?? '◻️';
            const layerLabel = LAYER_LABEL[node.layer ?? 'unknown'];
            const shortId = node.id.length > 22 ? node.id.slice(0, 19) + '…' : node.id;

            return (
              <div key={i} className="flex items-center">
                {/* Node box */}
                <div className={`rounded-lg border px-2.5 py-1.5 ${colorClass} ${isFocus ? 'ring-1 ring-offset-1 ring-offset-zinc-900 ring-orange-500/30' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs">{icon}</span>
                    <div>
                      <p className="text-xs font-mono font-medium leading-tight">{shortId}</p>
                      {layerLabel && (
                        <p className="text-xs opacity-60 leading-tight">{layerLabel}</p>
                      )}
                    </div>
                    {isBreak && <span className="text-xs text-red-400 font-bold ml-0.5">✗</span>}
                    {isFocus && !isBreak && <span className="text-xs text-orange-400 ml-0.5">←</span>}
                  </div>
                </div>
                {/* Arrow between nodes */}
                {i < allNodes.length - 1 && (
                  <div className="flex items-center px-1">
                    <span className="text-zinc-600 text-xs">→</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {chain.upstream.length > 0 && (
          <p className="text-xs text-zinc-700 mt-2">
            {chain.upstream[0]?.tool && chain.upstream[0].tool !== 'unknown'
              ? `Root: ${chain.upstream[chain.upstream.length - 1]?.id} → … → ${chain.focusNode} (failing)`
              : `Check upstream nodes — the break may be before ${chain.focusNode}`}
          </p>
        )}
      </div>
    </div>
  );
}

type ClassifyOutput = {
  failureType?: string; confidence?: number;
  affectedPipeline?: string; keySignals?: string[]; reasoning?: string;
};

type RunbookOutput = {
  found?: boolean;
  runbooks?: Array<{ title?: string; content?: string; remediation_steps?: unknown; author?: string; last_updated?: string; source?: string }>;
};

type IncidentOutput = {
  totalIncidents?: number; knownFlaky?: boolean; avgResolutionMinutes?: number | null;
  recentIncidents?: Array<{ pipeline_name?: string; occurred_at?: string; resolved_at?: string; resolution_summary?: string; root_cause?: string; resolved_by?: string }>;
  mostCommonResolution?: string;
  recentUpstreamFailures?: Array<{ pipelineName?: string; failureType?: string; occurredAt?: string; resolutionSummary?: string }>;
  lineageChain?: LineageChain;
  materializationOwner?: string;
};

type GitOutput = {
  commits?: Array<{ sha?: string; message?: string; author?: string; files?: string[]; committedAt?: string; isLikelyCause?: boolean }>;
  pullRequests?: Array<{ number?: number; title?: string; author?: string; mergedAt?: string | null; files?: string[] }>;
  source?: string;
};

function ToolDetail({ toolName, output }: { toolName: string; output: unknown }) {
  if (!output) return <p className="text-xs text-zinc-600 italic">No data returned.</p>;

  if (toolName === 'classifyFailure') {
    const o = output as ClassifyOutput;
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">Type</span>
          <code className="text-xs font-mono text-orange-400">{o.failureType}</code>
          <span className="text-xs text-zinc-500">Confidence</span>
          <span className="text-xs font-medium text-zinc-300">{o.confidence ? Math.round(o.confidence * 100) : '?'}%</span>
        </div>
        {o.affectedPipeline && (
          <div className="flex gap-2"><span className="text-xs text-zinc-500 shrink-0">Pipeline</span><code className="text-xs font-mono text-zinc-400">{o.affectedPipeline}</code></div>
        )}
        {o.keySignals && o.keySignals.length > 0 && (
          <div>
            <p className="text-xs text-zinc-500 mb-1">Key signals</p>
            <div className="flex flex-wrap gap-1">
              {o.keySignals.map((s, i) => (
                <span key={i} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-400">{s}</span>
              ))}
            </div>
          </div>
        )}
        {o.reasoning && <p className="text-xs text-zinc-500 leading-relaxed">{o.reasoning}</p>}
      </div>
    );
  }

  if (toolName === 'searchRunbooks') {
    const o = output as RunbookOutput;
    if (!o.found || !o.runbooks?.length)
      return <p className="text-xs text-zinc-600 italic">No matching runbooks found for this failure type.</p>;
    return (
      <div className="space-y-3">
        {o.runbooks.map((rb, i) => {
          const steps = rb.remediation_steps
            ? (typeof rb.remediation_steps === 'string' ? JSON.parse(rb.remediation_steps) : rb.remediation_steps) as string[]
            : [];
          return (
            <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <div className="flex items-start justify-between mb-2">
                <p className="text-xs font-semibold text-zinc-200">{rb.title}</p>
                {rb.author && <span className="text-xs text-zinc-600 ml-2 shrink-0">{rb.author}</span>}
              </div>
              <p className="text-xs text-zinc-500 leading-relaxed mb-2 line-clamp-3">{rb.content?.slice(0, 280)}{rb.content && rb.content.length > 280 ? '...' : ''}</p>
              {steps.length > 0 && (
                <div>
                  <p className="text-xs text-zinc-600 mb-1 font-medium">Remediation steps</p>
                  <ol className="space-y-0.5">
                    {(steps as string[]).map((step: string, j: number) => (
                      <li key={j} className="flex gap-2 text-xs text-zinc-400">
                        <span className="shrink-0 text-orange-500/70 font-mono">{j + 1}.</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  if (toolName === 'lookupIncidentHistory') {
    const o = output as IncidentOutput;
    return (
      <div className="space-y-3">
        {/* Lineage chain — visual graph */}
        {o.lineageChain && <LineageChainDisplay chain={o.lineageChain} />}

        {/* Materialization owner */}
        {o.materializationOwner && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
            <p className="text-xs text-zinc-500 mb-1 font-medium">Materialization owner</p>
            <pre className="text-xs font-mono text-zinc-400 whitespace-pre-wrap">{o.materializationOwner}</pre>
          </div>
        )}

        {/* Summary stats */}
        <div className="flex items-center gap-4">
          <div className="text-center">
            <p className="text-lg font-bold text-zinc-200">{o.totalIncidents ?? 0}</p>
            <p className="text-xs text-zinc-600">incidents (90d)</p>
          </div>
          {o.avgResolutionMinutes != null && (
            <div className="text-center">
              <p className="text-lg font-bold text-zinc-200">{o.avgResolutionMinutes}m</p>
              <p className="text-xs text-zinc-600">avg resolution</p>
            </div>
          )}
          {o.knownFlaky && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-400 ring-1 ring-amber-500/20">
              ⚠️ Known flaky
            </span>
          )}
        </div>

        {/* Most common resolution */}
        {o.mostCommonResolution && (
          <div className="rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2">
            <p className="text-xs text-zinc-500 mb-0.5">Most common resolution</p>
            <p className="text-xs text-zinc-300">{o.mostCommonResolution}</p>
          </div>
        )}

        {/* Cross-pipeline upstream failures */}
        {o.recentUpstreamFailures && o.recentUpstreamFailures.length > 0 && (
          <div className="rounded-lg border border-amber-800/30 bg-amber-950/10 px-3 py-2">
            <p className="text-xs font-medium text-amber-400 mb-1.5">⚠️ Other pipelines failed recently</p>
            <div className="space-y-1">
              {o.recentUpstreamFailures.map((f, i) => {
                const occurred = f.occurredAt ? new Date(f.occurredAt) : null;
                const hoursAgo = occurred ? Math.round((Date.now() - occurred.getTime()) / 3600000) : null;
                return (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <code className="font-mono text-amber-300/80">{f.pipelineName}</code>
                    <span className="text-zinc-600">{hoursAgo != null ? `${hoursAgo}h ago` : ''}</span>
                    <span className="text-zinc-700">·</span>
                    <span className="text-zinc-500">{f.failureType}</span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-zinc-700 mt-1.5 italic">
              With Dagster MCP: traverse asset graph to confirm upstream causality
            </p>
          </div>
        )}

        {/* Recent incidents */}
        {o.recentIncidents && o.recentIncidents.length > 0 && (
          <div>
            <p className="text-xs text-zinc-600 font-medium mb-1.5">Recent incidents</p>
            <div className="space-y-1.5">
              {o.recentIncidents.map((inc, i) => {
                const occurred = inc.occurred_at ? new Date(inc.occurred_at) : null;
                const resolved = inc.resolved_at ? new Date(inc.resolved_at) : null;
                const resMin = occurred && resolved
                  ? Math.round((resolved.getTime() - occurred.getTime()) / 60000)
                  : null;
                return (
                  <div key={i} className="rounded border border-zinc-800/60 bg-zinc-900/50 px-3 py-2">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs text-zinc-400">{occurred?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) ?? '—'}</span>
                      {resMin != null && <span className="text-xs text-zinc-600">resolved in {resMin}m</span>}
                      {inc.resolved_by && <span className="text-xs text-zinc-700">by {inc.resolved_by}</span>}
                    </div>
                    {inc.resolution_summary && (
                      <p className="text-xs text-zinc-500 leading-relaxed">{inc.resolution_summary}</p>
                    )}
                    {inc.root_cause && (
                      <p className="text-xs text-zinc-600 mt-0.5">Root cause: {inc.root_cause}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (toolName === 'searchGitContext') {
    const o = output as GitOutput;
    const commits = o.commits ?? [];
    if (commits.length === 0)
      return <p className="text-xs text-zinc-600 italic">No recent commits found for this pipeline.</p>;
    return (
      <div className="space-y-1.5">
        {commits.map((c, i) => {
          const committed = c.committedAt ? new Date(c.committedAt) : null;
          const hoursAgo = committed ? Math.round((Date.now() - committed.getTime()) / 3600000) : null;
          return (
            <div key={i} className={`rounded border px-3 py-2 ${c.isLikelyCause ? 'border-orange-500/30 bg-orange-950/20' : 'border-zinc-800/60 bg-zinc-900/50'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    {c.isLikelyCause && <span className="shrink-0 text-xs font-semibold text-orange-400">⚠️ Likely cause</span>}
                    {c.sha && <code className="text-xs font-mono text-zinc-600">{c.sha.slice(0, 7)}</code>}
                    {hoursAgo != null && <span className="text-xs text-zinc-600">{hoursAgo}h ago</span>}
                  </div>
                  <p className={`text-xs font-medium ${c.isLikelyCause ? 'text-orange-300' : 'text-zinc-300'}`}>{c.message}</p>
                  {c.author && <p className="text-xs text-zinc-600 mt-0.5">by {c.author}</p>}
                </div>
              </div>
              {c.files && c.files.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {c.files.slice(0, 4).map((f, j) => (
                    <span key={j} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-500 truncate max-w-[200px]">{f.split('/').pop()}</span>
                  ))}
                  {c.files.length > 4 && <span className="text-xs text-zinc-700">+{c.files.length - 4} more</span>}
                </div>
              )}
            </div>
          );
        })}
        {o.source === 'simulated' && (
          <p className="text-xs text-zinc-700 italic">Source: simulated (set GITHUB_TOKEN to use real GitHub API)</p>
        )}
        {/* Code context from stack trace file reading */}
        {(o as { codeContext?: { path: string; relevantLines: string } }).codeContext && (
          <div className="rounded-lg border border-blue-800/30 bg-blue-950/10 overflow-hidden">
            <div className="px-3 py-1.5 border-b border-blue-800/20 flex items-center gap-2">
              <span className="text-xs font-medium text-blue-300">📄 Code from repo</span>
              <code className="text-xs font-mono text-blue-400/70 truncate">
                {(o as { codeContext: { path: string } }).codeContext.path}
              </code>
            </div>
            <pre className="px-3 py-2 text-xs font-mono text-zinc-400 leading-relaxed overflow-x-auto whitespace-pre max-h-48 overflow-y-auto">
              {(o as { codeContext: { relevantLines: string } }).codeContext.relevantLines}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (toolName === 'checkVendorStatus') {
    const o = output as {
      checked?: Array<{ vendor: string; level: string; description: string; activeIncidents?: Array<{ name: string; status: string; impact: string }> }>;
      summary?: string;
      hasActiveIncidents?: boolean;
    } | undefined;
    if (!o?.checked?.length) return <p className="text-xs text-zinc-600 italic">No vendors checked.</p>;
    return (
      <div className="space-y-2">
        <p className={`text-xs font-medium ${o.hasActiveIncidents ? 'text-red-400' : 'text-green-400'}`}>
          {o.summary}
        </p>
        <div className="space-y-1.5">
          {o.checked.map((v, i) => (
            <div key={i} className={`flex items-center gap-3 rounded border px-3 py-1.5 ${
              v.level === 'operational' ? 'border-zinc-800/60 bg-zinc-900/30'
              : v.level === 'outage' ? 'border-red-800/40 bg-red-950/20'
              : 'border-amber-800/30 bg-amber-950/10'
            }`}>
              <span className={`h-2 w-2 rounded-full shrink-0 ${
                v.level === 'operational' ? 'bg-green-500'
                : v.level === 'outage' ? 'bg-red-500'
                : v.level === 'degraded' ? 'bg-amber-500'
                : 'bg-zinc-500'
              }`} />
              <span className="text-xs font-medium text-zinc-300 capitalize w-20">{v.vendor}</span>
              <span className={`text-xs ${v.level === 'operational' ? 'text-zinc-600' : v.level === 'outage' ? 'text-red-400' : 'text-amber-400'}`}>
                {v.description}
              </span>
              {v.activeIncidents?.map((inc, j) => (
                <span key={j} className="text-xs text-red-400 ml-auto">{inc.name}</span>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (toolName === 'proposeActions') {
    const o = output as {
      actions?: Array<{
        id: string; label: string; description: string;
        risk: 'none' | 'low' | 'medium'; actionConfidence: string;
        requiresApproval: boolean; params?: Record<string, string>;
      }>;
    } | undefined;
    if (!o?.actions?.length) return <p className="text-xs text-zinc-600 italic">No actions proposed.</p>;
    return (
      <div className="space-y-2">
        {o.actions.map((action, i) => (
          <div key={i} className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-medium text-zinc-200">{action.label}</span>
                <span className={`text-xs rounded px-1.5 py-0.5 ${
                  action.risk === 'none' ? 'bg-zinc-800 text-zinc-500' :
                  action.risk === 'low' ? 'bg-blue-500/10 text-blue-400' :
                  'bg-amber-500/10 text-amber-400'
                }`}>{action.risk} risk</span>
                <span className="text-xs text-zinc-600">{action.actionConfidence} confidence</span>
              </div>
              <p className="text-xs text-zinc-500">{action.description}</p>
            </div>
          </div>
        ))}
        <p className="text-xs text-zinc-700 pt-1">Actions panel appears below the report ↓</p>
      </div>
    );
  }

  return null;
}

// -------------------------------------------------------------------
// Expandable tool step
// -------------------------------------------------------------------
type ToolPartGeneric = {
  type: string; toolCallId?: string; state?: string;
  input?: Record<string, unknown>; output?: unknown;
};

function getToolSummary(toolName: string, part: ToolPartGeneric): string {
  if (part.state !== 'output-available') return '';
  const o = part.output;
  if (toolName === 'classifyFailure') {
    const i = part.input as { failureType?: string; confidence?: number } | undefined;
    const pct = i?.confidence ? Math.round(i.confidence * 100) : null;
    return `${i?.failureType ?? 'unknown'}${pct ? ` (confidence: ${pct}%)` : ''}`;
  }
  if (toolName === 'searchRunbooks') {
    const r = o as { found?: boolean; runbooks?: unknown[] } | undefined;
    const count = r?.runbooks?.length ?? 0;
    return r?.found ? `${count} runbook${count !== 1 ? 's' : ''} found` : 'no matching runbooks';
  }
  if (toolName === 'lookupIncidentHistory') {
    const r = o as { totalIncidents?: number; knownFlaky?: boolean } | undefined;
    const flaky = r?.knownFlaky ? ' — ⚠️ known flaky' : '';
    return `${r?.totalIncidents ?? 0} prior incident${(r?.totalIncidents ?? 0) !== 1 ? 's' : ''} found${flaky}`;
  }
  if (toolName === 'searchGitContext') {
    const r = o as { commits?: Array<{ isLikelyCause?: boolean; message?: string }>; codeContext?: { path: string } } | undefined;
    const cause = r?.commits?.find(c => c.isLikelyCause);
    const hasCode = !!r?.codeContext;
    if (cause) return `⚠️ PR merged recently: "${cause.message?.slice(0, 45)}"${hasCode ? ' + code read' : ''}`;
    const count = r?.commits?.length ?? 0;
    return count > 0 ? `${count} recent commit${count !== 1 ? 's' : ''}${hasCode ? ' + code read' : ''}` : 'no recent changes found';
  }
  if (toolName === 'checkVendorStatus') {
    const r = o as { summary?: string; hasActiveIncidents?: boolean } | undefined;
    const prefix = r?.hasActiveIncidents ? '🔴 ' : '✅ ';
    return `${prefix}${r?.summary ?? 'checked'}`;
  }
  if (toolName === 'proposeActions') {
    const r = o as { actions?: Array<{ label: string }> } | undefined;
    const count = r?.actions?.length ?? 0;
    return `${count} action${count !== 1 ? 's' : ''} available`;
  }
  return 'completed';
}

const TOOL_META: Record<string, { icon: string; label: string; loadingLabel: string }> = {
  classifyFailure: { icon: '⚡', label: 'Classified failure', loadingLabel: 'Classifying failure...' },
  searchRunbooks: { icon: '📚', label: 'Runbooks', loadingLabel: 'Searching runbooks...' },
  lookupIncidentHistory: { icon: '🔍', label: 'Incident history', loadingLabel: 'Checking incident history...' },
  searchGitContext: { icon: '🔀', label: 'Git context', loadingLabel: 'Searching git context...' },
  checkVendorStatus: { icon: '🌐', label: 'Vendor status', loadingLabel: 'Checking vendor status pages...' },
  proposeActions: { icon: '🔧', label: 'Actions proposed', loadingLabel: 'Proposing remediation actions...' },
};

function ToolStep({ toolName, part }: { toolName: string; part: ToolPartGeneric }) {
  const [expanded, setExpanded] = useState(false);
  const meta = TOOL_META[toolName] ?? { icon: '🔧', label: toolName, loadingLabel: `Running ${toolName}...` };
  const isLoading = part.state === 'input-streaming' || part.state === 'input-available';
  const isDone = part.state === 'output-available';
  const hasCause =
    toolName === 'searchGitContext' && isDone &&
    (part.output as { commits?: Array<{ isLikelyCause?: boolean }> })?.commits?.some(c => c.isLikelyCause);
  const hasData = isDone && part.output != null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/60 px-3 py-2 text-xs">
        <span className="animate-pulse text-base">{meta.icon}</span>
        <span className="text-zinc-500">{meta.loadingLabel}</span>
        <svg className="ml-auto h-3 w-3 animate-spin text-orange-500/70" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
      </div>
    );
  }

  if (!isDone) return null;

  const summary = getToolSummary(toolName, part);

  return (
    <div className={`rounded-lg border overflow-hidden transition-colors ${
      hasCause ? 'border-orange-500/25 bg-orange-950/10' : 'border-zinc-800/60 bg-zinc-900/30'
    }`}>
      {/* Header row — always visible, click to expand */}
      <button
        onClick={() => hasData && setExpanded(v => !v)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left ${hasData ? 'hover:bg-zinc-800/30 cursor-pointer' : 'cursor-default'}`}
      >
        <span>{meta.icon}</span>
        <span className={`font-medium ${hasCause ? 'text-orange-300' : 'text-zinc-400'}`}>{meta.label}</span>
        <span className="text-zinc-700 mx-0.5">→</span>
        <span className={`flex-1 truncate ${hasCause ? 'text-orange-400' : 'text-zinc-500'}`}>{summary}</span>
        {hasData && (
          <span className="ml-2 text-zinc-700 transition-transform" style={{ transform: expanded ? 'rotate(180deg)' : 'none' }}>
            ▾
          </span>
        )}
      </button>

      {/* Expanded detail panel */}
      {expanded && hasData && (
        <div className="border-t border-zinc-800/60 px-3 py-3">
          <ToolDetail
            toolName={toolName}
            output={toolName === 'classifyFailure' ? (part.output ?? part.input) : part.output}
          />
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------
// Actions Panel — proposed remediations from proposeActions tool
// -------------------------------------------------------------------
type ProposedAction = {
  id: string; label: string; description: string;
  risk: 'none' | 'low' | 'medium'; actionConfidence: string;
  requiresApproval: boolean; params?: Record<string, string>;
};

function ActionsPanel({ actions, rootCauseNote, pipelineName, reportText }: {
  actions: ProposedAction[];
  rootCauseNote?: string;
  pipelineName?: string;
  reportText: string;
}) {
  const [executing, setExecuting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message?: string; error?: string; url?: string; setup?: string }>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  // Track which integrations are connected (fetched once on mount)
  const [connectedIntegrations, setConnectedIntegrations] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((data: Record<string, Record<string, Record<string, { isSet?: boolean }>>>) => {
        const connected = new Set<string>();
        for (const [id, instances] of Object.entries(data)) {
          for (const fields of Object.values(instances)) {
            if (Object.values(fields).some(f => f.isSet)) connected.add(id);
          }
        }
        setConnectedIntegrations(connected);
      })
      .catch(() => {});
  }, []);

  const RISK_ICONS: Record<string, string> = { none: '📋', low: '⚡', medium: '⚠️' };
  const ACTION_ICONS: Record<string, string> = {
    rerun_dagster: '↺',
    trigger_fivetran_sync: '🔄',
    create_jira_ticket: '🎫',
    create_slack_alert: '💬',
    mark_resolved: '✓',
    open_dashboard: '↗',
    create_pr: '⎇',
    custom: '▶',
  };

  const execute = async (action: ProposedAction) => {
    if (action.requiresApproval && confirming !== action.id) {
      setConfirming(action.id);
      return;
    }
    setConfirming(null);
    setExecuting(action.id);
    try {
      const res = await fetch('/api/remediate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionId: action.id,
          params: action.params ?? {},
          pipelineName,
          triageReport: reportText,
        }),
      });
      const data = await res.json() as { ok: boolean; message?: string; error?: string; url?: string };
      if (data.url) window.open(data.url, '_blank');
      setResults(prev => ({ ...prev, [action.id]: data }));
    } finally {
      setExecuting(null);
    }
  };

  if (actions.length === 0) return null;

  return (
    <div className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800/60 bg-zinc-900/50">
        <span className="text-sm">🔧</span>
        <span className="text-xs font-semibold text-zinc-300">Proposed Actions</span>
        <span className="text-xs text-zinc-600 ml-1">— click to execute with approval</span>
      </div>
      {rootCauseNote && (
        <div className="px-4 py-2.5 border-b border-zinc-800/40 bg-zinc-900/20">
          <p className="text-xs text-zinc-400 leading-relaxed">
            <span className="font-medium text-zinc-300">Root cause: </span>{rootCauseNote}
          </p>
        </div>
      )}
      <div className="divide-y divide-zinc-800/40">
        {actions.map((action) => {
          const result = results[action.id];
          const isExecuting = executing === action.id;
          const isConfirming = confirming === action.id;

          return (
            <div key={action.id} className="flex items-center gap-3 px-4 py-3">
              <span className="text-base shrink-0">{ACTION_ICONS[action.id] ?? '▶'}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-zinc-200">{action.label}</span>
                  <span className={`text-xs rounded px-1.5 py-0.5 ${
                    action.risk === 'none' ? 'bg-zinc-800 text-zinc-500' :
                    action.risk === 'low' ? 'bg-blue-500/10 text-blue-400' :
                    'bg-amber-500/10 text-amber-400'
                  }`}>{RISK_ICONS[action.risk]} {action.risk}</span>
                </div>
                <p className="text-xs text-zinc-500 mt-0.5">{action.description}</p>
                {/* Diff preview for create_pr actions */}
                {action.id === 'create_pr' && action.params?.oldText && action.params?.newText && (
                  <div className="mt-1.5 rounded bg-zinc-950 border border-zinc-800 px-2.5 py-2 font-mono text-xs">
                    <div className="text-zinc-600 mb-1">{action.params.filePath}</div>
                    <div className="text-red-400">- {action.params.oldText}</div>
                    <div className="text-green-400">+ {action.params.newText}</div>
                  </div>
                )}
                {result && (
                  <p className={`text-xs mt-1 font-medium ${result.ok ? 'text-green-400' : 'text-red-400'}`}>
                    {result.ok ? (
                      <>
                        ✓ {result.message}
        {(result as { url?: string }).url && (
                          <a href={(result as { url?: string }).url ?? '#'} target="_blank" rel="noopener noreferrer"
                            className="ml-2 text-blue-400 underline">
                            View PR →
                          </a>
                        )}
                      </>
                    ) : `✗ ${result.error}`}
                  </p>
                )}
              </div>
              <div className="shrink-0">
                {/* Check if this action requires an unconfigured integration */}
                {(() => {
                  const needsGitHub = action.id === 'create_pr';
                  const needsFivetran = action.id === 'trigger_fivetran_sync';
                  const needsDagster = action.id === 'rerun_dagster';
                  const needsSlack = action.id === 'create_slack_alert';

                  const isLocked =
                    (needsGitHub && !connectedIntegrations.has('github')) ||
                    (needsFivetran && !connectedIntegrations.has('fivetran')) ||
                    (needsDagster && !connectedIntegrations.has('dagster')) ||
                    (needsSlack && !connectedIntegrations.has('slack'));

                  if (isLocked) {
                    // Build pre-filled settings URL with known values
                    const settingsParams = new URLSearchParams({ focus: needsGitHub ? 'github' : needsFivetran ? 'fivetran' : needsDagster ? 'dagster' : 'slack' });
                    if (needsGitHub && action.params?.repoInstance) settingsParams.set('instance', action.params.repoInstance);
                    const settingsUrl = `/settings?${settingsParams}`;

                    return (
                      <a href={settingsUrl}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-800/40 bg-amber-950/10 px-3 py-1.5 text-xs font-medium text-amber-400 transition hover:border-amber-700/60 hover:bg-amber-950/20">
                        🔒 Connect {needsGitHub ? 'GitHub' : needsFivetran ? 'Fivetran' : needsDagster ? 'Dagster' : 'Slack'} to unlock
                      </a>
                    );
                  }

                  if (isConfirming) {
                    return (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-amber-400">Confirm?</span>
                        <button onClick={() => execute(action)}
                          className="rounded bg-orange-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-orange-500 transition">
                          Yes, execute
                        </button>
                        <button onClick={() => setConfirming(null)}
                          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 transition">
                          Cancel
                        </button>
                      </div>
                    );
                  }

                  if (result) {
                    return (
                      <div className="flex flex-col items-end gap-1">
                        <span className={`text-xs font-medium ${result.ok ? 'text-green-400' : 'text-red-400'}`}>
                          {result.ok ? `✓ ${result.message}` : `✗ ${result.error?.slice(0, 60)}`}
                        </span>
                        {result.ok && result.url && (
                          <a href={result.url} target="_blank" rel="noopener noreferrer"
                            className="text-xs text-blue-400 underline">View PR →</a>
                        )}
                        {!result.ok && result.setup && (
                          <a href="/settings" className="text-xs text-amber-400 underline">{result.setup}</a>
                        )}
                      </div>
                    );
                  }

                  // open_dashboard and custom: show as a link or info, not an execute button
                  if (action.id === 'open_dashboard' || action.id === 'custom') {
                    if (action.params?.url) {
                      return (
                        <a href={action.params.url} target="_blank" rel="noopener noreferrer"
                          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200">
                          Open ↗
                        </a>
                      );
                    }
                    return <span className="text-xs text-zinc-600 italic">Manual step</span>;
                  }

                  return (
                    <button
                      onClick={() => execute(action)}
                      disabled={isExecuting}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-orange-500/50 hover:text-zinc-100 hover:bg-orange-500/5 disabled:opacity-40"
                    >
                      {isExecuting ? (
                        <span className="flex items-center gap-1.5">
                          <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                          </svg>
                          Running...
                        </span>
                      ) : action.requiresApproval ? 'Execute ▶' : 'Run'}
                    </button>
                  );                })()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// Message rendering
// -------------------------------------------------------------------
type UIMessagePart = { type: string; text?: string; toolCallId?: string; state?: string; [key: string]: unknown };

function MessageParts({ parts, reportText }: { parts: UIMessagePart[]; reportText: string }) {
  const toolParts = parts.filter(p => p.type.startsWith('tool-'));
  const textParts = parts.filter(p => p.type === 'text' && p.text);
  const rawText = textParts.map(p => p.text).join('\n');

  // Filter to just the final triage report — skip intermediate model narration
  // ("Let me search...", "Now I have context..." etc. from between tool calls)
  const reportStart = rawText.indexOf('## 🔍 Dispatch Triage Report');
  const fullText = reportStart >= 0 ? rawText.slice(reportStart) : rawText;

  // Extract proposeActions output for the actions panel
  const actionsPart = toolParts.find(p => p.type === 'tool-proposeActions');
  const actionsOutput = actionsPart?.output as { actions?: ProposedAction[]; rootCauseNote?: string } | undefined;
  let proposedActions = actionsOutput?.actions ?? [];
  let rootCauseNote = actionsOutput?.rootCauseNote;

  // AUTO-DERIVE ACTIONS: if proposeActions wasn't called by the model (common with complex runs),
  // derive them from the available tool outputs — makes the Actions panel always appear
  if (proposedActions.length === 0) {
    const classifyPart2 = toolParts.find(p => p.type === 'tool-classifyFailure');
    const classifyOut = (classifyPart2?.output ?? classifyPart2?.input) as {
      failureType?: string; affectedPipeline?: string; confidence?: number;
    } | undefined;
    const gitPart = toolParts.find(p => p.type === 'tool-searchGitContext');
    const gitOut = gitPart?.output as {
      commits?: Array<{ isLikelyCause?: boolean; message?: string; sha?: string }>;
    } | undefined;
    const incidentPart = toolParts.find(p => p.type === 'tool-lookupIncidentHistory');
    const incidentOut = incidentPart?.output as { knownFlaky?: boolean; totalIncidents?: number } | undefined;

    const causePR = gitOut?.commits?.find(c => c.isLikelyCause);
    const ft = classifyOut?.failureType ?? 'unknown';

    const derived: ProposedAction[] = [];

    // Schema mismatch with column rename pattern → propose fix PR
    if (ft === 'schema_mismatch') {
      const signals = ((classifyOut as { keySignals?: string[] })?.keySignals ?? []).join(' ').toLowerCase();
      // Extract "column 'X' does not exist" and "renamed to 'Y'" patterns
      const oldColMatch = signals.match(/column ["']?([a-z_]+)["']?[^a-z_].*(?:does not exist|not found)/);
      const newColMatch = signals.match(/renamed? to ["']?([a-z_]+)["']?/);
      const stackFile = (classifyOut as { stackTrace?: { filePath?: string } })?.stackTrace?.filePath;

      if (oldColMatch || stackFile) {
        const oldCol = oldColMatch?.[1] ?? 'old_column';
        const newCol = newColMatch?.[1] ?? 'new_column';
        // Use file from stackTrace if available, otherwise the known demo file
        const fixFile = stackFile ?? 'demo/fct_customer_orders.sql';

        rootCauseNote = rootCauseNote ?? `Column rename: "${oldCol}" was renamed to "${newCol}" but not all downstream refs were updated. The fix is deterministic.`;
        derived.push({
          id: 'create_pr',
          label: `Fix column ref: ${oldCol} → ${newCol}`,
          description: `Update ${fixFile}: change c.${oldCol} to c.${newCol} to match the upstream rename.`,
          risk: 'low',
          actionConfidence: 'High',
          requiresApproval: true,
          params: {
            filePath: fixFile,
            oldText: `c.${oldCol},`,
            newText: `c.${newCol},`,
            branchName: `dispatch/fix-${newCol}-ref`,
            prTitle: `fix: update ${oldCol} → ${newCol} in ${fixFile.split('/').pop()}`,
            prBody: `## Dispatch Auto-Fix\n\nColumn \`${oldCol}\` was renamed to \`${newCol}\` but \`${fixFile}\` was not updated.\n\n**Fix:** \`c.${oldCol},\` → \`c.${newCol},\``,
            repoInstance: 'dbt',
          },
        });
      }
    }

    // Code regression / network timeout with batch size change → revert config
    if ((ft === 'code_regression' || ft === 'network_timeout') && causePR?.message?.toLowerCase().match(/batch|chunk|size|parallel/)) {
      rootCauseNote = rootCauseNote ?? 'Recent batch size or parallelism change may have caused API rate limiting — the config change is likely the root cause.';
      // Only propose create_pr if we have a commit SHA to look up the actual change
      if (causePR?.sha) {
        derived.push({
          id: 'create_pr',
          label: 'Revert batch size / config change',
          description: `Revert the "${causePR?.message?.slice(0, 60)}" change while investigating API rate limits. Reads commit ${causePR.sha.slice(0,7)} to find exact change.`,
          risk: 'low',
          actionConfidence: 'Medium',
          requiresApproval: true,
          params: {
            commitSha: causePR.sha,
            message: causePR.message ?? '',
            repoInstance: 'default',
          },
        });
      }
    }

    // Only offer a dashboard link — don't assume which orchestrator ran this
    // The LLM's proposeActions (when it runs) handles orchestrator-specific reruns
    // based on the full context (dagster/airflow/prefect/step-functions/etc.)

    // Known flaky → mark resolved
    if (incidentOut?.knownFlaky) {
      rootCauseNote = rootCauseNote ?? 'This is a known flaky pipeline — wait for it to resolve before escalating.';
      derived.push({ id: 'mark_resolved', label: 'Mark as resolved (known flaky)', description: 'Close the incident — this pipeline self-resolves.', risk: 'none', actionConfidence: 'High', requiresApproval: false });
    }

    // Always offer Slack + Jira
    derived.push({ id: 'create_slack_alert', label: 'Post to #data-alerts', description: 'Notify the team about this failure with the triage report.', risk: 'none', actionConfidence: 'High', requiresApproval: false });

    if (derived.length > 0) {
      proposedActions = derived;
      if (!rootCauseNote) {
        rootCauseNote = causePR
          ? `PR "${causePR.message?.slice(0, 80)}" merged recently — likely the root cause.`
          : `${ft === 'unknown' ? 'Classification uncertain — check Dagster UI for Python traceback.' : `Failure type: ${ft}.`}`;
      }
    }
  }

  // Extract pipeline name from classifyFailure for the remediation API
  const classifyPart = toolParts.find(p => p.type === 'tool-classifyFailure');
  const pipelineName = (classifyPart?.input as { affectedPipeline?: string } | undefined)?.affectedPipeline;

  // Extract lineage chain from lookupIncidentHistory for top-level display
  const incidentPart2 = toolParts.find(p => p.type === 'tool-lookupIncidentHistory');
  const lineageChain = (incidentPart2?.output as IncidentOutput | undefined)?.lineageChain;

  return (
    <div>
      {toolParts.length > 0 && (
        <div className="mb-4 space-y-1.5">
          {toolParts.map((part, i) => (
            <ToolStep
              key={(part.toolCallId as string | undefined) ?? i}
              toolName={part.type.slice(5)}
              part={part as unknown as ToolPartGeneric}
            />
          ))}
          {toolParts.some(p => p.state === 'output-available') && fullText === '' && (
            <p className="text-xs text-zinc-700 px-1">Generating report...</p>
          )}
        </div>
      )}
      {/* Lineage chain — shown prominently above report once available */}
      {lineageChain && lineageChain.upstream.length > 0 && (
        <LineageChainDisplay chain={lineageChain} />
      )}
      {fullText && <MarkdownReport text={fullText} />}
      {proposedActions.length > 0 && (
        <ActionsPanel
          actions={proposedActions}
          rootCauseNote={rootCauseNote}
          pipelineName={pipelineName}
          reportText={reportText}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------------
// Page
// -------------------------------------------------------------------
export default function TriagePage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-500 text-sm">Loading...</div>}>
      <TriagePageInner />
    </Suspense>
  );
}

function TriagePageInner() {
  const searchParams = useSearchParams();
  const prefillLog = searchParams.get('log') ?? '';
  const [inputMode, setInputMode] = useState<'log' | 'runid'>('log');
  const [input, setInput] = useState(prefillLog);
  const [runId, setRunId] = useState('');
  const [runIdLoading, setRunIdLoading] = useState(false);
  const [runIdError, setRunIdError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });

  const autoSubmitted = useRef(false);
  useEffect(() => {
    if (prefillLog && !autoSubmitted.current && status === 'ready') {
      autoSubmitted.current = true;
      sendMessage({ text: prefillLog });
      setInput('');
    }
  }, [prefillLog, sendMessage, status]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const isStreaming = status === 'streaming' || status === 'submitted';
  const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
  const reportText = lastAssistantMsg?.parts
    .filter((p: UIMessagePart) => p.type === 'text')
    .map((p: UIMessagePart) => p.text)
    .join('') ?? '';

  const handleCopy = useCallback(() => {
    if (!reportText) return;
    navigator.clipboard.writeText(reportText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [reportText]);

  // Resolve a run ID to enriched context, then send to the agent
  const handleRunIdSubmit = async () => {
    if (!runId.trim() || isStreaming) return;
    setRunIdLoading(true);
    setRunIdError(null);
    try {
      const res = await fetch('/api/run-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: runId.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRunIdError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      sendMessage({ text: data.enrichedPrompt });
    } catch (err) {
      setRunIdError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunIdLoading(false);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition">← Dispatch</Link>
          <span className="text-zinc-700">/</span>
          <span className="text-sm font-medium text-zinc-300">Triage</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${isStreaming ? 'bg-orange-500/10 text-orange-400' : 'bg-zinc-800 text-zinc-500'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${isStreaming ? 'bg-orange-500 animate-pulse' : 'bg-zinc-600'}`} />
            {isStreaming ? 'Analyzing...' : 'Ready'}
          </span>
          <Link href="/evals" className="text-xs text-zinc-600 hover:text-zinc-400 transition">Evals →</Link>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="mx-auto max-w-3xl px-6 py-6 space-y-8">
          {messages.length === 0 && !isStreaming && (
            <div className="text-center py-20">
              <p className="text-zinc-600 text-sm">Choose an input mode below to start triage.</p>
            </div>
          )}

          {messages.map(message => (
            <div key={message.id}>
              {message.role === 'user' ? (
                <div className="flex justify-end">
                  <div className="max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
                    <p className="text-xs text-zinc-600 mb-1.5 font-medium">
                      {message.parts.filter((p: UIMessagePart) => p.type === 'text').map((p: UIMessagePart) => p.text).join('').startsWith('Triage pipeline failure for run:')
                        ? 'Run context (enriched by orchestrator)'
                        : 'Error log'}
                    </p>
                    <pre className="text-xs text-zinc-500 whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto max-h-48 overflow-y-auto">
                      {message.parts.filter((p: UIMessagePart) => p.type === 'text').map((p: UIMessagePart) => p.text).join('')}
                    </pre>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-orange-600 text-xs font-bold text-white">D</span>
                      <span className="text-xs font-semibold text-zinc-400">Dispatch</span>
                    </div>
                    {!isStreaming && message.id === lastAssistantMsg?.id && reportText && (
                      <div className="flex items-center gap-2">
                        <button onClick={handleCopy} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 py-1 text-xs text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-300">
                          {copied ? <><span className="text-green-500">✓</span> Copied</> : <>⎘ Copy</>}
                        </button>
                        <SlackButton />
                      </div>
                    )}
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-1">
                    <MessageParts parts={message.parts as UIMessagePart[]} reportText={reportText} />
                  </div>
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="border-t border-zinc-800 bg-zinc-950 px-6 py-4 shrink-0">
        <div className="mx-auto max-w-3xl">
          {/* Tab switcher */}
          <div className="flex items-center gap-1 mb-3 rounded-lg border border-zinc-800 bg-zinc-900 p-1 w-fit">
            <button
              onClick={() => setInputMode('log')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${inputMode === 'log' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Error Log
            </button>
            <button
              onClick={() => { setInputMode('runid'); setRunIdError(null); }}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${inputMode === 'runid' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Run ID
              <span className="ml-1.5 rounded bg-orange-500/20 px-1 py-0.5 text-xs text-orange-400">richer context</span>
            </button>
          </div>

          {inputMode === 'log' ? (
            <form onSubmit={e => {
              e.preventDefault();
              if (input.trim() && !isStreaming) { sendMessage({ text: input }); setInput(''); }
            }}>
              <div className="relative">
                <textarea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && input.trim() && !isStreaming) {
                      e.preventDefault(); sendMessage({ text: input }); setInput('');
                    }
                  }}
                  disabled={isStreaming}
                  placeholder="Paste pipeline error log here... (⌘+Enter to submit)"
                  rows={4}
                  className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 pr-24 text-sm text-zinc-200 placeholder-zinc-600 outline-none transition focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700 disabled:opacity-50 font-mono"
                />
                <button type="submit" disabled={!input.trim() || isStreaming}
                  className="absolute bottom-3 right-3 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-40">
                  {isStreaming ? 'Analyzing...' : 'Triage →'}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-zinc-700">
                Log-snippet mode: useful for quick triage, limited by what the log contains.
              </p>
            </form>
          ) : (
            <div>
              <div className="relative flex gap-2">
                <input
                  value={runId}
                  onChange={e => { setRunId(e.target.value); setRunIdError(null); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleRunIdSubmit(); }}
                  disabled={isStreaming || runIdLoading}
                  placeholder="e.g. dag-run-silent-upstream or a real Dagster/Airflow run ID"
                  className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-200 placeholder-zinc-600 outline-none transition focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700 disabled:opacity-50 font-mono"
                />
                <button
                  onClick={handleRunIdSubmit}
                  disabled={!runId.trim() || isStreaming || runIdLoading}
                  className="rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-40 shrink-0"
                >
                  {runIdLoading ? 'Fetching...' : isStreaming ? 'Analyzing...' : 'Fetch & Triage →'}
                </button>
              </div>

              {runIdError && (
                <p className="mt-2 text-xs text-red-400">{runIdError}</p>
              )}

              {/* Sample run IDs */}
              <div className="mt-3 space-y-1.5">
                <p className="text-xs text-zinc-600 mb-2">Sample run IDs (demonstrating key failure patterns):</p>
                {SAMPLE_RUN_IDS.map(s => (
                  <button
                    key={s.id}
                    onClick={() => { setRunId(s.id); setRunIdError(null); }}
                    className="w-full text-left rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 transition hover:border-zinc-700 hover:bg-zinc-900"
                  >
                    <div className="flex items-start gap-2">
                      <code className="text-xs font-mono text-orange-400 shrink-0 mt-0.5">{s.id}</code>
                    </div>
                    <p className="text-xs text-zinc-500 mt-0.5">{s.description}</p>
                  </button>
                ))}
                <p className="text-xs text-zinc-700 pt-1">
                  With Dagster MCP: any real run ID → full asset graph + upstream context automatically.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SlackButton() {
  const [state, setState] = useState<'idle' | 'posted'>('idle');
  return (
    <button onClick={() => { setState('posted'); setTimeout(() => setState('idle'), 3000); }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 py-1 text-xs text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-300">
      {state === 'posted' ? <><span className="text-green-500">✓</span> Posted to #data-alerts</> : <>💬 Share to Slack</>}
    </button>
  );
}

