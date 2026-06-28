import { generateText, isStepCount } from 'ai';
import { sql } from '@/lib/db';
import { getPrimaryModel, gatewayOptions } from '@/lib/models';
import { dispatchTools } from '@/lib/tools';
import { DISPATCH_SYSTEM_PROMPT } from '@/lib/system-prompt';

export const runtime = 'nodejs';
export const maxDuration = 120;

type ContentPart = Record<string, unknown>;

export async function GET() {
  const cases = await sql`
    SELECT * FROM eval_cases
    WHERE org_id = 'default'
    ORDER BY name
  `;

  if (cases.length === 0) {
    return Response.json(
      { error: 'No eval cases found. Run scripts/seed.ts first.' },
      { status: 404 }
    );
  }

  const encoder = new TextEncoder();

  // Stream NDJSON: one JSON line per event so the client can update the table
  // progressively as each eval case completes (60-90s total, 8 cases).
  const stream = new ReadableStream({
    async start(controller) {
      const push = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));

      push({ type: 'start', total: cases.length });

      let passCount = 0;

      for (const evalCase of cases) {
        try {
          const { steps } = await generateText({
            model: getPrimaryModel(),
            system: DISPATCH_SYSTEM_PROMPT,
            prompt: evalCase.input_log,
            tools: dispatchTools,
            providerOptions: gatewayOptions,
            stopWhen: isStepCount(8),
          });

          // Collect tool inputs and outputs by iterating step.content directly.
          // In AI SDK v7, step.toolResults / step.toolCalls are getters over
          // step.content filtered by part.type. Using content directly is the
          // most reliable approach regardless of step layout.
          const toolInputs: Record<string, Record<string, unknown>> = {};
          const toolOutputs: Record<string, unknown> = {};
          const textParts: string[] = [];

          for (const step of steps) {
            const content = (step.content ?? []) as ContentPart[];
            for (const part of content) {
              if (part['type'] === 'text' && typeof part['text'] === 'string') {
                if (part['text']) textParts.push(part['text'] as string);
              } else if (
                part['type'] === 'tool-call' &&
                typeof part['toolName'] === 'string'
              ) {
                toolInputs[part['toolName'] as string] =
                  (part['input'] as Record<string, unknown>) ?? {};
              } else if (
                part['type'] === 'tool-result' &&
                typeof part['toolName'] === 'string'
              ) {
                toolOutputs[part['toolName'] as string] = part['output'];
              }
            }
            // Also capture step.text (the model's text output for this step)
            if (step.text) textParts.push(step.text);
          }

          // Deduplicate and join text
          const fullText = [...new Set(textParts)].join('\n');

          // Debug: log what we collected
          console.log(`[eval] ${evalCase.name}`, {
            tools: Object.keys(toolOutputs),
            textLen: fullText.length,
          });

          // --- Scoring ---

          // classifyFailure: output = echoed input (execute returns its arg)
          const classifyOutput =
            (toolOutputs['classifyFailure'] ?? toolInputs['classifyFailure']) as
              | { failureType?: string; confidence?: number }
              | undefined;
          const gotFailureType = classifyOutput?.failureType ?? null;
          const confidence = classifyOutput?.confidence ?? 0;

          const runbookOutput = toolOutputs['searchRunbooks'] as
            | { found?: boolean }
            | undefined;
          const runbookFound = runbookOutput?.found ?? false;

          const gitOutput = toolOutputs['searchGitContext'] as
            | { commits?: Array<{ isLikelyCause?: boolean }> }
            | undefined;
          const foundGitCause =
            gitOutput?.commits?.some(c => c.isLikelyCause) ?? false;

          const expectedKeywords: string[] = evalCase.expected_keywords ?? [];
          const keywordsPass =
            expectedKeywords.length === 0 ||
            expectedKeywords.every(kw =>
              fullText.toLowerCase().includes(kw.toLowerCase())
            );

          const forbiddenPatterns: string[] = evalCase.forbidden_patterns ?? [];
          // Word-boundary aware: don't flag "do NOT just retry" as containing "just retry"
          const forbiddenPass =
            forbiddenPatterns.length === 0 ||
            !forbiddenPatterns.some(p => {
              const lower = fullText.toLowerCase();
              const patLower = p.toLowerCase();
              const idx = lower.indexOf(patLower);
              if (idx === -1) return false;
              const before = lower.slice(Math.max(0, idx - 15), idx);
              if (/\b(not|don'?t|do not|never|avoid|without)\s*$/.test(before)) return false;
              return true;
            });

          const typeCorrect =
            gotFailureType === evalCase.expected_failure_type ||
            // null classification counts as 'unknown' — model may skip classifyFailure
            // on an extremely vague log and just ask for more context
            (gotFailureType === null && evalCase.expected_failure_type === 'unknown');
          const runbookCorrect = !evalCase.should_find_runbook || runbookFound;
          const gitCorrect = !evalCase.should_find_git_cause || foundGitCause;

          const passed =
            typeCorrect && runbookCorrect && gitCorrect && keywordsPass && forbiddenPass;
          if (passed) passCount++;

          push({
            type: 'result',
            data: {
              id: evalCase.id,
              name: evalCase.name,
              expectedType: evalCase.expected_failure_type,
              gotType: gotFailureType,
              confidence: Math.round(confidence * 100),
              runbookFound,
              foundGitCause,
              keywordsPass,
              forbiddenPass,
              passed,
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
          push({
            type: 'result',
            data: {
              id: evalCase.id,
              name: evalCase.name,
              expectedType: evalCase.expected_failure_type,
              gotType: null,
              confidence: 0,
              runbookFound: false,
              foundGitCause: false,
              keywordsPass: false,
              forbiddenPass: false,
              passed: false,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      push({
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
