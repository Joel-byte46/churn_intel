import { supabaseAdmin } from '../_shared/clients.ts'

const BATCH_SIZE = 50
const COOLDOWN_DAYS = 7

// Seuils de déclenchement
const THRESHOLDS = {
  CHURN_RISK:         40,  // health score < 40
  ACTIVATION_FAILURE: 60,  // health score < 60 + tenure < 14 jours
  EXPANSION_SIGNAL:   85,  // health score > 85 + tenure > 90 jours
  WIN_BACK:           null // déclenché par webhook Stripe uniquement
}

// Poids du health score
const WEIGHTS = {
  days_since_login:      0.35,
  feature_adoption_rate: 0.25,
  plan_usage_pct:        0.20,
  tenure_days:           0.10,
  payment_status:        0.10
}

Deno.serve(async (req) => {
  try {
    // Deux modes d'entrée :
    // 1. Cron horaire → pas de body → traite tous les users actifs
    // 2. Stripe webhook → body { user_id, customer_stripe_id, action_type: 'WIN_BACK' }
    const body = await req.json().catch(() => ({}))
    const isWebhook = !!body.customer_stripe_id

    if (isWebhook) {
      await handleWebhook(body)
      return json({ status: 'webhook_processed' }, 200)
    }

    // Cron path — traite tous les users avec autopilot actif
    const { data: users, error: usersError } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('autopilot_active', true)

    if (usersError) {
      console.error(JSON.stringify({
        event: 'autopilot-detect.users.fetch.failed',
        error: usersError.message
      }))
      return json({ error: 'Failed to fetch users' }, 500)
    }

    if (!users || users.length === 0) {
      return json({ status: 'no_active_users' }, 200)
    }

    console.log(JSON.stringify({
      event: 'autopilot-detect.started',
      user_count: users.length
    }))

    // Batch processing — 50 users par batch
    const batches = chunk(users, BATCH_SIZE)
    let totalJobs = 0

    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(user => processUser(user.id))
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          totalJobs += result.value
        } else {
          console.error(JSON.stringify({
            event: 'autopilot-detect.user.failed',
            error: result.reason?.message
          }))
        }
      }
    }

    console.log(JSON.stringify({
      event: 'autopilot-detect.completed',
      users_processed: users.length,
      jobs_created: totalJobs
    }))

    return json({ status: 'completed', jobs_created: totalJobs }, 200)

  } catch (err) {
    console.error(JSON.stringify({
      event: 'autopilot-detect.fatal',
      error: err.message,
      stack: err.stack
    }))
    return json({ error: 'Internal server error' }, 500)
  }
})

// --- Core : traite un user ---

async function processUser(user_id: string): Promise<number> {
  // Récupère tous les customers actifs du user
  const { data: customers, error } = await supabaseAdmin
    .from('customers')
    .select('*')
    .eq('user_id', user_id)
    .eq('invalid_email', false)

  if (error || !customers || customers.length === 0) return 0

  let jobsCreated = 0

  for (const customer of customers) {
    const job = await evaluateCustomer(user_id, customer)
    if (job) jobsCreated++
  }

  return jobsCreated
}

async function evaluateCustomer(
  user_id: string,
  customer: any
): Promise<boolean> {
  // 1. Calcule le health score
  const score = computeHealthScore(customer)

  // 2. Update le health score dans la DB
  await supabaseAdmin
    .from('customers')
    .update({
      health_score: score,
      updated_at: new Date().toISOString()
    })
    .eq('id', customer.id)

  // 3. Vérifie le cooldown
  if (customer.last_intervention_at) {
    const lastIntervention = new Date(customer.last_intervention_at)
    const daysSince = (Date.now() - lastIntervention.getTime()) / 86400000
    if (daysSince < COOLDOWN_DAYS) return false
  }

  // 4. Détermine l'action type
  const actionType = determineActionType(score, customer)
  if (!actionType) return false

  // 5. Vérifie qu'un job identique n'est pas déjà en cours
  const { data: existingJob } = await supabaseAdmin
    .from('autopilot_jobs')
    .select('id')
    .eq('customer_id', customer.id)
    .eq('action_type', actionType)
    .in('status', ['pending', 'ready'])
    .limit(1)
    .single()

  if (existingJob) return false

  // 6. Crée le job
  const { error: insertError } = await supabaseAdmin
    .from('autopilot_jobs')
    .insert({
      user_id,
      customer_id: customer.id,
      action_type: actionType,
      health_score: score,
      trigger_data: {
        days_since_login:      customer.days_since_login,
        feature_adoption_rate: customer.feature_adoption_rate,
        plan_usage_pct:        customer.plan_usage_pct,
        tenure_days:           customer.tenure_days
      },
      status: 'pending'
    })

  if (insertError) {
    console.error(JSON.stringify({
      event: 'autopilot_job.insert.failed',
      user_id,
      customer_id: customer.id,
      error: insertError.message
    }))
    return false
  }

  console.log(JSON.stringify({
    event: 'autopilot_job.created',
    user_id,
    customer_id: customer.id,
    action_type: actionType,
    health_score: score
  }))

  // 7. Déclenche autopilot-intervene/ pour ce job
  // Fire and forget
  supabaseAdmin.functions.invoke('autopilot-intervene', {
    body: { user_id, customer_id: customer.id, action_type: actionType }
  }).catch((err) => {
    console.error(JSON.stringify({
      event: 'autopilot-intervene.invoke.failed',
      customer_id: customer.id,
      error: err.message
    }))
  })

  return true
}

