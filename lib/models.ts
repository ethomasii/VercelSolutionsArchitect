import { gateway } from 'ai';

// Wire AI Gateway up first — every subsequent test call accumulates real
// observability data (token costs, latency, model fallback events) in the
// Vercel dashboard before the demo. Switching providers is a string change here;
// zero changes anywhere else in the app. This is the AI SDK's core enterprise
// value prop: provider abstraction insulates application code from model routing.
//
// AI Gateway uses OIDC auth automatically on Vercel (via VERCEL_OIDC_TOKEN).
// No OPENAI_API_KEY or ANTHROPIC_API_KEY needed in production.
// For local dev: run `vercel env pull .env.local` to get a fresh OIDC token.

// openai/gpt-5.4 is the right primary for triage: fast, capable, and excellent
// at structured tool calling + log analysis. At 2am, latency matters more than
// maximum reasoning depth. We're classifying error types and searching a database.
export const PRIMARY_MODEL = 'openai/gpt-5.4';

// Fallback model via AI Gateway's built-in failover (providerOptions.gateway.models).
// If OpenAI is degraded, the gateway routes to Anthropic with zero app code change.
export const FALLBACK_MODEL = 'anthropic/claude-haiku-4.5';

// The gateway() wrapper is used here to attach providerOptions for failover and tags.
// When providerOptions aren't needed, a plain "provider/model" string also works.
export function getPrimaryModel() {
  return gateway(PRIMARY_MODEL);
}

export const gatewayOptions = {
  gateway: {
    models: ['anthropic/claude-haiku-4.5'] as string[],
    tags: ['feature:triage', 'app:dispatch'] as string[],
  },
};
