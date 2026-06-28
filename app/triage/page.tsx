'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SAMPLE_RUN_IDS } from '@/lib/run-context';

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
// Tool step detail renderers
// -------------------------------------------------------------------
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
    const r = o as { commits?: Array<{ isLikelyCause?: boolean; message?: string }> } | undefined;
    const cause = r?.commits?.find(c => c.isLikelyCause);
    if (cause) return `⚠️ PR merged recently: "${cause.message?.slice(0, 45)}"`;
    const count = r?.commits?.length ?? 0;
    return count > 0 ? `${count} recent commit${count !== 1 ? 's' : ''}` : 'no recent changes found';
  }
  if (toolName === 'checkVendorStatus') {
    const r = o as { summary?: string; hasActiveIncidents?: boolean } | undefined;
    const prefix = r?.hasActiveIncidents ? '🔴 ' : '✅ ';
    return `${prefix}${r?.summary ?? 'checked'}`;
  }
  return 'completed';
}

const TOOL_META: Record<string, { icon: string; label: string; loadingLabel: string }> = {
  classifyFailure: { icon: '⚡', label: 'Classified failure', loadingLabel: 'Classifying failure...' },
  searchRunbooks: { icon: '📚', label: 'Runbooks', loadingLabel: 'Searching runbooks...' },
  lookupIncidentHistory: { icon: '🔍', label: 'Incident history', loadingLabel: 'Checking incident history...' },
  searchGitContext: { icon: '🔀', label: 'Git context', loadingLabel: 'Searching git context...' },
  checkVendorStatus: { icon: '🌐', label: 'Vendor status', loadingLabel: 'Checking vendor status pages...' },
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
// Message rendering
// -------------------------------------------------------------------
type UIMessagePart = { type: string; text?: string; toolCallId?: string; state?: string; [key: string]: unknown };

function MessageParts({ parts }: { parts: UIMessagePart[] }) {
  const toolParts = parts.filter(p => p.type.startsWith('tool-'));
  const textParts = parts.filter(p => p.type === 'text' && p.text);
  const fullText = textParts.map(p => p.text).join('');

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
      {fullText && <MarkdownReport text={fullText} />}
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
                    <MessageParts parts={message.parts as UIMessagePart[]} />
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

