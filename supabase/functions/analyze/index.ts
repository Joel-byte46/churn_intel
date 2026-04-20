import { supabaseAdmin } from '../_shared/clients.ts'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.27?target=deno'
import { resolveModel } from '../_shared/config.ts'

const MAX_TOKENS = 1024
const MIN_CONFIDENCE = 60

Deno.serve(async (req) => {
  try {
    const { user_id, analysis_id } = await req.json()

    if (!user_id || !analysis_id) {
      return json({ error: 'Missing user_id or analysis_id' }, 400)
    }

    // 1. Récupère l'analyse + le preferred_model du founder en une requête
    const [analysisResult, userResult] = await Promise.all([
      supabaseAdmin
        .from('churn_analyses')
        .select('*')
        .eq('id', analysis_id)
        .eq('user_id', user_id)
        .single(),
      supabaseAdmin
        .from('users')
        .select('preferred_model')
        .eq('id', user_id)
        .single()
    ])

    if (analysisResult.error || !analysisResult.data) {
      return json({ error: 'Analysis not found' }, 404)
    }

    const analysis = analysisResult.data
    const model = resolveModel('ANALYSIS', userResult.data?.preferred_model)

    // 2. Update status → analyzing
    await supabaseAdmin
      .from('churn_analyses')
      .update({ status: 'analyzing' })
      .eq('id', analysis_id)

    // 3. Récupère la clé Anthropic du founder
    const { data: anthropic_key, error: keyError } = await supabaseAdmin
      .rpc('get_anthropic_key', { p_user_id: user_id })

    if (keyError || !anthropic_key) {
      await failAnalysis(analysis_id, 'anthropic_key_missing')
      return json({ error: 'Anthropic key not configured' }, 402)
    }

    const anthropic = new Anthropic({ apiKey: anthropic_key })

    // 4. Guard : pas assez de données
    const churned = analysis.churned_customers as any[]
    if (churned.length === 0) {
      await supabaseAdmin
        .from('churn_analyses')
        .update({
          pattern: { primary_pattern: 'no_churn', confidence: 100 },
          diagnosis: {
            monthly_revenue_at_risk: 0,
            root_cause: 'No churned customers in the last 90 days.',
            the_fix: 'Nothing to fix. Focus on growth.'
          },
          status: 'complete'
        })
        .eq('id', analysis_id)

      supabaseAdmin.functions.invoke('report', {
        body: { user_id, analysis_id }
      }).catch(() => {})

      return json({ status: 'complete', pattern: 'no_churn' }, 200)
    }

    // 5. Construit le contexte
    const context = buildContext(analysis)

    // 6. Claude Call 1 — Pattern Detection
    let pattern: any
    try {
      pattern = await callClaude(anthropic, model, buildPatternPrompt(context))
    } catch (err) {
      console.error(JSON.stringify({
        event: 'claude.pattern.failed',
        user_id,
        analysis_id,
        model,
        error: err.message
      }))
      pattern = {
        primary_pattern: 'unknown',
        trigger_point: 'undetermined',
        confidence: 0,
        affected_customers: churned.length
      }
    }

    // 7. Flag low_confidence si besoin
    const lowConfidence = (pattern.confidence ?? 0) < MIN_CONFIDENCE

    // 8. Claude Call 2 — Financial Diagnosis
    let diagnosis: any
    try {
      diagnosis = await callClaude(
        anthropic,
        model,
        buildDiagnosisPrompt(context, pattern)
      )
    } catch (err) {
      console.error(JSON.stringify({
        event: 'claude.diagnosis.failed',
        user_id,
        analysis_id,
        model,
        error: err.message
      }))
      const mrrLost = churned.reduce((s, c) => s + (c.mrr ?? 0), 0)
      diagnosis = {
        monthly_revenue_at_risk: mrrLost,
        root_cause: `${churned.length} customers churned in the last 90 days.`,
        the_fix: 'Detailed diagnosis unavailable. Check your Anthropic key quota.'
      }
    }

    // 9. Persiste le résultat
    const { error: updateError } = await supabaseAdmin
      .from('churn_analyses')
      .update({
        pattern,
        diagnosis,
        low_confidence: lowConfidence,
        status: 'complete'
      })
      .eq('id', analysis_id)

    if (updateError) {
      return json({ error: 'Failed to save analysis' }, 500)
    }

    console.log(JSON.stringify({
      event: 'analyze.completed',
      user_id,
      analysis_id,
      model,
      pattern: pattern.primary_pattern,
      confidence: pattern.confidence,
      low_confidence: lowConfidence
    }))

    // 10. Déclenche report/ — fire and forget
    supabaseAdmin.functions.invoke('report', {
      body: { user_id, analysis_id }
    }).catch((err) => {
      console.error(JSON.stringify({
        event: 'report.invoke.failed',
        user_id,
        analysis_id,
        error: err.message
      }))
    })

    return json({ status: 'complete', analysis_id }, 200)

  } catch (err) {
    console.error(JSON.stringify({
      event: 'analyze.fatal',
      error: err.message,
      stack: err.stack
    }))
    return json({ error: 'Internal server error' }, 500)
  }
})

