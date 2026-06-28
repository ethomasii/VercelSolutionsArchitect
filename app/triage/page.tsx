'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

// Tool step metadata for the streaming progress UI
const TOOL_META: Record<string, { icon: string; label: string; loadingLabel: string }> = {
  classifyFailure: {
    icon: '⚡',
    label: 'Classified failure',
    loadingLabel: 'Classifying failure...',
  },
  searchRunbooks: {
    icon: '📚',
    label: 'Searched runbooks',
    loadingLabel: 'Searching runbooks...',
  },
  lookupIncidentHistory: {
    icon: '🔍',
    label: 'Checked incident history',
    loadingLabel: 'Checking incident history...',
  },
  searchGitContext: {
    icon: '🔀',
    label: 'Searched git context',
    loadingLabel: 'Searching git context...',
  },
};

type ToolPartGeneric = {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
};

function getToolOutputSummary(toolName: string, part: ToolPartGeneric): string {
  if (part.state !== 'output-available') return '';

  if (toolName === 'classifyFailure') {
    const i = part.input as { failureType?: string; confidence?: number } | undefined;
    const pct = i?.confidence ? Math.round(i.confidence * 100) : null;
    return `${i?.failureType ?? 'unknown'}${pct ? ` (confidence: ${pct}%)` : ''}`;
  }

  if (toolName === 'searchRunbooks') {
    const o = part.output as { found?: boolean; runbooks?: unknown[] } | undefined;
    const count = o?.runbooks?.length ?? 0;
    return o?.found
      ? `${count} runbook${count !== 1 ? 's' : ''} found`
      : 'no matching runbooks';
  }

  if (toolName === 'lookupIncidentHistory') {
    const o = part.output as { totalIncidents?: number; knownFlaky?: boolean } | undefined;
    const flaky = o?.knownFlaky ? ' — ⚠️ known flaky' : '';
    return `${o?.totalIncidents ?? 0} prior incident${(o?.totalIncidents ?? 0) !== 1 ? 's' : ''} found${flaky}`;
  }

  if (toolName === 'searchGitContext') {
    const o = part.output as {
      commits?: Array<{ isLikelyCause?: boolean; message?: string }>;
    } | undefined;
    const causeCommit = o?.commits?.find(c => c.isLikelyCause);
    if (causeCommit) {
      return `PR merged recently: "${causeCommit.message?.slice(0, 60)}"`;
    }
    const count = o?.commits?.length ?? 0;
    return count > 0
      ? `${count} recent commit${count !== 1 ? 's' : ''}, none likely cause`
      : 'no recent changes found';
  }

  return 'completed';
}

function ToolPart({ toolName, part }: { toolName: string; part: ToolPartGeneric }) {
  const meta = TOOL_META[toolName] ?? {
    icon: '🔧',
    label: toolName,
    loadingLabel: `Running ${toolName}...`,
  };

  const isLoading = part.state === 'input-streaming' || part.state === 'input-available';
  const hasCause =
    toolName === 'searchGitContext' &&
    part.state === 'output-available' &&
    (part.output as { commits?: Array<{ isLikelyCause?: boolean }> })?.commits?.some(
      c => c.isLikelyCause
    );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-sm">
        <span className="animate-pulse">{meta.icon}</span>
        <span className="text-zinc-400">{meta.loadingLabel}</span>
        <svg
          className="ml-auto h-3 w-3 animate-spin text-orange-500"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
      </div>
    );
  }

  if (part.state === 'output-available') {
    const summary = getToolOutputSummary(toolName, part);
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-2.5 text-sm">
        <span>{meta.icon}</span>
        <span className="text-zinc-300">{meta.label}</span>
        <span className="text-zinc-700">→</span>
        <span className={`text-xs ${hasCause ? 'font-semibold text-orange-400' : 'text-zinc-500'}`}>
          {hasCause ? '⚠️ ' : ''}{summary}
        </span>
      </div>
    );
  }

  return null;
}

type UIMessagePart = {
  type: string;
  text?: string;
  toolCallId?: string;
  state?: string;
  [key: string]: unknown;
};

