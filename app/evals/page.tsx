'use client';

import { useState } from 'react';
import Link from 'next/link';

// Reuse the same markdown renderer and tool detail types as triage page
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
    return <h2 className="mt-4 mb-2 text-sm font-bold text-white border-b border-zinc-800 pb-1">{renderInline(line.slice(3))}</h2>;
  if (line.startsWith('### '))
    return <h3 className="mt-3 mb-1 text-xs font-semibold text-zinc-300 uppercase tracking-wide">{renderInline(line.slice(4))}</h3>;
  if (line.match(/^(\d+)\.\s/)) {
    const num = line.match(/^(\d+)\./)![1];
    return (
      <div className="flex gap-2 mb-0.5">
        <span className="shrink-0 text-orange-500/70 font-mono text-xs mt-0.5">{num}.</span>
        <span className="text-xs text-zinc-400 leading-relaxed">{renderInline(line.replace(/^\d+\.\s/, ''))}</span>
      </div>
    );
  }
  if (line.startsWith('- '))
    return <div className="flex gap-2 mb-0.5"><span className="shrink-0 text-zinc-700 mt-0.5">•</span><span className="text-xs text-zinc-400">{renderInline(line.slice(2))}</span></div>;
  if (line.trim() === '---') return <hr className="my-2 border-zinc-800" />;
  if (line.trim() === '') return <div className="h-0.5" />;
  return <p className="text-xs text-zinc-400 leading-relaxed mb-0.5">{renderInline(line)}</p>;
}

// -------------------------------------------------------------------
// Compact tool detail panels (same logic as triage page, smaller styling)
// -------------------------------------------------------------------
type IncidentOutput = {
  totalIncidents?: number; knownFlaky?: boolean; avgResolutionMinutes?: number | null;
  recentIncidents?: Array<{ pipeline_name?: string; occurred_at?: string; resolved_at?: string; resolution_summary?: string; root_cause?: string; resolved_by?: string }>;
  mostCommonResolution?: string;
};

type RunbookOutput = {
  found?: boolean;
  runbooks?: Array<{ title?: string; content?: string; remediation_steps?: unknown; author?: string }>;
};

type GitOutput = {
  commits?: Array<{ sha?: string; message?: string; author?: string; files?: string[]; committedAt?: string; isLikelyCause?: boolean }>;
  source?: string;
};

type ClassifyOutput = {
  failureType?: string; confidence?: number; affectedPipeline?: string; keySignals?: string[];
};

type ToolOutputs = {
  classifyFailure?: unknown;
  searchRunbooks?: unknown;
  lookupIncidentHistory?: unknown;
  searchGitContext?: unknown;
};

