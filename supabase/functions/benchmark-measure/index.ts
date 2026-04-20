import { supabaseAdmin } from '../_shared/clients.ts'

Deno.serve(async (req) => {
  try {
    const { user_id, analysis_id } = await req.json()

    if (!user_id || !analysis_id) {
      return json({ error: 'Missing user_id or analysis_id' }, 400)
    }

    // 1. Récupère l'analyse complète
    const { data: analysis, error: analysisError } = await supabaseAdmin
      .from('churn_analyses')
      .select('*')
      .eq('id', analysis_id)
      .single()

    if (analysisError || !analysis) {
      return json({ error: 'Analysis not found' }, 404)
    }

    // 2. Calcule les 4 métriques fondamentales
    const churned = analysis.churned_customers as any[]
    const totalCustomers = churned.length + analysis.active_customers
    const mrr = analysis.total_mrr

    // Churn rate mensuel (sur 90 jours → ramené à 30)
    const churnRate = totalCustomers > 0
      ? ((churned.length / totalCustomers) / 3) * 100
      : 0

    // Tenure moyenne des churned (en jours)
    const tenures = churned
      .map((c: any) => {
        if (!c.created_at || !c.canceled_at) return null
        return Math.floor((c.canceled_at - c.created_at) / 86400)
      })
      .filter((t): t is number => t !== null)

    const avgTenure = tenures.length > 0
      ? tenures.reduce((a, b) => a + b, 0) / tenures.length
      : 0

    // MRR perdu sur 30 jours (90j / 3)
    const mrrLost90d = churned.reduce((s: number, c: any) => s + (c.mrr ?? 0), 0)
    const mrrLost30d = mrrLost90d / 3

    // Cause dominante
    const dominantCause = analysis.pattern?.primary_pattern ?? 'UNKNOWN'

    // 3. Détermine le bracket MRR
    const mrr_bracket = getMrrBracket(mrr)

    // 4. Upsert founder_metrics
    const { error: upsertError } = await supabaseAdmin
      .from('founder_metrics')
      .upsert({
        user_id,
        churn_rate: Math.round(churnRate * 100) / 100,
        avg_customer_tenure: Math.round(avgTenure * 100) / 100,
        mrr,
        mrr_lost_30d: Math.round(mrrLost30d * 100) / 100,
        mrr_bracket,
        dominant_churn_cause: dominantCause,
        computed_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      })

    if (upsertError) {
      console.error(JSON.stringify({
        event: 'founder_metrics.upsert.failed',
        user_id,
        error: upsertError.message
      }))
      return json({ error: 'Failed to save metrics' }, 500)
    }

    console.log(JSON.stringify({
      event: 'benchmark-measure.completed',
      user_id,
      mrr_bracket,
      churn_rate: churnRate,
      mrr_lost_30d: mrrLost30d
    }))

    // 5. Déclenche benchmark-compare/ — fire and forget
    supabaseAdmin.functions.invoke('benchmark-compare', {
      body: { user_id }
    }).catch((err) => {
      console.error(JSON.stringify({
        event: 'benchmark-compare.invoke.failed',
        user_id,
        error: err.message
      }))
    })

    return json({ status: 'measured', mrr_bracket }, 200)

  } catch (err) {
    console.error(JSON.stringify({
      event: 'benchmark-measure.fatal',
      error: err.message,
      stack: err.stack
    }))
    return json({ error: 'Internal server error' }, 500)
  }
})

// --- Helpers ---

function getMrrBracket(mrr: number): string {
  if (mrr < 1000)  return '0-1K'
  if (mrr < 5000)  return '1K-5K'
  if (mrr < 10000) return '5K-10K'
  return '10K-50K'
}

function json(data: object, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
