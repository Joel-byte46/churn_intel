import { supabaseAdmin } from '../_shared/clients.ts'
import Stripe from 'https://esm.sh/stripe@14?target=deno'

const LOOKBACK_DAYS = 90

Deno.serve(async (req) => {
  try {
    const { user_id } = await req.json()

    if (!user_id) {
      return json({ error: 'Missing user_id' }, 400)
    }

    // 1. Récupère la Stripe Restricted Key depuis Vault
    const { data: stripe_key, error: keyError } = await supabaseAdmin
      .rpc('get_stripe_key', { p_user_id: user_id })

    if (keyError || !stripe_key) {
      return json({ error: 'Stripe key not configured' }, 400)
    }

    const stripe = new Stripe(stripe_key, {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient()
    })

    const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400

    // 2. Pull les subscriptions annulées (90 jours) + actives en parallèle
    const [churned, active] = await Promise.all([
      pullChurned(stripe, since),
      pullActive(stripe)
    ])

    // 3. Calcule le MRR total
    const totalMrr = active.reduce((sum, s) => {
      return sum + normalizeToMonthly(s.items.data[0]?.price)
    }, 0)

    // 4. Normalise les customers churned
    const churnedCustomers = churned.map((s) => ({
      stripe_customer_id: s.customer as string,
      canceled_at: s.canceled_at,
      created_at: s.created,
      plan_name: s.items.data[0]?.price?.nickname ?? 'unknown',
      mrr: normalizeToMonthly(s.items.data[0]?.price),
      cancel_reason: s.cancellation_details?.reason ?? null,
      cancel_comment: s.cancellation_details?.comment ?? null
    }))

    // 5. Upsert les customers actifs
    if (active.length > 0) {
      const customersToUpsert = active.map((s) => ({
        user_id,
        stripe_customer_id: s.customer as string,
        mrr: normalizeToMonthly(s.items.data[0]?.price),
        plan_name: s.items.data[0]?.price?.nickname ?? 'unknown',
        tenure_days: Math.floor((Date.now() / 1000 - s.created) / 86400),
        updated_at: new Date().toISOString()
      }))

      const { error: upsertError } = await supabaseAdmin
        .from('customers')
        .upsert(customersToUpsert, {
          onConflict: 'user_id,stripe_customer_id'
        })

      if (upsertError) {
        console.error(JSON.stringify({
          event: 'customers.upsert.failed',
          user_id,
          error: upsertError.message
        }))
      }
    }

    // 6. Crée l'analyse avec status pending
    const { data: analysis, error: analysisError } = await supabaseAdmin
      .from('churn_analyses')
      .insert({
        user_id,
        churned_customers: churnedCustomers,
        active_customers: active.length,
        total_mrr: totalMrr,
        status: 'pending'
      })
      .select('id')
      .single()

    if (analysisError || !analysis) {
      return json({ error: 'Failed to create analysis' }, 500)
    }

    console.log(JSON.stringify({
      event: 'connect.completed',
      user_id,
      analysis_id: analysis.id,
      churned_count: churnedCustomers.length,
      active_count: active.length,
      total_mrr: totalMrr
    }))

    // 7. Déclenche analyze/ — fire and forget
    supabaseAdmin.functions.invoke('analyze', {
      body: { user_id, analysis_id: analysis.id }
    }).catch((err) => {
      console.error(JSON.stringify({
        event: 'analyze.invoke.failed',
        user_id,
        analysis_id: analysis.id,
        error: err.message
      }))
    })

    return json({
      status: 'analysis_started',
      analysis_id: analysis.id
    }, 200)

  } catch (err) {
    console.error(JSON.stringify({
      event: 'connect.fatal',
      error: err.message,
      stack: err.stack
    }))
    return json({ error: 'Internal server error' }, 500)
  }
})

// --- Helpers ---

async function pullChurned(stripe: Stripe, since: number) {
  const results = []
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const page = await stripe.subscriptions.list({
      status: 'canceled',
      created: { gte: since },
      limit: 100,
      expand: ['data.items.data.price'],
      ...(startingAfter ? { starting_after: startingAfter } : {})
    })

    results.push(...page.data)
    hasMore = page.has_more
    if (page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id
    }
  }

  return results
}

async function pullActive(stripe: Stripe) {
  const results = []
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const page = await stripe.subscriptions.list({
      status: 'active',
      limit: 100,
      expand: ['data.items.data.price'],
      ...(startingAfter ? { starting_after: startingAfter } : {})
    })

    results.push(...page.data)
    hasMore = page.has_more
    if (page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id
    }
  }

  return results
}

function normalizeToMonthly(price: any): number {
  if (!price || !price.unit_amount) return 0
  const amount = price.unit_amount / 100

  switch (price.recurring?.interval) {
    case 'year':  return Math.round((amount / 12) * 100) / 100
    case 'week':  return Math.round((amount * 4.33) * 100) / 100
    case 'day':   return Math.round((amount * 30) * 100) / 100
    case 'month':
    default:      return amount
  }
}

function json(data: object, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
        }
