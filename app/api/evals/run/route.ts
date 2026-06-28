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
    return Response.json({ error: 'No eval cases found. Run scripts/seed.ts first.' }, { status: 404 });
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

      // Collect all tool calls from all steps
      type RawToolCall = { toolName: string; input?: Record<string, unknown>; toolCallId: string; dynamic?: boolean; result?: unknown };
      const toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }> = [];
      for (const step of steps) {
        for (const toolCall of step.toolCalls ?? []) {
          if (toolCall.dynamic) continue;
          const tc = toolCall as unknown as RawToolCall;
          const result = step.toolResults?.find(r => r.toolCallId === tc.toolCallId);
          toolCalls.push({
            toolName: tc.toolName,
            args: tc.input ?? {},
            result: (result as { result?: unknown } | undefined)?.result,
          });
        }
      }

      // Extract final text response
      const finalText = steps[steps.length - 1]?.text ?? '';

      // Score the eval
      const classifyCall = toolCalls.find(t => t.toolName === 'classifyFailure');
      const classifyArgs = classifyCall?.args as { failureType?: string; confidence?: number } | undefined;
      const gotFailureType = classifyArgs?.failureType ?? null;
      const confidence = classifyArgs?.confidence ?? 0;

      const runbookCall = toolCalls.find(t => t.toolName === 'searchRunbooks');
      const runbookResult = runbookCall?.result as { found?: boolean } | undefined;
      const runbookFound = runbookResult?.found ?? false;

      const gitCall = toolCalls.find(t => t.toolName === 'searchGitContext');
      const gitResult = gitCall?.result as {
        commits?: Array<{ isLikelyCause?: boolean }>;
      } | undefined;
      const foundGitCause =
        gitResult?.commits?.some((c: { isLikelyCause?: boolean }) => c.isLikelyCause) ?? false;

      // Check keywords present in response
      const expectedKeywords: string[] = evalCase.expected_keywords ?? [];
      const keywordsPass =
        expectedKeywords.length === 0 ||
        expectedKeywords.every(kw =>
          finalText.toLowerCase().includes(kw.toLowerCase())
        );

      // Check forbidden patterns absent from response
      const forbiddenPatterns: string[] = evalCase.forbidden_patterns ?? [];
      const forbiddenPass =
        forbiddenPatterns.length === 0 ||
        !forbiddenPatterns.some(p =>
          finalText.toLowerCase().includes(p.toLowerCase())
        );

      const typeCorrect = gotFailureType === evalCase.expected_failure_type;
      const runbookCorrect =
        !evalCase.should_find_runbook || runbookFound;
      const gitCorrect =
        !evalCase.should_find_git_cause || foundGitCause;

      const passed =
        typeCorrect && runbookCorrect && gitCorrect && keywordsPass && forbiddenPass;

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
        responsePreview: finalText.slice(0, 300),
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
