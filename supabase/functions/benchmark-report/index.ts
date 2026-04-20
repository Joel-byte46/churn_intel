import { supabaseAdmin } from '../_shared/clients.ts'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.27?target=deno'
import { resolveModel } from '../_shared/config.ts'

const RESEND_URL = 'https://api.resend.com/emails'

const SUBJECT_BY_POSITION: Record<string, string> = {
  top:          'You\'re in the top quartile. Here\'s the gap to protect.',
  above_median: 'You\'re above median. Here\'s what separates you from the top.',
  below_median: 'You\'re below median. Here\'s the exact cost.',
  bottom:       'Your churn is in the bottom quartile. Here\'s the number.'
}

Deno.serve(async (req) => {
  try {
    const { user_id } = await req.json()

    if (!user_id) {
      return json({ error: 'Missing user_id' }, 400)
    }

    // 1. Récupère le benchmark + le user en parallèle
    const [benchmarkResult, userResult, keyResult] = await Promise.all([
      supabaseAdmin
        .from('benchmark_results')
        .select('*')
        .eq('user_id', user_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single(),
      supabaseAdmin
        .from('users')
        .select('email, first_name, product_name, preferred_model')
        .eq('id', user_id)
        .single(),
      supabaseAdmin
        .rpc('get_anthropic_key', { p_user_id: user_id })
    ])

    if (benchmarkResult.error || !benchmarkResult.data) {
      return json({ error: 'Benchmark not found' }, 404)
    }

    if (userResult.error || !userResult.data) {
      return json({ error: 'User not found' }, 404)
    }

    const benchmark = benchmarkResult.data
    const user = userResult.data
    const anthropic_key = keyResult.data
    const model = resolveModel('NARRATIVE', user.preferred_model)

    // 2. Génère l'email
    const position = benchmark.reading?.position ?? 'below_median'
    const subject = SUBJECT_BY_POSITION[position] ?? 'Your benchmark report is ready'

    let emailBody: string

    if (anthropic_key) {
      const anthropic = new Anthropic({ apiKey: anthropic_key })
      emailBody = await generateBenchmarkEmail(anthropic, model, user, benchmark)
    } else {
      emailBody = buildFallbackBenchmarkEmail(user, benchmark)
    }

    // 3. Envoie via Resend
    const resendKey = Deno.env.get('RESEND_API_KEY')!
    const sent = await sendEmail(resendKey, user.email, subject, emailBody)

    if (!sent) {
      console.error(JSON.stringify({
        event: 'benchmark-report.email.failed',
        user_id,
        benchmark_id: benchmark.id
      }))
    }

    // 4. Update email_sent_at
    await supabaseAdmin
      .from('benchmark_results')
      .update({ email_sent_at: new Date().toISOString() })
      .eq('id', benchmark.id)

    console.log(JSON.stringify({
      event: 'benchmark-report.sent',
      user_id,
      model,
      position,
      to: user.email
    }))

    // Fin du cycle initial.
    // Le founder a ses 2 emails. L'autopilot prend le relais.
    return json({ status: 'sent', position }, 200)

  } catch (err) {
    console.error(JSON.stringify({
      event: 'benchmark-report.fatal',
      error: err.message,
      stack: err.stack
    }))
    return json({ error: 'Internal server error' }, 500)
  }
})

// --- Génération email ---

async function generateBenchmarkEmail(
  anthropic: Anthropic,
  model: string,
  user: any,
  benchmark: any
): Promise<string> {
  const reading = benchmark.reading ?? {}
  const data = benchmark.benchmark ?? {}

  const prompt = `Write a benchmark positioning email for a SaaS founder.
Direct. Specific numbers. No fluff. Plain text. 120 words max.

FOUNDER: ${user.first_name ?? 'there'}
POSITION: ${reading.position}
VERDICT: ${reading.verdict}
BENCHMARK SENTENCE: ${reading.benchmark_sentence}
REVENUE OPPORTUNITY: $${reading.revenue_opportunity}/month recoverable
PEER COUNT: ${benchmark.peer_count > 0 ? benchmark.peer_count + ' real peers' : 'industry benchmarks'}

Write only the email body. No subject line. Plain text.
End with one concrete action they can take based on their position.`

  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 300,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    })

    return response.content[0].type === 'text'
      ? response.content[0].text
      : buildFallbackBenchmarkEmail(user, benchmark)

  } catch {
    return buildFallbackBenchmarkEmail(user, benchmark)
  }
}

function buildFallbackBenchmarkEmail(user: any, benchmark: any): string {
  const reading = benchmark.reading ?? {}
  const data = benchmark.benchmark ?? {}
  const firstName = user.first_name ?? 'there'

  return `Hi ${firstName},

Here's where you stand vs other SaaS at your MRR level.

Your churn rate: ${data.founder_churn_rate}%/month
Median in your bracket: ${data.median_churn_rate}%/month
Top quartile: ${data.top_quartile_churn}%/month

${reading.verdict ?? ''}

If you reach the top quartile, that's $${reading.revenue_opportunity ?? 0}/month recovered.

${reading.position === 'top' || reading.position === 'above_median'
    ? 'Focus on keeping what\'s working. Your next lever is expansion revenue.'
    : 'The fastest path to top quartile: fix the pattern identified in your first email.'
  }

— Churn Intel`
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

      console.error(JSON.stringify({
        event: 'resend.error',
        attempt,
        status: res.status
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