function MessageParts({ parts }: { parts: UIMessagePart[] }) {
  return (
    <div className="space-y-2">
      {parts.map((part, i) => {
        if (part.type === 'text' && part.text) {
          return (
            <div key={i} className="whitespace-pre-wrap text-sm text-zinc-200 leading-relaxed">
              {part.text as string}
            </div>
          );
        }

        if (part.type.startsWith('tool-')) {
          const toolName = part.type.slice(5); // strip 'tool-' prefix
          return (
            <ToolPart
              key={(part.toolCallId as string | undefined) ?? i}
              toolName={toolName}
              part={part as unknown as ToolPartGeneric}
            />
          );
        }

        return null;
      })}
    </div>
  );
}

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
  const [input, setInput] = useState(prefillLog);
  const [sharedToSlack, setSharedToSlack] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });

  // Auto-submit if pre-filled from landing page chip
  const autoSubmitted = useRef(false);
  useEffect(() => {
    if (prefillLog && !autoSubmitted.current && status === 'ready') {
      autoSubmitted.current = true;
      sendMessage({ text: prefillLog });
      setInput('');
    }
  }, [prefillLog, sendMessage, status]);

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const isStreaming = status === 'streaming' || status === 'submitted';
  const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant');

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition">
            ← Dispatch
          </Link>
          <span className="text-zinc-700">/</span>
          <span className="text-sm font-medium text-zinc-300">Triage</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
              isStreaming
                ? 'bg-orange-500/10 text-orange-400'
                : 'bg-zinc-800 text-zinc-500'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isStreaming ? 'bg-orange-500 animate-pulse' : 'bg-zinc-600'
              }`}
            />
            {isStreaming ? 'Analyzing...' : 'Ready'}
          </span>
          <Link
            href="/evals"
            className="text-xs text-zinc-600 hover:text-zinc-400 transition"
          >
            Evals →
          </Link>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6 space-y-6">
          {messages.length === 0 && !isStreaming && (
            <div className="text-center py-16">
              <p className="text-zinc-600 text-sm">
                Paste a pipeline error log below to start triage.
              </p>
            </div>
          )}

          {messages.map(message => (
            <div key={message.id}>
              {message.role === 'user' ? (
                <div className="flex justify-end">
                  <div className="max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
                    <p className="text-xs text-zinc-500 mb-1">Error log</p>
                    <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto">
                      {message.parts
                        .filter((p: UIMessagePart) => p.type === 'text')
                        .map((p: UIMessagePart) => p.text)
                        .join('')}
                    </pre>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-orange-600 text-xs font-bold text-white">
                      D
                    </span>
                    <span className="text-xs font-semibold text-zinc-400">Dispatch</span>
                  </div>
                  <MessageParts parts={message.parts as UIMessagePart[]} />

                  {/* Share to Slack button */}
                  {!isStreaming && message.id === lastAssistantMessage?.id && (
                    <div className="mt-4">
                      <button
                        onClick={() => {
                          setSharedToSlack(true);
                          setTimeout(() => setSharedToSlack(false), 3000);
                        }}
                        className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
                      >
                        {sharedToSlack ? (
                          <>
                            <span className="text-green-500">✓</span>
                            Posted to #data-alerts
                          </>
                        ) : (
                          <>
                            <span>💬</span>
                            Share to Slack
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-zinc-800 bg-zinc-950 px-6 py-4">
        <div className="mx-auto max-w-3xl">
          <form
            onSubmit={e => {
              e.preventDefault();
              if (input.trim() && !isStreaming) {
                sendMessage({ text: input });
                setInput('');
              }
            }}
          >
            <div className="relative">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (input.trim() && !isStreaming) {
                      sendMessage({ text: input });
                      setInput('');
                    }
                  }
                }}
                disabled={isStreaming}
                placeholder="Paste pipeline error log here... (⌘+Enter to submit)"
                rows={4}
                className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 pr-24 text-sm text-zinc-200 placeholder-zinc-600 outline-none ring-0 transition focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700 disabled:opacity-50 font-mono"
              />
              <button
                type="submit"
                disabled={!input.trim() || isStreaming}
                className="absolute bottom-3 right-3 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isStreaming ? 'Analyzing...' : 'Triage →'}
              </button>
            </div>
            <p className="mt-2 text-xs text-zinc-600">
              Dispatch classifies the failure, searches runbooks, checks incident history, and looks for recent code changes.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
