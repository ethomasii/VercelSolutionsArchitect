import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  UIMessage,
} from 'ai';
import { getPrimaryModel, gatewayOptions } from '@/lib/models';
import { dispatchTools } from '@/lib/tools';
import { DISPATCH_SYSTEM_PROMPT } from '@/lib/system-prompt';

// Node.js runtime, not Edge. Two reasons:
// 1. Multi-step tool calling with 4 sequential Neon queries can exceed Edge's
//    wall clock limit on complex logs with long incident histories.
// 2. Neon's serverless driver handles connection pooling via DATABASE_URL
//    automatically, and Node gives us the most reliable behavior.
// Fluid Compute means we still get serverless cost model — zero idle cost,
// billed only for active compute time. Best of both worlds.
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: getPrimaryModel(),
    system: DISPATCH_SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools: dispatchTools,
    providerOptions: gatewayOptions,
    // stopWhen: isStepCount(8) gives headroom for the 4-tool sequence plus
    // any retry steps if the model needs to refine a tool call. In practice
    // this runs in 4-5 steps. Cap prevents runaway loops.
    stopWhen: isStepCount(8),
    onStepEnd({ stepNumber, toolCalls, usage }) {
      // Step callbacks are our observability hook.
      // Today: console.log for development visibility.
      // Production upgrade: emit custom events to Vercel Analytics
      // (tool name, latency, tokens) or write to a /api/telemetry route.
      // AI Gateway already captures model-level metrics. This captures
      // tool-level metrics that Gateway can't see.
      console.log(
        '[dispatch] step:',
        stepNumber,
        toolCalls?.map(t => t.toolName).join(', ') || '—',
        '| tokens:',
        usage?.totalTokens ?? '?'
      );
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
