import { supabaseAdmin } from '../_shared/clients.ts'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.27?target=deno'

const MODEL = 'claude-3-5-sonnet-20241022'

// Templates de fallback par action type
const FALLBACK_INTERVENTIONS: Record<string, any> = {
  CHURN_RISK: {
    subject: 'Quick question about your experience',
    body: `Hi {{first_name}},

I noticed you haven't been using {{product_name}} much lately.

Is there something specific that's not working for you? I'd love to help or get your feedback directly.

Reply to this email — I read every response.`,
    delay_hours: 0
  },
  ACTIVATION_FAILURE: {
    subject: 'Getting started with {{product_name}}',
    body: `Hi {{first_name}},

You signed up for {{product_name}} but haven't had a chance to explore it yet.

The one thing that makes the biggest difference: [core feature]. Takes 5 minutes to set up.

Want me to walk you through it?`,
    delay_hours: 2
  },
  EXPANSION_SIGNAL: {
    subject: 'You\'ve outgrown your current plan',
    body: `Hi {{first_name}},

You've been using {{product_name}} consistently for a while now — and you're hitting the limits of your current plan.

Customers like you typically unlock [X] by upgrading. Worth a conversation?`,
    delay_hours: 24
  },
  WIN_BACK: {
    subject: 'Before you go — one question',
    body: `Hi {{first_name}},

I saw you canceled your {{product_name}} subscription.

One question: what would have made you stay?

No sales pitch. Genuine question. Your answer directly shapes what we build next.`,
    delay_hours: 0
  },
  REFERRAL_MOMENT: {
    subject: 'One ask from a happy customer',
    body: `Hi {{first_name}},

You've been getting real value from {{product_name}} — I can see it in your usage.

If you know one founder who has the same problem you had, I'd love an introduction.

No pressure. Just one name if someone comes to mind.`,
    delay_hours: 48
  }
}

Deno.serve(async (req) => {
  try {
    const { user_id, customer_id, action_type } = await req.json()

    if (!user_id || !customer_id || !action_type) {
      return json({ error: 'Missing user_id, customer_id or action_type' }, 400)
    }

    // 1. Récupère le job pending pour ce customer + action_type
    const { data: job, error: jobError } = await supabaseAdmin
      .from('autopilot_jobs')
      .select('*')
      .eq('customer_id', customer_id)
      .eq('action_type', action_type)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (jobError || !job) {
      return json({ error: 'Job not found' }, 404)
    }

    // 2. Récupère le customer
    const { data: customer, error: customerError } = await supabaseAdmin
      .from('customers')
      .select('*')
      .eq('id', customer_id)
      .single()

    if (customerError || !customer) {
      return json({ error: 'Customer not found' }, 404)
    }

    // 3. Récupère le contexte produit du founder
    const { data: founder, error: founderError } = await supabaseAdmin
      .from('users')
      .select('product_name, first_name')
      .eq('id', user_id)
      .single()

    if (founderError || !founder) {
      return json({ error: 'Founder not found' }, 404)
    }

    // 4. Récupère la clé Anthropic
    const { data: anthropic_key } = await supabaseAdmin
      .rpc('get_anthropic_key', { p_user_id: user_id })

    // 5. Génère l'intervention
    let intervention: any

    if (anthropic_key) {
      const anthropic = new Anthropic({ apiKey: anthropic_key })
      intervention = await generateIntervention(
        anthropic,
        action_type,
        customer,
        founder,
        job.trigger_data
      )
    } else {
      intervention = buildFallbackIntervention(action_type, customer, founder)
    }

    // 6. Update le job → ready
    const { error: updateError } = await supabaseAdmin
      .from('autopilot_jobs')
      .update({
        intervention,
        status: 'ready'
      })
      .eq('id', job.id)

    if (updateError) {
      console.error(JSON.stringify({
        event: 'autopilot_job.update.failed',
        job_id: job.id,
        error: updateError.message
      }))
      return json({ error: 'Failed to update job' }, 500)
    }

    console.log(JSON.stringify({
      event: 'autopilot-intervene.completed',
      job_id: job.id,
      action_type,
      customer_id,
      used_claude: !!anthropic_key
    }))

    // 7. Déclenche autopilot-deploy/ — fire and forget
    supabaseAdmin.functions.invoke('autopilot-deploy', {
      body: { job_id: job.id, user_id }
    }).catch((err) => {
      console.error(JSON.stringify({
        event: 'autopilot-deploy.invoke.failed',
        job_id: job.id,
        error: err.message
      }))
    })

    return json({ status: 'ready', job_id: job.id }, 200)

  } catch (err) {
    console.error(JSON.stringify({
      event: 'autopilot-intervene.fatal',
      error: err.message,
      stack: err.stack
    }))
    return json({ error: 'Internal server error' }, 500)
  }
})

