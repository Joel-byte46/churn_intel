import { supabaseAdmin } from '../_shared/clients.ts'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.27?target=deno'

const MODEL = 'claude-3-5-sonnet-20241022'
const RESEND_URL = 'https://api.resend.com/emails'
const DIGEST_THRESHOLD = 3 // Digest fondateur si > 3 jobs déployés en 24h

Deno.serve(async (req) => {
  try {
    const { job_id, user_id } = await req.json()

    if (!job_id || !user_id) {
      return json({ error: 'Missing job_id or user_id' }, 400)
    }

    // 1. Récupère le job complet
    const { data: job, error: jobError } = await supabaseAdmin
      .from('autopilot_jobs')
      .select('*')
      .eq('id', job_id)
      .eq('status', 'ready')
      .single()

    if (jobError || !job) {
      return json({ error: 'Job not found or not ready' }, 404)
    }

    // 2. Récupère le customer
    const { data: customer, error: customerError } = await supabaseAdmin
      .from('customers')
      .select('email, stripe_customer_id, invalid_email')
      .eq('id', job.customer_id)
      .single()

    if (customerError || !customer) {
      return json({ error: 'Customer not found' }, 404)
    }

    // Guard : email invalide
    if (customer.invalid_email || !customer.email) {
      await supabaseAdmin
        .from('autopilot_jobs')
        .update({ status: 'failed' })
        .eq('id', job_id)

      console.log(JSON.stringify({
        event: 'autopilot-deploy.skipped.invalid_email',
        job_id,
        customer_id: job.customer_id
      }))

      return json({ status: 'skipped', reason: 'invalid_email' }, 200)
    }

    // 3. Récupère le founder pour son email
    const { data: founder, error: founderError } = await supabaseAdmin
      .from('users')
      .select('email, first_name, product_name')
      .eq('id', user_id)
      .single()

    if (founderError || !founder) {
      return json({ error: 'Founder not found' }, 404)
    }

    const intervention = job.intervention as any
    const resendKey = Deno.env.get('RESEND_API_KEY')!

    // 4. Résout le placeholder {{first_name}}
    const customerFirstName = extractFirstName(customer.email)
    const emailBody = intervention.body
      .replace(/{{first_name}}/g, customerFirstName)

    // 5. Envoie l'email au customer
    // Avec délai si intervention.delay_hours > 0
    const delayHours = intervention.delay_hours ?? 0
    const scheduledAt = delayHours > 0
      ? new Date(Date.now() + delayHours * 3600000).toISOString()
      : null

    const sent = await sendEmail(
      resendKey,
      customer.email,
      intervention.subject,
      emailBody,
      scheduledAt
    )

    if (!sent) {
      // Marque l'email comme invalide si échec répété
      await supabaseAdmin
        .from('customers')
        .update({ invalid_email: true })
        .eq('id', job.customer_id)

      await supabaseAdmin
        .from('autopilot_jobs')
        .update({ status: 'failed' })
        .eq('id', job_id)

      console.error(JSON.stringify({
        event: 'autopilot-deploy.email.failed',
        job_id,
        customer_email: customer.email
      }))

      return json({ status: 'failed', reason: 'email_delivery' }, 500)
    }

    const now = new Date().toISOString()

    // 6. Update le job → deployed
    await supabaseAdmin
      .from('autopilot_jobs')
      .update({
        status: 'deployed',
        deployed_at: now
      })
      .eq('id', job_id)

    // 7. Update le customer
    await supabaseAdmin
      .from('customers')
      .update({
        last_intervention_at: now,
        last_intervention_type: job.action_type,
        interventions_count: (customer as any).interventions_count + 1
      })
      .eq('id', job.customer_id)

    console.log(JSON.stringify({
      event: 'autopilot-deploy.completed',
      job_id,
      action_type: job.action_type,
      customer_email: customer.email,
      delay_hours: delayHours
    }))

    // 8. Vérifie si digest founder nécessaire
    await maybeNotifyFounder(user_id, founder, resendKey, job)

    // 9. Schedule impact check J+7 via pg_cron
    // On stocke la date cible — autopilot-measure/ tourne toutes les nuits
    // et récupère les jobs deployed_at = 7 jours ago
    // Pas de cron dynamique nécessaire

    return json({ status: 'deployed', job_id }, 200)

  } catch (err) {
    console.error(JSON.stringify({
      event: 'autopilot-deploy.fatal',
      error: err.message,
      stack: err.stack
    }))
    return json({ error: 'Internal server error' }, 500)
  }
})

