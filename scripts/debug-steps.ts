import { generateText, isStepCount } from 'ai';
import { neon } from '@neondatabase/serverless';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

// Inline imports to avoid module resolution issues in script context
process.env.DATABASE_URL = process.env.DATABASE_URL!;

async function debug() {
  // Import tools and models after env is set
  const { dispatchTools } = await import('../lib/tools');
  const { getPrimaryModel, gatewayOptions } = await import('../lib/models');
  const { DISPATCH_SYSTEM_PROMPT } = await import('../lib/system-prompt');

  const testLog = `ERROR 2026-06-28 02:14:33 UTC [dbt] KeyError: 'customer_tier'
  column "customer_tier" of relation "dim_customers" does not exist
  Pipeline: dbt_customers_transform`;

  console.log('Running generateText with tools...\n');

  const { steps, text } = await generateText({
    model: getPrimaryModel(),
    system: DISPATCH_SYSTEM_PROMPT,
    prompt: testLog,
    tools: dispatchTools,
    providerOptions: gatewayOptions,
    stopWhen: isStepCount(8),
  });

  console.log(`\n=== STEPS (${steps.length} total) ===\n`);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log(`--- Step ${i} ---`);
    console.log('  step.text:', step.text?.slice(0, 80) || '(empty)');
    console.log('  step.toolCalls.length:', step.toolCalls?.length ?? 0);
    console.log('  step.toolResults.length:', step.toolResults?.length ?? 0);
    console.log('  step.content?.length:', step.content?.length ?? 'NO CONTENT PROP');
    console.log('  typeof step.content:', typeof (step as any).content);

    if (step.content) {
      console.log('  step.content types:', step.content.map((p: any) => p.type));
      const toolResults = step.content.filter((p: any) => p.type === 'tool-result');
      console.log('  tool-result parts:', toolResults.length);
      for (const tr of toolResults) {
        const r = tr as any;
        console.log(`    [${r.toolName}] output keys:`, r.output ? Object.keys(r.output) : 'null/undefined');
        if (r.toolName === 'searchRunbooks') {
          console.log(`    searchRunbooks.output:`, JSON.stringify(r.output).slice(0, 200));
        }
      }
    }

    if (step.toolResults?.length) {
      console.log('  step.toolResults names:', step.toolResults.map((r: any) => r.toolName));
      for (const tr of step.toolResults) {
        const r = tr as any;
        console.log(`    [${r.toolName}] type:${r.type} output:`, JSON.stringify(r.output).slice(0, 100));
      }
    }
  }

  console.log('\n=== FINAL TEXT ===\n', text?.slice(0, 200));
}

debug().catch(err => {
  console.error('Debug failed:', err);
  process.exit(1);
});
