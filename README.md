
# Revenue OS — Churn Intel (Backend)

Churn Intel is the core engine of Revenue OS V1.

It connects to a SaaS founder’s Stripe account, diagnoses churn automatically using Claude (BYOK), benchmarks performance against peers, and runs an autopilot intervention system — fully serverless.

No dashboards.  
No configuration.  
One system.

---

# Architecture

Serverless stack:

- **Supabase**
  - PostgreSQL
  - Row Level Security (RLS)
  - Edge Functions (Deno)
  - pg_cron
  - Vault (secret storage)

- **Stripe Connect**
  - SaaS financial data source
  - Subscription lifecycle events

- **Anthropic Claude (BYOK)**
  - Each founder uses their own API key
  - Zero LLM cost for Revenue OS

- **Resend**
  - Email delivery (founder + customer)

---

# System Overview

```
Stripe → Supabase → Claude → Email → Impact Measurement → Feedback Loop
```

Core services:

- `connect/` → Pull Stripe data
- `analyze/` → Detect churn pattern
- `report/` → Send diagnostic
- `benchmark-*` → Position vs peers
- `autopilot-*` → Detect, intervene, measure impact

---

# Local Development

## 1️⃣ Install Dependencies

### Supabase CLI

```bash
brew install supabase/tap/supabase
```

### Deno

```bash
curl -fsSL https://deno.land/install.sh | sh
```

---

## 2️⃣ Start Supabase locally

```bash
supabase start
```

---

## 3️⃣ Run Edge Functions locally

```bash
cd supabase/functions
deno task dev
```

---

# Environment Variables

Create `.env.local` (never commit this file):

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

RESEND_API_KEY=

STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_CLIENT_ID=
```

---

# Deployment

## 1️⃣ Link Supabase project

```bash
supabase link --project-ref YOUR_PROJECT_REF
```

## 2️⃣ Push migrations

```bash
supabase db push
```

## 3️⃣ Deploy Edge Functions

```bash
supabase functions deploy
```

---

# GitHub CI Deploy

Workflow included:

```
.github/workflows/deploy.yml
```

Required secrets:

```
SUPABASE_ACCESS_TOKEN
SUPABASE_PROJECT_REF
```

---

# Cron Jobs Required

Configured in `supabase/config.toml`:

- Hourly: `autopilot-detect`
- Weekly: `weekly-digest`
- Daily: `autopilot-measure`

---

# Stripe Setup

## Enable:

- Stripe Connect OAuth
- Webhooks:
  - `customer.subscription.deleted`
  - `invoice.payment_failed`

Webhook endpoint:

```
https://PROJECT_REF.functions.supabase.co/autopilot-detect
```

---

# Anthropic BYOK

Each founder:

1. Enters their own API key
2. Key stored in Supabase Vault (AES-256)
3. All Claude calls use tenant key
4. Revenue OS has zero LLM liability

---

# Model Selection

Model resolution is centralized in:

```
_shared/config.ts
```

System default:

```
ANALYSIS → Sonnet
NARRATIVE → Sonnet
FAST → Sonnet
```

Founder may override via `preferred_model`.

---

# Security Model

- RLS enabled on all user tables
- Service role key only in Edge
- Vault for secrets
- No secrets client-side
- JSON validation on LLM output
- Retry logic + exponential backoff
- Fallback templates on failure

---

# Scaling Strategy

## Up to 10,000 tenants

- Batch processing
- No queue required
- No Redis
- No vector DB
- Pure PostgreSQL

## Beyond 10,000 tenants

Add:

- Upstash queue
- Response caching
- Read replicas
- LLM result deduplication

---

# Monitoring

All functions emit structured JSON logs:

```
{
  event,
  user_id,
  job_id,
  model,
  error,
  timestamp
}
```

Recommended:

- Logflare
- Datadog
- Grafana

---

# Production Hardening Checklist

- [x] Lockfile (`deno.lock`)
- [x] Model centralization
- [x] JSON schema validation
- [x] Retry logic
- [x] Vault encryption
- [x] RLS policies
- [x] CI deployment
- [x] Rate limiting ready

---

# Health Philosophy

This backend is:

- Deterministic
- Stateless
- Tenant-isolated
- Cost-controlled
- Horizontally scalable

Minimal components.  
Maximum leverage.

---

# License

Private. Internal use only.

---

Revenue OS V1 — Churn Intel.