function EvalToolSection({ toolOutputs }: { toolOutputs: ToolOutputs }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {/* Classification */}
      {!!toolOutputs.classifyFailure && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">⚡ Classification</p>
          {(() => {
            const o = toolOutputs.classifyFailure as ClassifyOutput;
            return (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono text-orange-400">{o.failureType}</code>
                  <span className="text-xs text-zinc-600">{o.confidence ? Math.round(o.confidence * 100) : '?'}% confidence</span>
                </div>
                {o.keySignals && o.keySignals.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {o.keySignals.slice(0, 4).map((s, i) => (
                      <span key={i} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-500">{s}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Runbook */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">📚 Runbooks</p>
        {(() => {
          const o = toolOutputs.searchRunbooks as RunbookOutput | undefined;
          if (!o?.found || !o?.runbooks?.length)
            return <p className="text-xs text-zinc-700 italic">No matching runbooks</p>;
          return (
            <div className="space-y-2">
              {o.runbooks.slice(0, 2).map((rb, i) => {
                const steps = rb.remediation_steps
                  ? (typeof rb.remediation_steps === 'string' ? JSON.parse(rb.remediation_steps) : rb.remediation_steps) as string[]
                  : [];
                return (
                  <div key={i}>
                    <p className="text-xs font-medium text-zinc-300 mb-1">{rb.title}</p>
                    <p className="text-xs text-zinc-600 leading-relaxed mb-1">{rb.content?.slice(0, 120)}...</p>
                    {steps.slice(0, 3).map((step, j) => (
                      <div key={j} className="flex gap-1.5 text-xs text-zinc-500">
                        <span className="text-orange-500/60 shrink-0">{j + 1}.</span>
                        <span>{step.slice(0, 80)}{step.length > 80 ? '...' : ''}</span>
                      </div>
                    ))}
                    {steps.length > 3 && <p className="text-xs text-zinc-700 mt-0.5">+{steps.length - 3} more steps</p>}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {/* Incident History */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">🔍 Incident History</p>
        {(() => {
          const o = toolOutputs.lookupIncidentHistory as IncidentOutput | undefined;
          if (!o) return <p className="text-xs text-zinc-700 italic">No data</p>;
          return (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div><span className="text-base font-bold text-zinc-200">{o.totalIncidents ?? 0}</span><span className="text-xs text-zinc-600 ml-1">incidents (90d)</span></div>
                {o.avgResolutionMinutes != null && <div><span className="text-sm font-bold text-zinc-300">{o.avgResolutionMinutes}m</span><span className="text-xs text-zinc-600 ml-1">avg resolution</span></div>}
                {o.knownFlaky && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-400">⚠️ Flaky</span>}
              </div>
              {o.recentIncidents?.slice(0, 3).map((inc, i) => {
                const occurred = inc.occurred_at ? new Date(inc.occurred_at) : null;
                const resolved = inc.resolved_at ? new Date(inc.resolved_at) : null;
                const resMin = occurred && resolved ? Math.round((resolved.getTime() - occurred.getTime()) / 60000) : null;
                return (
                  <div key={i} className="border-t border-zinc-800/60 pt-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-zinc-500">{occurred?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) ?? '—'}</span>
                      {resMin != null && <span className="text-xs text-zinc-700">resolved in {resMin}m</span>}
                    </div>
                    {inc.resolution_summary && <p className="text-xs text-zinc-600 mt-0.5 leading-relaxed">{inc.resolution_summary}</p>}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {/* Git Context */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">🔀 Git Context</p>
        {(() => {
          const o = toolOutputs.searchGitContext as GitOutput | undefined;
          const commits = o?.commits ?? [];
          if (commits.length === 0)
            return <p className="text-xs text-zinc-700 italic">No recent commits found</p>;
          return (
            <div className="space-y-1.5">
              {commits.slice(0, 3).map((c, i) => {
                const committed = c.committedAt ? new Date(c.committedAt) : null;
                const hoursAgo = committed ? Math.round((Date.now() - committed.getTime()) / 3600000) : null;
                return (
                  <div key={i} className={`rounded border px-2 py-1.5 ${c.isLikelyCause ? 'border-orange-500/30 bg-orange-950/20' : 'border-zinc-800/60'}`}>
                    <div className="flex items-center gap-2">
                      {c.isLikelyCause && <span className="text-xs font-semibold text-orange-400">⚠️ Likely cause</span>}
                      {c.sha && <code className="text-xs font-mono text-zinc-700">{c.sha.slice(0, 7)}</code>}
                      {hoursAgo != null && <span className="text-xs text-zinc-700">{hoursAgo}h ago</span>}
                    </div>
                    <p className={`text-xs font-medium mt-0.5 ${c.isLikelyCause ? 'text-orange-300' : 'text-zinc-400'}`}>{c.message}</p>
                    {c.author && <p className="text-xs text-zinc-700">by {c.author}</p>}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------
interface EvalResult {
  id: string;
  name: string;
  inputLog?: string;
  expectedType: string;
  gotType: string | null;
  confidence: number;
  runbookFound: boolean;
  foundGitCause: boolean;
  keywordsPass: boolean;
  forbiddenPass: boolean;
  passed: boolean;
  error?: string;
  responseText?: string;
  toolOutputs?: ToolOutputs;
}

interface Summary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
}

const EVAL_NAMES = [
  'Ambiguous log — insufficient info',
  'Cascading failure — downstream dbt tests from upstream Fivetran',
  'Databricks resource exhaustion',
  'First-ever failure on revenue mart — escalate',
  'Fivetran orders — known flaky upstream',
  'Schema mismatch with smoking-gun PR',
  'Snowflake permission denied — quarterly rotation',
  'dbt compilation error — missing ref',
];

// -------------------------------------------------------------------
// Page
// -------------------------------------------------------------------
export default function EvalsPage() {
  const [results, setResults] = useState<EvalResult[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function runEvals() {
    setLoading(true);
    setError(null);
    setResults([]);
    setSummary(null);
    setTotal(0);
    setExpandedId(null);

    try {
      const res = await fetch('/api/evals/run');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as {
              type: string; total?: number; passed?: number; failed?: number; passRate?: number; data?: EvalResult;
            };
            if (event.type === 'start') setTotal(event.total ?? 0);
            else if (event.type === 'result' && event.data) setResults(prev => [...prev, event.data!]);
            else if (event.type === 'done') setSummary({ total: event.total ?? 0, passed: event.passed ?? 0, failed: event.failed ?? 0, passRate: event.passRate ?? 0 });
          } catch { /* ignore malformed lines */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const completedCount = results.length;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition">← Dispatch</Link>
          <span className="text-zinc-700">/</span>
          <span className="text-sm font-medium text-zinc-300">Evals</span>
        </div>
        <Link href="/triage" className="text-xs text-zinc-600 hover:text-zinc-400 transition">Triage →</Link>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white mb-2">Eval Suite</h1>
            <p className="text-sm text-zinc-500 max-w-lg">
              8 test cases. Click any row to see the full agent response and tool outputs.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {loading && total > 0 && (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <span className="text-zinc-500">{completedCount}/{total}</span>
                <div className="h-1.5 w-24 rounded-full bg-zinc-800 overflow-hidden">
                  <div className="h-full bg-orange-500 transition-all duration-500" style={{ width: `${(completedCount / total) * 100}%` }} />
                </div>
              </div>
            )}
            {summary && !loading && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-zinc-500">{summary.passed}/{summary.total} passing</span>
                <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${summary.passRate >= 75 ? 'bg-green-500/10 text-green-400' : summary.passRate >= 50 ? 'bg-yellow-500/10 text-yellow-400' : 'bg-red-500/10 text-red-400'}`}>
                  {summary.passRate}%
                </span>
              </div>
            )}
            <button onClick={runEvals} disabled={loading}
              className="rounded-lg bg-orange-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50">
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  Running... ({completedCount}/{total || '?'})
                </span>
              ) : 'Run Evals'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
            <strong>Error:</strong> {error}
          </div>
        )}

        <div className="rounded-xl border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900">
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">Test Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">Expected</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">Got</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wide">Runbook</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wide">Git</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wide">KW</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wide">!Bad</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wide">Pass/Fail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {EVAL_NAMES.map(name => {
                const r = results.find(x => x.name === name);
                const idx = EVAL_NAMES.indexOf(name);
                const isRunning = loading && !r && results.length >= idx && results.length < idx + 1;
                const isExpanded = r && expandedId === r.id;

                if (!r) {
                  return (
                    <tr key={name}>
                      <td className="px-4 py-3"><p className="text-xs font-medium text-zinc-500">{name}</p></td>
                      <td className="px-4 py-3 text-zinc-700 text-xs" colSpan={7}>
                        {isRunning ? (
                          <span className="flex items-center gap-2 text-zinc-500">
                            <svg className="h-3 w-3 animate-spin text-orange-500" viewBox="0 0 24 24" fill="none">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                            </svg>
                            Analyzing...
                          </span>
                        ) : <span className="text-zinc-800">pending</span>}
                      </td>
                    </tr>
                  );
                }

                return (
                  <>
                    <tr key={name}
                      onClick={() => setExpandedId(isExpanded ? null : r.id)}
                      className={`cursor-pointer transition-colors ${r.passed ? 'hover:bg-zinc-900/40' : 'bg-red-950/10 hover:bg-red-950/20'} ${isExpanded ? 'bg-zinc-900/60' : ''}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className={`text-zinc-700 transition-transform text-xs ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                          <p className="text-xs font-medium text-zinc-300">{r.name}</p>
                        </div>
                        {r.error && <p className="text-xs text-red-400 mt-0.5 pl-4">{r.error.slice(0, 80)}</p>}
                      </td>
                      <td className="px-4 py-3"><code className="text-xs text-zinc-500 font-mono">{r.expectedType}</code></td>
                      <td className="px-4 py-3">
                        <code className={`text-xs font-mono ${r.gotType === r.expectedType || (r.gotType === null && r.expectedType === 'unknown') ? 'text-green-400' : 'text-red-400'}`}>
                          {r.gotType ?? '—'}
                        </code>
                        {r.confidence > 0 && <span className="ml-1.5 text-xs text-zinc-600">{r.confidence}%</span>}
                      </td>
                      <td className="px-4 py-3 text-center"><CheckMark value={r.runbookFound} /></td>
                      <td className="px-4 py-3 text-center"><CheckMark value={r.foundGitCause} /></td>
                      <td className="px-4 py-3 text-center"><CheckMark value={r.keywordsPass} /></td>
                      <td className="px-4 py-3 text-center"><CheckMark value={r.forbiddenPass} /></td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${r.passed ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                          {r.passed ? '✓ Pass' : '✗ Fail'}
                        </span>
                      </td>
                    </tr>

                    {/* Expandable detail row */}
                    {isExpanded && (
                      <tr key={`${name}-detail`} className="bg-zinc-900/30">
                        <td colSpan={8} className="px-6 py-4 border-t border-zinc-800/60">
                          <div className="max-w-4xl space-y-4">
                            {/* Input log */}
                            {r.inputLog && (
                              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">Input Log</p>
                                <pre className="text-xs font-mono text-zinc-500 whitespace-pre-wrap leading-relaxed overflow-x-auto max-h-40 overflow-y-auto">{r.inputLog}</pre>
                              </div>
                            )}

                            {/* Tool outputs */}
                            {r.toolOutputs && <EvalToolSection toolOutputs={r.toolOutputs} />}

                            {/* Full response */}
                            {r.responseText && (
                              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-3">Full Agent Response</p>
                                <div>
                                  {r.responseText.split('\n').map((l, i) => <MarkdownLine key={i} line={l} />)}
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>

          {summary && (
            <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3 flex items-center justify-between">
              <p className="text-xs text-zinc-500">{summary.passed} of {summary.total} tests passing</p>
              <p className="text-xs text-zinc-600">Pass rate: {summary.passRate}%</p>
            </div>
          )}
          {!summary && !loading && results.length === 0 && (
            <div className="border-t border-zinc-800 px-4 py-4 text-center">
              <p className="text-xs text-zinc-700">Click &ldquo;Run Evals&rdquo; to execute all 8 test cases through Dispatch.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CheckMark({ value }: { value: boolean }) {
  return <span className={value ? 'text-green-500' : 'text-zinc-700'}>{value ? '✓' : '—'}</span>;
}