// --- Digest Founder ---

async function maybeNotifyFounder(
  user_id: string,
  founder: any,
  resendKey: string,
  lastJob: any
) {
  // Compte les jobs déployés dans les dernières 24h
  const { data: recentJobs, error } = await supabaseAdmin
    .from('autopilot_jobs')
    .select('id, action_type, health_score, customer_id')
    .eq('user_id', user_id)
    .eq('status', 'deployed')
    .gte('deployed_at', new Date(Date.now() - 86400000).toISOString())

  if (error || !recentJobs) return

  const jobCount = recentJobs.length
  const isCritical = lastJob.action_type === 'WIN_BACK' ||
    lastJob.health_score < 20

  // Notifie si seuil atteint ou job critique
  if (jobCount < DIGEST_THRESHOLD && !isCritical) return

  // Compte par type pour le digest
  const byType = recentJobs.reduce((acc: Record<string, number>, job: any) => {
    acc[job.action_type] = (acc[job.action_type] ?? 0) + 1
    return acc
  }, {})

  const digestBody = buildDigest(founder, byType, jobCount, isCritical)

  await sendEmail(
    resendKey,
    founder.email,
    isCritical
      ? `⚠️ Autopilot alert — ${lastJob.action_type}`
      : `Autopilot digest — ${jobCount} interventions deployed`,
    digestBody,
    null
  )

  console.log(JSON.stringify({
    event: 'founder.digest.sent',
    user_id,
    job_count: jobCount,
    is_critical: isCritical
  }))
}

function buildDigest(
  founder: any,
  byType: Record<string, number>,
  total: number,
  isCritical: boolean
): string {
  const firstName = founder.first_name ?? 'there'
  const lines = Object.entries(byType)
    .map(([type, count]) => `- ${count}x ${type}`)
    .join('\n')

  if (isCritical) {
    return `Hi ${firstName},

Autopilot just deployed a critical intervention.

${lines}

These emails went out automatically. Check /autopilot for details.

— Churn Intel`
  }

  return `Hi ${firstName},

Autopilot deployed ${total} interventions in the last 24h.

${lines}

All running while you build. Check /autopilot for results.

— Churn Intel`
}

// --- Helpers ---

function extractFirstName(email: string): string {
  // Extrait un prénom approximatif depuis l'email
  // john.doe@company.com → John
  // john@company.com → John
  const local = email.split('@')[0]
  const first = local.split(/[._-]/)[0]
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

async function sendEmail(
  apiKey: string,
  to: string,
  subject: string,
  body: string,
  scheduledAt: string | null,
  retries = 3
): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const payload: any = {
        from: 'Churn Intel Autopilot <autopilot@churnintel.com>',
        to,
        subject,
        text: body
      }

      if (scheduledAt) {
        payload.scheduled_at = scheduledAt
      }

      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      if (res.ok) return true

      const err = await res.json()
      console.error(JSON.stringify({
        event: 'resend.error',
        attempt,
        status: res.status,
        error: err
      }))

    } catch (err) {
      console.error(JSON.stringify({
        event: 'resend.fetch.failed',
        attempt,
        error: err.message
      }))
    }

    if (attempt < retries - 1) {
      await sleep(1000 * Math.pow(4, attempt))
    }
  }

  return false
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function json(data: object, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
