import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  UIMessage,
} from 'ai';
import { createMCPClient } from '@ai-sdk/mcp';
import { getPrimaryModel, gatewayOptions } from '@/lib/models';
import { dispatchTools } from '@/lib/tools';
import { DISPATCH_SYSTEM_PROMPT } from '@/lib/system-prompt';
import { getSetting } from '@/lib/settings';

// Node.js runtime — needed for Neon, snowflake-sdk, and multi-step tool calling.
// Fluid Compute: zero idle cost, billed only for active compute time.
export const runtime = 'nodejs';
export const maxDuration = 60;

// Build active MCP clients from encrypted settings.
// Their tools merge with dispatchTools — the agent can call Dagster MCP's
// get_run_logs, list_assets, diagnose_dag_run etc. directly without our wrapper.
// New integrations = add a settings entry + MCP URL, not a new lib/integrations/*.ts file.
async function buildMcpClients() {
  const clients: Awaited<ReturnType<typeof createMCPClient>>[] = [];

  const dagsterToken = await getSetting('dagster', 'DAGSTER_TOKEN');
  const dagsterOrg = await getSetting('dagster', 'DAGSTER_ORG');
  if (dagsterToken && dagsterOrg) {
    try {
      clients.push(await createMCPClient({
        transport: {
          type: 'http',
          url: 'https://mcp.agent.dagster.cloud/mcp/',
          headers: {
            'Authorization': `Bearer ${dagsterToken}`,
            'Dagster-Cloud-Organization': dagsterOrg,
            'X-Dagster-Delegation-Token': dagsterToken,
          },
        },
      }));
    } catch (err) {
      console.warn('[mcp] Dagster connect failed:', err);
    }
  }

  const prefectMcpUrl = await getSetting('prefect', 'PREFECT_MCP_URL');
  const prefectApiKey = await getSetting('prefect', 'PREFECT_API_KEY');
  if (prefectMcpUrl) {
    try {
      clients.push(await createMCPClient({
        transport: {
          type: 'http',
          url: prefectMcpUrl,
          headers: prefectApiKey ? { 'Authorization': `Bearer ${prefectApiKey}` } : undefined,
        },
      }));
    } catch (err) {
      console.warn('[mcp] Prefect connect failed:', err);
    }
  }

  const airflowMcpUrl = await getSetting('airflow', 'AIRFLOW_MCP_URL');
  const airflowToken = await getSetting('airflow', 'AIRFLOW_MCP_TOKEN');
  if (airflowMcpUrl) {
    try {
      clients.push(await createMCPClient({
        transport: {
          type: 'http',
          url: airflowMcpUrl,
          headers: airflowToken ? { 'Authorization': `Bearer ${airflowToken}` } : undefined,
        },
      }));
    } catch (err) {
      console.warn('[mcp] Airflow connect failed:', err);
    }
  }

  return clients;
}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  // Build MCP clients from settings. Clients must stay open until stream ends —
  // we close them in onEnd, not in a finally block (premature close = NS_BASE_STREAM_CLOSED).
  // If none configured, only dispatchTools are available (full synthetic fallback works fine).
  const mcpClients = await buildMcpClients().catch(() => []);

  // Merge MCP tools with our dispatchTools. MCP tools augment rather than replace —
  // if Dagster MCP is connected, the agent can call get_run_logs natively
  // AND still uses our 6 dispatchTools for the structured triage flow.
  const mcpToolSets = await Promise.all(mcpClients.map(c => c.tools().catch(() => ({}))));
  const allMcpTools = Object.assign({}, ...mcpToolSets);
  const allTools = { ...dispatchTools, ...allMcpTools };

  const mcpLabel = mcpClients.length > 0
    ? `| MCP: ${mcpClients.length} server${mcpClients.length !== 1 ? 's' : ''}`
    : '';

  const result = streamText({
    model: getPrimaryModel(),
    system: DISPATCH_SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools: allTools,
    providerOptions: gatewayOptions,
    // 16 steps: parallel pairs (steps 2+3 simultaneously) + chain walking + report
    stopWhen: isStepCount(16),
    onStepEnd({ stepNumber, toolCalls, usage }) {
      if (toolCalls?.length) {
        // '+' between names means the model called them in parallel (one LLM step)
        console.log(
          '[dispatch] step', stepNumber,
          '|', toolCalls.map(t => t.toolName).join(' + '),
          '| tokens:', usage?.totalTokens ?? '?',
          mcpLabel,
        );
      }
    },
    // Close MCP clients AFTER the stream ends, not before.
    // allSettled — don't fail if one client fails to close.
    onEnd: async () => {
      await Promise.allSettled(mcpClients.map(c => c.close()));
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
