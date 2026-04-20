
import { supabaseAdmin } from '../_shared/clients.ts'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.27?target=deno'
import { resolveModel } from '../_shared/config.ts'

const RESEND_URL = 'https://api.resend.com/emails'

Deno.serve(async (req) => {
  try {
    const { user_id, analysis_id } = await req.json()

    if (!user_id || !analysis_id) {
      return json({ error: 'Missing user_id or analysis_id' }, 400)
    }

    // 1. Récupère l'analyse + le user en parallèle
    const [analysisResult, userResult] = await Promise.all([
      supabaseAdmin
        .from('churn_analyses')
        .select('*')
        .eq('id', analysis_id)
        .single(),
      supabaseAdmin
        .from('users')
        .select('email, first_name, product_name, preferred_model')
        .eq('id', user_id)
        .single()
    ])

    if (analysisResult.error || !analysisResult.data) {
      return json({ error: 'Analysis not found' }, 404)
    }

    if (userResult.error || !userResult.data) {
      return json({ error: 'User not found' }, 404)
    }

    const analysis = analysisResult.data
    const user = userResult.data
    const model = resolveModel('NARRATIVE', user.preferred_model)

    // 2. Récupère la clé Anthropic
    const { data: anthropic_key } = await supabaseAdmin
      .rpc('get_anthropic_key', { p_user_id: user_id })

    // 3. Génère l'email — Claude ou fallback
    let emailBody: string
    let subject: string

    if (anthropic_key) {
      const anthropic = new Anthropic({ apiKey: anthropic_key })
      const generated = await generateEmail(anthropic, model, user, analysis)
      emailBody = generated.body
      subject = generated.subject
    } else {
      const fallback = buildFallbackEmail(user, analysis)
      emailBody = fallback.body
      subject = fallback.subject
    }

    // 4. Envoie via Resend
    const resendKey = Deno.env.get('RESEND_API_KEY')!
    const sent = await sendEmail(resendKey, user.email, subject, emailBody)

    if (!sent) {
      console.error(JSON.stringify({
        event: 'report.email.failed',
        user_id,
        analysis_id
      }))
    }

    // 5. Update email_sent_at
    await supabaseAdmin
      .from('churn_analyses')
      .update({ email_sent_at: new Date().toISOString() })
      .eq('id', analysis_id)

    console.log(JSON.stringify({
      event: 'report.sent',
      user_id,
      analysis_id,
      model,
      to: user.email
    }))

    // 6. Déclenche benchmark-measure/ — fire and forget
    supabaseAdmin.functions.invoke('benchmark-measure', {
      body: { user_id, analysis_id }
    }).catch((err) => {
      console.error(JSON.stringify({
        event: 'benchmark-measure.invoke.failed',
        user_id,
        error: err.message
      }))
    })

    return json({ status: 'sent' }, 200)

  } catch (err) {
    console.error(JSON.stringify({
      event: 'report.fatal',
      error: err.message,
      stack: err.stack
    }))
    return json({ error: 'Internal server error' }, 500)
  }
})

// --- Génération email ---

async function generateEmail(
  anthropic: Anthropic,
  model: string,
  user: any,
  analysis: any
): Promise<{ subject: string; body: string }> {
  const diagnosis = analysis.diagnosis ?? {}
  const pattern = analysis.pattern ?? {}

  const prompt = `You are writing a churn diagnostic email for a SaaS founder.
Be direct, specific, and human. No fluff. No bullet points. Flowing prose.
Maximum 150 words for the body.

FOUNDER: ${user.first_name ?? 'there'}
PRODUCT: ${user.product_name ?? 'their SaaS'}
PATTERN: ${pattern.primary_pattern ?? 'unknown'}
TRIGGER: ${pattern.trigger_point ?? 'unknown'}
MRR AT RISK: $${diagnosis.monthly_revenue_at_risk ?? 0}/month
ROOT CAUSE: ${diagnosis.root_cause ?? 'unknown'}
THE FIX: ${diagnosis.the_fix ?? 'unknown'}
LOW CONFIDENCE: ${analysis.low_confidence ? 'yes — limited data' : 'no'}

Write the email. Return ONLY valid JSON:
{
  "subject": "subject line (max 60 chars, specific, no clickbait)",
  "body": "full email body in plain text (150 words max)"
}`

  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 512,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    })

    const text = response.content[0].type === 'text'
      ? response.content[0].text
      : ''

    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON in response')

    return JSON.parse(match[0])

  } catch {
    return buildFallbackEmail(user, analysis)
  }
}

function buildFallbackEmail(
  user: any,
  analysis: any
): { subject: string; body: string } {
  const diagnosis = analysis.diagnosis ?? {}
  const pattern = analysis.pattern ?? {}
  const firstName = user.first_name ?? 'there'
  const mrr = diagnosis.monthly_revenue_at_risk ?? 0

  return {
    subject: `Your churn diagnosis is ready`,
    body: `Hi ${firstName},

Your churn analysis for the last 90 days is complete.

Pattern detected: ${pattern.primary_pattern ?? 'unknown'}
MRR at risk: $${mrr}/month
Root cause: ${diagnosis.root_cause ?? 'Insufficient data for a detailed diagnosis.'}

What to do: ${diagnosis.the_fix ?? 'Review your onboarding flow and reach out to recently churned customers.'}

Your benchmark report will arrive shortly.

— Churn Intel`
  }
}

// --- Email delivery ---

async function sendEmail(
  apiKey: string,
  to: string,
  subject: string,
  body: string,
  retries = 3
): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Churn Intel <intel@churnintel.com>',
          to,
          subject,
          text: body
        })
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
