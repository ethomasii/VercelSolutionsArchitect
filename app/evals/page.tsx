'use client';

import { useState } from 'react';
import Link from 'next/link';

interface EvalResult {
  id: string;
  name: string;
  expectedType: string;
  gotType: string | null;
  confidence: number;
  runbookFound: boolean;
  foundGitCause: boolean;
  keywordsPass: boolean;
  forbiddenPass: boolean;
  passed: boolean;
  error?: string;
  responsePreview?: string;
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

export default function EvalsPage() {
  const [results, setResults] = useState<EvalResult[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function runEvals() {
    setLoading(true);
    setError(null);
    setResults([]);
    setSummary(null);
    setTotal(0);

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
        buffer = lines.pop() ?? ''; // keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as {
              type: string;
              total?: number;
              passed?: number;
              failed?: number;
              passRate?: number;
              data?: EvalResult;
            };

            if (event.type === 'start') {
              setTotal(event.total ?? 0);
            } else if (event.type === 'result' && event.data) {
              setResults(prev => [...prev, event.data!]);
            } else if (event.type === 'done') {
              setSummary({
                total: event.total ?? 0,
                passed: event.passed ?? 0,
                failed: event.failed ?? 0,
                passRate: event.passRate ?? 0,
              });
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const passRate = summary?.passRate ?? null;
  const completedCount = results.length;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition">
            ← Dispatch
          </Link>
          <span className="text-zinc-700">/</span>
          <span className="text-sm font-medium text-zinc-300">Evals</span>
        </div>
        <Link href="/triage" className="text-xs text-zinc-600 hover:text-zinc-400 transition">
          Triage →
        </Link>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-8">
        {/* Title + run button */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white mb-2">Eval Suite</h1>
            <p className="text-sm text-zinc-500 max-w-lg">
              8 test cases covering schema mismatches, flaky pipelines, resource exhaustion,
              permission errors, cascading failures, and ambiguous logs.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {/* Progress / summary */}
            {loading && total > 0 && (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <span className="text-zinc-500">{completedCount}/{total}</span>
                <div className="h-1.5 w-24 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-orange-500 transition-all duration-500"
                    style={{ width: `${(completedCount / total) * 100}%` }}
                  />
                </div>
              </div>
            )}
            {summary && !loading && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-zinc-500">{summary.passed}/{summary.total} passing</span>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    (passRate ?? 0) >= 75
                      ? 'bg-green-500/10 text-green-400'
                      : (passRate ?? 0) >= 50
                      ? 'bg-yellow-500/10 text-yellow-400'
                      : 'bg-red-500/10 text-red-400'
                  }`}
                >
                  {passRate}%
                </span>
              </div>
            )}
            <button
              onClick={runEvals}
              disabled={loading}
              className="rounded-lg bg-orange-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  Running... ({completedCount}/{total || '?'})
                </span>
              ) : (
                'Run Evals'
              )}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
            <strong>Error:</strong> {error}
          </div>
        )}

        {/* Table — always visible, rows fill in as evals complete */}
        <div className="overflow-hidden rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900">
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide w-48">
                  Test Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Expected Type
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Got
                </th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Runbook
                </th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Git Cause
                </th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Keywords
                </th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Forbidden
                </th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Pass/Fail
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {EVAL_NAMES.map(name => {
                const r = results.find(x => x.name === name);
                const isRunning =
                  loading &&
                  !r &&
                  results.length < EVAL_NAMES.indexOf(name) + 1 &&
                  results.length >= EVAL_NAMES.indexOf(name);

                if (!r) {
                  return (
                    <tr key={name} className={isRunning ? 'bg-orange-950/10' : ''}>
                      <td className="px-4 py-3">
                        <p className="text-xs font-medium text-zinc-500">{name}</p>
                      </td>
                      <td className="px-4 py-3 text-zinc-700 text-xs" colSpan={7}>
                        {isRunning ? (
                          <span className="flex items-center gap-2 text-zinc-500">
                            <svg className="h-3 w-3 animate-spin text-orange-500" viewBox="0 0 24 24" fill="none">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                            </svg>
                            Analyzing...
                          </span>
                        ) : (
                          <span className="text-zinc-800">pending</span>
                        )}
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr
                    key={name}
                    className={`transition-colors ${r.passed ? 'hover:bg-zinc-900/30' : 'bg-red-950/10 hover:bg-red-950/20'}`}
                  >
                    <td className="px-4 py-3">
                      <p className="text-xs font-medium text-zinc-300">{r.name}</p>
                      {r.error && (
                        <p className="text-xs text-red-400 mt-0.5">{r.error.slice(0, 80)}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-xs text-zinc-500 font-mono">{r.expectedType}</code>
                    </td>
                    <td className="px-4 py-3">
                      <code
                        className={`text-xs font-mono ${
                          r.gotType === r.expectedType ? 'text-green-400' : 'text-red-400'
                        }`}
                      >
                        {r.gotType ?? '—'}
                      </code>
                      {r.confidence > 0 && (
                        <span className="ml-1.5 text-xs text-zinc-600">{r.confidence}%</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <CheckMark value={r.runbookFound} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <CheckMark value={r.foundGitCause} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <CheckMark value={r.keywordsPass} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <CheckMark value={r.forbiddenPass} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                          r.passed ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
                        }`}
                      >
                        {r.passed ? '✓ Pass' : '✗ Fail'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Summary footer */}
          {summary && (
            <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3 flex items-center justify-between">
              <p className="text-xs text-zinc-500">
                {summary.passed} of {summary.total} tests passing
              </p>
              <p className="text-xs text-zinc-600">Pass rate: {summary.passRate}%</p>
            </div>
          )}
          {!summary && !loading && results.length === 0 && (
            <div className="border-t border-zinc-800 px-4 py-3 text-center">
              <p className="text-xs text-zinc-700">
                Click &ldquo;Run Evals&rdquo; to execute all 8 test cases through Dispatch.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CheckMark({ value }: { value: boolean }) {
  return (
    <span className={value ? 'text-green-500' : 'text-zinc-700'}>
      {value ? '✓' : '—'}
    </span>
  );
}