// --- Webhook Stripe (cancellation) ---

async function handleWebhook(body: any) {
  const { user_id, customer_stripe_id } = body

  // Récupère le customer dans notre DB
  const { data: customer, error } = await supabaseAdmin
    .from('customers')
    .select('*')
    .eq('user_id', user_id)
    .eq('stripe_customer_id', customer_stripe_id)
    .single()

  if (error || !customer) {
    console.error(JSON.stringify({
      event: 'webhook.customer.not_found',
      customer_stripe_id
    }))
    return
  }

  // Crée un job WIN_BACK immédiat — bypass cooldown
  const { error: insertError } = await supabaseAdmin
    .from('autopilot_jobs')
    .insert({
      user_id,
      customer_id: customer.id,
      action_type: 'WIN_BACK',
      health_score: 0,
      trigger_data: { source: 'stripe_webhook', event: 'subscription.canceled' },
      status: 'pending'
    })

  if (!insertError) {
    // P0 — intervene immédiatement
    supabaseAdmin.functions.invoke('autopilot-intervene', {
      body: { user_id, customer_id: customer.id, action_type: 'WIN_BACK' }
    }).catch(() => {})
  }
}

// --- Health Score ---

function computeHealthScore(customer: any): number {
  // Normalise chaque signal entre 0 et 1
  // 1 = parfait, 0 = critique

  // Jours depuis dernier login
  // 0 jours = 1.0, 30+ jours = 0.0
  const loginScore = Math.max(0, 1 - (customer.days_since_login ?? 30) / 30)

  // Feature adoption (déjà entre 0 et 1)
  const adoptionScore = Math.min(1, customer.feature_adoption_rate ?? 0)

  // Plan usage (0-100 → 0-1)
  const usageScore = Math.min(1, (customer.plan_usage_pct ?? 0) / 100)

  // Tenure (0 jours = 0.0, 180+ jours = 1.0)
  const tenureScore = Math.min(1, (customer.tenure_days ?? 0) / 180)

  // Payment status
  const paymentScore = customer.payment_status === 'failed' ? 0 : 1

  // Score pondéré (0-100)
  const raw =
    loginScore    * WEIGHTS.days_since_login      +
    adoptionScore * WEIGHTS.feature_adoption_rate +
    usageScore    * WEIGHTS.plan_usage_pct        +
    tenureScore   * WEIGHTS.tenure_days           +
    paymentScore  * WEIGHTS.payment_status

  return Math.round(raw * 100 * 100) / 100
}

function determineActionType(
  score: number,
  customer: any
): string | null {
  // CHURN_RISK : score critique
  if (score < THRESHOLDS.CHURN_RISK) {
    return 'CHURN_RISK'
  }

  // ACTIVATION_FAILURE : nouveaux customers qui n'activent pas
  if (
    score < THRESHOLDS.ACTIVATION_FAILURE &&
    (customer.tenure_days ?? 0) < 14 &&
    (customer.feature_adoption_rate ?? 0) < 0.2
  ) {
    return 'ACTIVATION_FAILURE'
  }

  // EXPANSION_SIGNAL : customers sains et anciens
  if (
    score > THRESHOLDS.EXPANSION_SIGNAL &&
    (customer.tenure_days ?? 0) > 90 &&
    (customer.plan_usage_pct ?? 0) > 80
  ) {
    return 'EXPANSION_SIGNAL'
  }

  return null
}

// --- Utils ---

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

function json(data: object, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
