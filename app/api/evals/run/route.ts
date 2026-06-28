import { generateText, isStepCount } from 'ai';
import { sql } from '@/lib/db';
import { getPrimaryModel, gatewayOptions } from '@/lib/models';
import { dispatchTools } from '@/lib/tools';
import { DISPATCH_SYSTEM_PROMPT } from '@/lib/system-prompt';

export const runtime = 'nodejs';
export const maxDuration = 300;

type ContentPart = Record<string, unknown>;

// Retry with exponential backoff for rate limit errors
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = msg.includes('RateLimit') || msg.includes('rate_limit') || msg.includes('429');
      if (!isRateLimit || attempt === maxAttempts) throw err;
      // Exponential backoff: 2s, 4s, 8s
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`[eval] Rate limited, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export async function GET() {
  const cases = await sql`
    SELECT * FROM eval_cases WHERE org_id = 'default' ORDER BY name
  `;

  if (cases.length === 0) {
    return Response.json({ error: 'No eval cases found. Run scripts/seed.ts first.' }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const push = (controller: ReadableStreamDefaultController, obj: unknown) =>
    controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));

  const stream = new ReadableStream({
    async start(controller) {
      push(controller, { type: 'start', total: cases.length });
      let passCount = 0;

      // 2 parallel now that AI Gateway credits are active — was 1 during rate limiting
      const BATCH_SIZE = 2;
      const BATCH_DELAY_MS = 300;
      for (let i = 0; i < cases.length; i += BATCH_SIZE) {
        const batch = cases.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async evalCase => {
            // Signal that this case has started — UI shows spinner immediately
            push(controller, { type: 'case-start', name: evalCase.name });

            try {
              const { steps } = await withRetry(() => generateText({
                model: getPrimaryModel(),
                system: DISPATCH_SYSTEM_PROMPT,
                prompt: evalCase.input_log,
                tools: dispatchTools,
                providerOptions: gatewayOptions,
                stopWhen: isStepCount(12),
                // Emit a step event after each tool call so the UI can show progress
                onStepEnd: ({ toolCalls }) => {
                  for (const tc of toolCalls ?? []) {
                    if (!(tc as { dynamic?: boolean }).dynamic) {
                      push(controller, {
                        type: 'step',
                        name: evalCase.name,
                        toolName: (tc as { toolName: string }).toolName,
                      });
                    }
                  }
                },
              }));

              // Collect tool inputs/outputs from content
              const toolInputs: Record<string, Record<string, unknown>> = {};
              const toolOutputs: Record<string, unknown> = {};
              const textParts: string[] = [];

              for (const step of steps) {
                const content = (step.content ?? []) as ContentPart[];
                for (const part of content) {
                  if (part['type'] === 'text' && typeof part['text'] === 'string' && part['text']) {
                    textParts.push(part['text'] as string);
                  } else if (part['type'] === 'tool-call' && typeof part['toolName'] === 'string') {
                    toolInputs[part['toolName'] as string] = (part['input'] as Record<string, unknown>) ?? {};
                  } else if (part['type'] === 'tool-result' && typeof part['toolName'] === 'string') {
                    toolOutputs[part['toolName'] as string] = part['output'];
                  }
                }
                if (step.text) textParts.push(step.text);
              }

              const fullText = [...new Set(textParts)].join('\n');

              // Scoring
              const classifyData = (toolOutputs['classifyFailure'] ?? toolInputs['classifyFailure']) as
                | { failureType?: string; confidence?: number } | undefined;
              const gotFailureType = classifyData?.failureType ?? null;
              const confidence = classifyData?.confidence ?? 0;

              const runbookOutput = toolOutputs['searchRunbooks'] as { found?: boolean } | undefined;
              const runbookFound = runbookOutput?.found ?? false;

              const gitOutput = toolOutputs['searchGitContext'] as {
                commits?: Array<{ isLikelyCause?: boolean }>;
              } | undefined;
              const foundGitCause = gitOutput?.commits?.some(c => c.isLikelyCause) ?? false;

              const expectedKeywords: string[] = evalCase.expected_keywords ?? [];
              const keywordsPass =
                expectedKeywords.length === 0 ||
                expectedKeywords.every(kw => fullText.toLowerCase().includes(kw.toLowerCase()));

              const forbiddenPatterns: string[] = evalCase.forbidden_patterns ?? [];
              const forbiddenPass =
                forbiddenPatterns.length === 0 ||
                !forbiddenPatterns.some(p => {
                  const lower = fullText.toLowerCase();
                  const idx = lower.indexOf(p.toLowerCase());
                  if (idx === -1) return false;
                  const before = lower.slice(Math.max(0, idx - 15), idx);
                  if (/\b(not|don'?t|do not|never|avoid|without)\s*$/.test(before)) return false;
                  return true;
                });

              const typeCorrect =
                gotFailureType === evalCase.expected_failure_type ||
                (gotFailureType === null && evalCase.expected_failure_type === 'unknown');
              const runbookCorrect = !evalCase.should_find_runbook || runbookFound;
              const gitCorrect = !evalCase.should_find_git_cause || foundGitCause;
              const passed = typeCorrect && runbookCorrect && gitCorrect && keywordsPass && forbiddenPass;
              if (passed) passCount++;

              push(controller, {
                type: 'result',
                data: {
                  id: evalCase.id,
                  name: evalCase.name,
                  inputLog: evalCase.input_log,
                  expectedType: evalCase.expected_failure_type,
                  gotType: gotFailureType,
                  confidence: Math.round(confidence * 100),
                  runbookFound, foundGitCause, keywordsPass, forbiddenPass, passed,
                  responseText: fullText,
                  toolOutputs: {
                    classifyFailure: toolOutputs['classifyFailure'] ?? toolInputs['classifyFailure'],
                    searchRunbooks: toolOutputs['searchRunbooks'],
                    lookupIncidentHistory: toolOutputs['lookupIncidentHistory'],
                    searchGitContext: toolOutputs['searchGitContext'],
                  },
                },
              });
            } catch (err) {
              push(controller, {
                type: 'result',
                data: {
                  id: evalCase.id,
                  name: evalCase.name,
                  inputLog: evalCase.input_log,
                  expectedType: evalCase.expected_failure_type,
                  gotType: null, confidence: 0,
                  runbookFound: false, foundGitCause: false,
                  keywordsPass: false, forbiddenPass: false, passed: false,
                  error: err instanceof Error ? err.message : String(err),
                },
              });
            }
          }          )
        );

        // Small gap between batches to avoid RPM rate limits
        if (i + BATCH_SIZE < cases.length) {
          await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        }
      }

      push(controller, {
        type: 'done',
        total: cases.length,
        passed: passCount,
        failed: cases.length - passCount,
        passRate: Math.round((passCount / cases.length) * 100),
      });

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