// --- Génération intervention ---

async function generateIntervention(
  anthropic: Anthropic,
  action_type: string,
  customer: any,
  founder: any,
  trigger_data: any
): Promise<any> {
  const prompt = buildInterventionPrompt(action_type, customer, founder, trigger_data)

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    })

    const text = response.content[0].type === 'text'
      ? response.content[0].text
      : ''

    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON in response')

    const parsed = JSON.parse(match[0])

    // Valide les champs requis
    if (!parsed.subject || !parsed.body) {
      throw new Error('Missing required fields in intervention')
    }

    return parsed

  } catch (err) {
    console.error(JSON.stringify({
      event: 'claude.intervention.failed',
      action_type,
      error: err.message
    }))
    return buildFallbackIntervention(action_type, customer, founder)
  }
}

function buildInterventionPrompt(
  action_type: string,
  customer: any,
  founder: any,
  trigger_data: any
): string {
  const context = {
    customer_email: customer.email,
    product_name: founder.product_name ?? 'the product',
    founder_name: founder.first_name ?? 'the founder',
    tenure_days: customer.tenure_days ?? 0,
    days_since_login: customer.days_since_login ?? 0,
    feature_adoption: Math.round((customer.feature_adoption_rate ?? 0) * 100),
    plan_usage: Math.round(customer.plan_usage_pct ?? 0),
    health_score: customer.health_score ?? 0,
    plan_name: customer.plan_name ?? 'unknown'
  }

  const intentByType: Record<string, string> = {
    CHURN_RISK: `This customer is at high risk of churning.
Health score: ${context.health_score}/100.
Days since last login: ${context.days_since_login}.
Feature adoption: ${context.feature_adoption}%.
Write a personal, genuine email to re-engage them. No promotions. Ask one question.`,

    ACTIVATION_FAILURE: `This customer signed up ${context.tenure_days} days ago but isn't activated.
Feature adoption: ${context.feature_adoption}%.
Plan usage: ${context.plan_usage}%.
Write a helpful email that removes one specific friction. Offer concrete help.`,

    EXPANSION_SIGNAL: `This customer is healthy and hitting plan limits.
Tenure: ${context.tenure_days} days. Plan usage: ${context.plan_usage}%.
Feature adoption: ${context.feature_adoption}%.
Write a natural upgrade suggestion. No hard sell. Frame it as unlocking more value.`,

    WIN_BACK: `This customer just canceled their subscription.
Write a genuine win-back email. One question: why did they leave?
No discounts. No desperation. Authentic curiosity only.`,

    REFERRAL_MOMENT: `This customer is highly engaged and has been a customer for ${context.tenure_days} days.
Write a referral ask. Personal, not transactional. One clear ask.`
  }

  return `You are writing an automated but personal email from ${context.founder_name} to a customer of ${context.product_name}.

SITUATION: ${intentByType[action_type] ?? intentByType.CHURN_RISK}

RULES:
- Sound like a human founder, not a marketing tool
- Maximum 100 words for the body
- One clear call to action or question
- Plain text only
- Use {{first_name}} as placeholder for customer name

Return ONLY valid JSON:
{
  "subject": "email subject (max 50 chars)",
  "body": "email body with {{first_name}} placeholder",
  "delay_hours": number (0 = send now, 24 = send tomorrow)
}`
}

function buildFallbackIntervention(
  action_type: string,
  customer: any,
  founder: any
): any {
  const template = FALLBACK_INTERVENTIONS[action_type] ?? FALLBACK_INTERVENTIONS.CHURN_RISK
  const productName = founder.product_name ?? 'the product'

  return {
    subject: template.subject.replace('{{product_name}}', productName),
    body: template.body
      .replace(/{{product_name}}/g, productName)
      .replace(/{{first_name}}/g, '{{first_name}}'), // gardé pour deploy
    delay_hours: template.delay_hours
  }
}

function json(data: object, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