// --- Prompts ---

function buildContext(analysis: any) {
  const churned = analysis.churned_customers as any[]

  return {
    churned_count: churned.length,
    active_count: analysis.active_customers,
    total_mrr: analysis.total_mrr,
    churn_rate: analysis.active_customers > 0
      ? ((churned.length / (churned.length + analysis.active_customers)) * 100).toFixed(1)
      : '0',
    mrr_lost: churned.reduce((s: number, c: any) => s + (c.mrr ?? 0), 0).toFixed(2),
    plans: [...new Set(churned.map((c: any) => c.plan_name))],
    cancel_reasons: churned
      .filter((c: any) => c.cancel_reason)
      .map((c: any) => c.cancel_reason),
    tenures: churned.map((c: any) => {
      if (!c.created_at || !c.canceled_at) return null
      return Math.floor((c.canceled_at - c.created_at) / 86400)
    }).filter(Boolean),
    comments: churned
      .filter((c: any) => c.cancel_comment)
      .map((c: any) => c.cancel_comment)
      .slice(0, 10)
  }
}

function buildPatternPrompt(ctx: any): string {
  return `You are a SaaS churn analyst. Analyze this churn data and identify the dominant pattern.

DATA:
- Churned customers (last 90 days): ${ctx.churned_count}
- Active customers: ${ctx.active_count}
- Churn rate: ${ctx.churn_rate}%
- MRR lost: $${ctx.mrr_lost}
- Plans affected: ${ctx.plans.join(', ') || 'unknown'}
- Cancel reasons: ${ctx.cancel_reasons.join(', ') || 'none provided'}
- Customer tenures (days): ${ctx.tenures.join(', ') || 'unknown'}
- Cancel comments: ${ctx.comments.join(' | ') || 'none'}

Identify the single most dominant churn pattern. Return ONLY valid JSON:

{
  "primary_pattern": "EARLY_CHURN | ACTIVATION_FAILURE | VALUE_GAP | PRICE_SENSITIVITY | COMPETITION | UNKNOWN",
  "trigger_point": "exact moment or timeframe when customers leave",
  "confidence": 0-100,
  "affected_customers": number,
  "supporting_evidence": "one sentence explaining the pattern"
}`
}

function buildDiagnosisPrompt(ctx: any, pattern: any): string {
  return `You are a SaaS revenue analyst. Given this churn pattern, produce a financial diagnosis.

CHURN DATA:
- MRR lost: $${ctx.mrr_lost}
- Total MRR: $${ctx.total_mrr}
- Churned: ${ctx.churned_count} customers
- Pattern: ${pattern.primary_pattern}
- Trigger: ${pattern.trigger_point}
- Evidence: ${pattern.supporting_evidence ?? 'none'}

Return ONLY valid JSON:

{
  "monthly_revenue_at_risk": number (MRR lost per month, decimal),
  "annual_impact": number (monthly × 12),
  "root_cause": "one sentence — the real reason customers leave",
  "the_fix": "one concrete action the founder can take this week"
}`
}

// --- Helpers ---

async function callClaude(
  anthropic: Anthropic,
  model: string,
  prompt: string,
  retries = 2
): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      })

      const text = response.content[0].type === 'text'
        ? response.content[0].text
        : ''

      const match = text.match(/\{[\s\S]*\}/)
      if (!match) throw new Error('No JSON found in Claude response')

      return JSON.parse(match[0])

    } catch (err) {
      if (attempt === retries) throw err
      await sleep(1000 * Math.pow(4, attempt))
    }
  }
}

async function failAnalysis(analysis_id: string, reason: string) {
  await supabaseAdmin
    .from('churn_analyses')
    .update({ status: 'failed' })
    .eq('id', analysis_id)

  console.error(JSON.stringify({
    event: 'analyze.failed',
    analysis_id,
    reason
  }))
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
