import { supabaseAdmin } from '../_shared/clients.ts'
import Stripe from 'https://esm.sh/stripe@14?target=deno'

// Tourne toutes les nuits à 3h UTC
// Mesure l'impact des interventions déployées il y a 7 jours

Deno.serve(async (req) => {
  try {
    // Fenêtre J+7 : jobs déployés entre hier 3h et aujourd'hui 3h
    // (le cron tourne à 3h — on prend les jobs de la veille)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000)
    const eightDaysAgo = new Date(Date.now() - 8 * 86400000)

    // 1. Récupère tous les jobs à mesurer
    const { data: jobs, error: jobsError } = await supabaseAdmin
      .from('autopilot_jobs')
      .select(`
        *,
        customers (
          stripe_customer_id,
          user_id,
          mrr,
          health_score
        )
      `)
      .eq('status', 'deployed')
      .gte('deployed_at', eightDaysAgo.toISOString())
      .lte('deployed_at', sevenDaysAgo.toISOString())

    if (jobsError) {
      console.error(JSON.stringify({
        event: 'autopilot-measure.fetch.failed',
        error: jobsError.message
      }))
      return json({ error: 'Failed to fetch jobs' }, 500)
    }

    if (!jobs || jobs.length === 0) {
      console.log(JSON.stringify({
        event: 'autopilot-measure.no_jobs',
        window: { from: eightDaysAgo, to: sevenDaysAgo }
      }))
      return json({ status: 'no_jobs_to_measure' }, 200)
    }

    console.log(JSON.stringify({
      event: 'autopilot-measure.started',
      jobs_count: jobs.length
    }))

    // 2. Groupe par user pour minimiser les appels Stripe
    const byUser = groupByUser(jobs)

    let totalMeasured = 0
    let totalMrrProtected = 0

    for (const [user_id, userJobs] of Object.entries(byUser)) {
      try {
        const mrrProtected = await measureUserJobs(user_id, userJobs as any[])
        totalMrrProtected += mrrProtected
        totalMeasured += (userJobs as any[]).length
      } catch (err) {
        console.error(JSON.stringify({
          event: 'autopilot-measure.user.failed',
          user_id,
          error: err.message
        }))
      }
    }

    console.log(JSON.stringify({
      event: 'autopilot-measure.completed',
      jobs_measured: totalMeasured,
      total_mrr_protected: totalMrrProtected
    }))

    return json({
      status: 'measured',
      jobs_measured: totalMeasured,
      mrr_protected: totalMrrProtected
    }, 200)

  } catch (err) {
    console.error(JSON.stringify({
      event: 'autopilot-measure.fatal',
      error: err.message,
      stack: err.stack
    }))
    return json({ error: 'Internal server error' }, 500)
  }
})

// --- Mesure par user ---

async function measureUserJobs(
  user_id: string,
  jobs: any[]
): Promise<number> {
  // Récupère le token Stripe du founder
  const { data: user, error: userError } = await supabaseAdmin
    .from('users')
    .select('stripe_access_token')
    .eq('id', user_id)
    .single()

  if (userError || !user?.stripe_access_token) {
    console.error(JSON.stringify({
      event: 'autopilot-measure.stripe_token.missing',
      user_id
    }))
    return 0
  }

  const stripe = new Stripe(user.stripe_access_token, {
    apiVersion: '2023-10-16',
    httpClient: Stripe.createFetchHttpClient()
  })

  let userMrrProtected = 0

  for (const job of jobs) {
    try {
      const impact = await measureJob(stripe, job)
      userMrrProtected += impact.mrr_impact

      // Update le job avec l'impact mesuré
      await supabaseAdmin
        .from('autopilot_jobs')
        .update({
          impact,
          mrr_impact: impact.mrr_impact,
          status: 'measured'
        })
        .eq('id', job.id)

      console.log(JSON.stringify({
        event: 'autopilot-measure.job.measured',
        job_id: job.id,
        action_type: job.action_type,
        still_active: impact.still_active,
        mrr_impact: impact.mrr_impact
      }))

    } catch (err) {
      console.error(JSON.stringify({
        event: 'autopilot-measure.job.failed',
        job_id: job.id,
        error: err.message
      }))
    }
  }

  // Update cumulative_mrr_protected du founder
  if (userMrrProtected > 0) {
    await supabaseAdmin.rpc('increment_mrr_protected', {
      p_user_id: user_id,
      p_amount: userMrrProtected
    })
  }

  return userMrrProtected
}

async function measureJob(stripe: Stripe, job: any): Promise<any> {
  const customer = job.customers
  if (!customer?.stripe_customer_id) {
    return buildImpact(false, false, false, 0)
  }

  // Récupère l'état actuel de la subscription dans Stripe
  const subscriptions = await stripe.subscriptions.list({
    customer: customer.stripe_customer_id,
    limit: 5
  })

  const activeSubscription = subscriptions.data.find(
    s => s.status === 'active' || s.status === 'trialing'
  )

  const stillActive = !!activeSubscription
  const mrr = customer.mrr ?? 0

  // Détermine le type d'impact selon l'action
  let mrrImpact = 0
  let churnPrevented = false
  let reactivated = false
  let upgraded = false

  if (job.action_type === 'WIN_BACK') {
    // WIN_BACK : le customer était parti, est-il revenu ?
    reactivated = stillActive
    mrrImpact = reactivated ? mrr : 0

  } else if (job.action_type === 'CHURN_RISK' || job.action_type === 'ACTIVATION_FAILURE') {
    // Churn prevention : le customer est-il encore là ?
    churnPrevented = stillActive
    // Impact = MRR sauvé (on attribue 50% à l'intervention — prudent)
    mrrImpact = churnPrevented ? mrr * 0.5 : 0

  } else if (job.action_type === 'EXPANSION_SIGNAL') {
    // Expansion : le customer a-t-il upgradé ?
    if (activeSubscription) {
      const currentMrr = activeSubscription.items.data[0]?.price?.unit_amount
        ? activeSubscription.items.data[0].price.unit_amount / 100
        : mrr
      upgraded = currentMrr > mrr
      mrrImpact = upgraded ? currentMrr - mrr : 0
    }
  }

  return buildImpact(stillActive, churnPrevented, reactivated, upgraded, mrrImpact)
}

// --- Helpers ---

function buildImpact(
  still_active: boolean,
  churn_prevented: boolean = false,
  reactivated: boolean = false,
  upgraded: boolean | number = false,
  mrr_impact: number = 0
): any {
  return {
    still_active,
    churn_prevented,
    reactivated,
    upgraded: !!upgraded,
    mrr_impact: Math.round(mrr_impact * 100) / 100,
    measured_at: new Date().toISOString()
  }
}

function groupByUser(jobs: any[]): Record<string, any[]> {
  return jobs.reduce((acc, job) => {
    const userId = job.customers?.user_id ?? job.user_id
    if (!acc[userId]) acc[userId] = []
    acc[userId].push(job)
    return acc
  }, {})
}

function json(data: object, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
        }
