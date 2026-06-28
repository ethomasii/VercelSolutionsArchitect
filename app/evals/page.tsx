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

interface EvalRunResult {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  results: EvalResult[];
}

export default function EvalsPage() {
  const [results, setResults] = useState<EvalRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runEvals() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/evals/run');
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

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
            {results && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-zinc-500">{results.passed}/{results.total} passing</span>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    results.passRate >= 75
                      ? 'bg-green-500/10 text-green-400'
                      : results.passRate >= 50
                      ? 'bg-yellow-500/10 text-yellow-400'
                      : 'bg-red-500/10 text-red-400'
                  }`}
                >
                  {results.passRate}%
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
                  Running evals...
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

        {loading && !results && (
          <div className="text-center py-16">
            <div className="inline-flex flex-col items-center gap-3">
              <svg className="h-6 w-6 animate-spin text-orange-500" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              <p className="text-sm text-zinc-500">Running 8 eval cases through Dispatch...</p>
              <p className="text-xs text-zinc-600">This takes ~60-90 seconds.</p>
            </div>
          </div>
        )}

        {results && (
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">
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
                {results.results.map(r => (
                  <tr key={r.id} className={`hover:bg-zinc-900/50 transition ${r.passed ? '' : 'bg-red-950/10'}`}>
                    <td className="px-4 py-3 text-zinc-300 max-w-xs">
                      <p className="font-medium text-xs">{r.name}</p>
                      {r.error && (
                        <p className="text-xs text-red-400 mt-0.5">{r.error.slice(0, 80)}</p>
                      )}
                      {r.responsePreview && !r.error && (
                        <p className="text-xs text-zinc-600 mt-0.5 truncate max-w-[200px]">
                          {r.responsePreview}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-xs text-zinc-500 font-mono">
                        {r.expectedType}
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <code
                        className={`text-xs font-mono ${
                          r.gotType === r.expectedType
                            ? 'text-green-400'
                            : 'text-red-400'
                        }`}
                      >
                        {r.gotType ?? '—'}
                      </code>
                      {r.confidence > 0 && (
                        <span className="ml-2 text-xs text-zinc-600">
                          {r.confidence}%
                        </span>
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
                          r.passed
                            ? 'bg-green-500/10 text-green-400'
                            : 'bg-red-500/10 text-red-400'
                        }`}
                      >
                        {r.passed ? '✓ Pass' : '✗ Fail'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Summary footer */}
            <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3 flex items-center justify-between">
              <p className="text-xs text-zinc-500">
                {results.passed} of {results.total} tests passing
              </p>
              <p className="text-xs text-zinc-600">
                Pass rate: {results.passRate}%
              </p>
            </div>
          </div>
        )}

        {!results && !loading && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30">
            {/* Preview of eval case names */}
            <div className="divide-y divide-zinc-800/50">
              {[
                'Schema mismatch with smoking-gun PR',
                'Fivetran orders — known flaky upstream',
                'dbt compilation error — missing ref',
                'Databricks resource exhaustion',
                'Snowflake permission denied — quarterly rotation',
                'First-ever failure on revenue mart — escalate',
                'Cascading failure — downstream from upstream Fivetran',
                'Ambiguous log — insufficient info',
              ].map((name, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <span className="text-sm text-zinc-400">{name}</span>
                  <span className="text-xs text-zinc-700 font-mono">pending</span>
                </div>
              ))}
            </div>
            <div className="border-t border-zinc-800 px-4 py-3 text-center">
              <p className="text-xs text-zinc-600">
                Click &ldquo;Run Evals&rdquo; to execute all 8 test cases through Dispatch.
              </p>
            </div>
          </div>
        )}
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
