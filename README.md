# Dispatch — Cross-Stack Pipeline Incident Triage

**Live:** [dispatch-triage-two.vercel.app](https://dispatch-triage-two.vercel.app)

> *"Dispatch solves the problem that orchestration vendors can't: it synthesizes technical signals from your data stack with the institutional knowledge that only lives inside your team — your runbooks, your incident history, and your git context — and it runs on Vercel so one engineer can operate it reliably in production without a DevOps team."*

---

## 1. The Problem

When a data pipeline fails, on-call engineers need two layers of context:

**Layer 1 — Technical signals** (vendors partially cover this)
- Dagster run logs and asset status
- dbt job results and compilation errors
- GitHub: what changed recently in relevant files
- Upstream sync status (Fivetran, Airbyte, etc.)

**Layer 2 — Institutional knowledge** (no vendor covers this)
- Internal runbooks: "when THIS pipeline fails, check THESE things first"
- Incident history: the last N times this fired, how was it resolved?
- Git context: was there a PR merged 4 hours ago that touched this model?
- Team tribal knowledge: known flaky sources, maintenance windows, quirks

Orchestration vendors like Dagster, dbt, and Snowflake each know their own slice. No vendor touches the institutional layer: runbooks, incident history, git context. That's what Dispatch adds.

**The build vs. buy answer:** Every team's internal context is different. No vendor can index your runbooks, your incident history, or your git commits. With AI, the build cost is now near-zero — the only real question is whether you can run it reliably in production. That's what Vercel solves.

---

## 2. Why Build vs. Buy

- **Triage tools exist** (Dagster Compass, dbt Wizard) but they're siloed to their vendor
- **No vendor indexes YOUR runbooks**, YOUR incident history, or YOUR git commits
- **With AI the build cost is near-zero** — Vercel solves the "run reliably" problem
- **This is the "build and run" pattern**: the build cost is low, the operational burden is zero, and the institutional value compounds over time as your runbooks and incident history grow

---

## 3. Architecture

```
On-call Engineer
│
▼
┌─────────────────────────────┐
│         Dispatch            │  Next.js 16 on Vercel
│    (this app)               │  Fluid Compute + AI SDK v7
└──────────────┬──────────────┘
               │ streamText via AI Gateway
               ▼
┌──────────────────────────────────────────┐
│              Tool Layer                   │
│  classifyFailure  │  searchRunbooks       │
│  lookupHistory    │  searchGitContext     │
└──────┬───────────┬───────────┬───────────┘
       │           │           │
       ▼           ▼           ▼
  [Neon DB]   [GitHub]    [Future]
  runbooks    commits/    Dagster API
  incidents   PRs (sim)   Fivetran
  git_context             PagerDuty
              Confluence
              Slack (post)
              │
              ▼
        [Dagster Sensor]
        → POST /api/webhooks/dagster
        → auto-triage on failure
        → post to #data-alerts
```

---

## 4. Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| **Node runtime for `/api/chat`** | Multi-step tool calling with 4 sequential Neon queries can exceed Edge's wall clock limit. Fluid Compute gives Node runtime with zero-idle-cost serverless pricing. |
| **`openai/gpt-5.4` as primary** | Fast, capable structured tool calling. At 2am, latency > reasoning depth. We're classifying errors and searching a DB, not writing poetry. |
| **`anthropic/claude-haiku-4.5` as fallback** | AI Gateway automatic failover via `providerOptions.gateway.models`. Zero application code change when OpenAI is degraded. |
| **Neon + pgvector column** | Added `embedding vector(1536)` column at creation. Free to add now, expensive to retrofit. The upgrade path to semantic search changes only the query in `searchRunbooks` — tool interface stays the same. |
| **`org_id` on every table** | Multi-tenancy is a one-line WHERE clause addition to every query. Much easier to add at schema creation than retrofit. |
| **Streaming for perceived latency** | 4-6 seconds of tool calls feels fast when the user sees each step arrive. `toUIMessageStream` + `useChat` makes this first-class. |
| **AI Gateway OIDC auth** | `VERCEL_OIDC_TOKEN` via `vercel env pull` — no `OPENAI_API_KEY` to rotate, no credentials to leak. Short-lived tokens auto-refresh on Vercel deployments. |

---

## 5. Evaluation Approach

8 eval cases in `/app/evals` covering:

| Case | What it tests |
|------|---------------|
| Schema mismatch with smoking-gun PR | Agent must find the PR merged 4h ago that renamed a column |
| Fivetran orders — known flaky | Identify as known_flaky (8 incidents in 90 days), recommend waiting |
| dbt compilation error | Classify correctly, find runbook, suggest checking git |
| Resource exhaustion | Find runbook, explicitly NOT recommend "just retry" |
| Permission denied (quarterly rotation) | Find runbook, surface credential rotation pattern |
| First-ever failure on revenue mart | No history, no runbook — recommend escalation |
| Cascading failure | Identify upstream Fivetran as root cause, not downstream dbt tests |
| Ambiguous log | Classify as `unknown`, low confidence, no hallucination |

Run at `/evals` → "Run Evals" button.

---

## 6. Extension Roadmap

Each item is a one-file change to wire up the real integration:

| Integration | File to change | Env vars needed |
|-------------|----------------|-----------------|
| **GitHub API** | `lib/integrations/github.ts` | `GITHUB_TOKEN` |
| **Dagster webhook** | `app/api/webhooks/dagster/route.ts` | `DISPATCH_WEBHOOK_SECRET` |
| **Slack notifications** | `lib/integrations/slack.ts` | `SLACK_WEBHOOK_URL` |
| **Semantic search** | Populate `embedding` column, switch query in `lib/tools.ts` `searchRunbooks` | OpenAI embeddings API (via Gateway) |
| **Confluence runbooks** | `lib/integrations/confluence.ts` | `CONFLUENCE_BASE_URL`, `CONFLUENCE_TOKEN` |
| **Multi-tenancy** | `proxy.ts` JWT decode + tools `orgId` from header | Auth provider (Clerk recommended) |
| **Dagster GraphQL** | `lib/integrations/dagster.ts` | `DAGSTER_HOST`, `DAGSTER_TOKEN` |

---

## 7. Vercel Platform Features Used

| Feature | Usage |
|---------|-------|
| **Fluid Compute** | Node runtime with serverless cost model. Zero idle cost, handles concurrent triage requests during incidents, ~300s max duration for complex evals. |
| **AI Gateway** | OIDC auth (no API key management), provider failover from OpenAI → Anthropic, token cost tracking with `feature:triage` tag, latency observability. Accumulates real traces from first request. |
| **Streaming (AI SDK v7)** | `streamText` + `toUIMessageStream` + `useChat` — each tool step appears in the UI before the final report, making 4-6 seconds feel fast and transparent. |
| **Routing Middleware (proxy.ts)** | Injects `x-dispatch-org-id` header on all `/api/*` requests. Multi-tenant upgrade path: decode JWT in one place, zero changes to tools or routes. |
| **Next.js App Router** | Server Components for landing/evals pages, Client Component for triage chat, Route Handlers for API. |

---

## 8. Local Development

```bash
# From dispatch/ directory
vercel link --scope ethomasiis-projects
vercel env pull .env.local      # Gets VERCEL_OIDC_TOKEN for AI Gateway
npm install
npm run dev
```

Seed the database (first time):
```bash
npx tsx scripts/seed.ts
```

---

## 9. Pre-Interview Checklist

- [ ] AI Gateway dashboard shows traces from test runs
- [ ] All 3 landing page chips produce a complete triage report
- [ ] Tool steps (⚡📚🔍🔀) visible during streaming
- [ ] `/evals` shows 8 cases with pass/fail after "Run Evals"
- [ ] Fallback model tested (set `AI_GATEWAY_API_KEY` to an invalid key temporarily)
- [ ] README explains the two-layer problem clearly
- [ ] Can explain every architectural decision from memory
- [ ] Webhook stub responds 200 to: `curl -X POST https://dispatch-triage-two.vercel.app/api/webhooks/dagster -H "Authorization: Bearer dispatch-wh-XXXXX" -d '{"runId":"test","pipelineName":"test"}'`
- [ ] `/lib/integrations/` has 4 stub files with clear TODO comments
