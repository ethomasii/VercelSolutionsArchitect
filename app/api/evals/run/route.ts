import { generateText, isStepCount } from 'ai';
import { sql } from '@/lib/db';
import { getPrimaryModel, gatewayOptions } from '@/lib/models';
import { dispatchTools } from '@/lib/tools';
import { DISPATCH_SYSTEM_PROMPT } from '@/lib/system-prompt';

export const runtime = 'nodejs';
export const maxDuration = 120;

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

  const results = [];

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

      // In AI SDK v7: tool calls have `input`, tool results have `output`
      type TC = {
        toolCallId: string;
        toolName: string;
        input: Record<string, unknown>;
        dynamic?: boolean;
      };
      type TR = {
        toolCallId: string;
        toolName: string;
        output: unknown;
      };

      interface Collected {
        toolName: string;
        input: Record<string, unknown>;
        output: unknown;
      }

      const collected: Collected[] = [];

      for (const step of steps) {
        for (const rawCall of step.toolCalls ?? []) {
          const tc = rawCall as unknown as TC;
          if (tc.dynamic) continue;
          const tr = (step.toolResults as unknown as TR[] | undefined)?.find(
            r => r.toolCallId === tc.toolCallId
          );
          collected.push({
            toolName: tc.toolName,
            input: tc.input ?? {},
            output: tr?.output,
          });
        }
      }

      // Collect text from ALL steps — the final narrative may not be in the last step
      const fullText = steps
        .map(s => s.text)
        .filter(Boolean)
        .join('\n');

      // --- Scoring ---

      const classifyEntry = collected.find(t => t.toolName === 'classifyFailure');
      // classifyFailure echoes its input as output; use either
      const classifyData = (classifyEntry?.output ?? classifyEntry?.input) as
        | { failureType?: string; confidence?: number }
        | undefined;
      const gotFailureType = classifyData?.failureType ?? null;
      const confidence = classifyData?.confidence ?? 0;

      const runbookEntry = collected.find(t => t.toolName === 'searchRunbooks');
      const runbookOutput = runbookEntry?.output as { found?: boolean } | undefined;
      const runbookFound = runbookOutput?.found ?? false;

      const gitEntry = collected.find(t => t.toolName === 'searchGitContext');
      const gitOutput = gitEntry?.output as {
        commits?: Array<{ isLikelyCause?: boolean }>;
      } | undefined;
      const foundGitCause =
        gitOutput?.commits?.some(c => c.isLikelyCause) ?? false;

      const expectedKeywords: string[] = evalCase.expected_keywords ?? [];
      const keywordsPass =
        expectedKeywords.length === 0 ||
        expectedKeywords.every(kw =>
          fullText.toLowerCase().includes(kw.toLowerCase())
        );

      const forbiddenPatterns: string[] = evalCase.forbidden_patterns ?? [];
      const forbiddenPass =
        forbiddenPatterns.length === 0 ||
        !forbiddenPatterns.some(p => fullText.toLowerCase().includes(p.toLowerCase()));

      const typeCorrect = gotFailureType === evalCase.expected_failure_type;
      const runbookCorrect = !evalCase.should_find_runbook || runbookFound;
      const gitCorrect = !evalCase.should_find_git_cause || foundGitCause;

      const passed = typeCorrect && runbookCorrect && gitCorrect && keywordsPass && forbiddenPass;

      results.push({
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
        responsePreview: fullText.slice(0, 300),
      });
    } catch (err) {
      results.push({
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
      });
    }
  }

  const passCount = results.filter(r => r.passed).length;
  return Response.json({
    total: results.length,
    passed: passCount,
    failed: results.length - passCount,
    passRate: Math.round((passCount / results.length) * 100),
    results,
  });
}
