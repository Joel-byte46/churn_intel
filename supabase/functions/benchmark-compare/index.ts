import { supabaseAdmin } from '../_shared/clients.ts'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.27?target=deno'

const MODEL = 'claude-3-5-sonnet-20241022'
const MIN_PEERS = 5

// Données industrie publiques par bracket
// Fallback quand pas assez de peers dans la DB
const INDUSTRY_BENCHMARKS: Record<string, any> = {
  '0-1K': {
    median_churn_rate: 8.5,
    p25_churn_rate: 5.0,
    p75_churn_rate: 14.0,
    median_tenure: 45,
    median_mrr_lost_30d_pct: 8.5
  },
  '1K-5K': {
    median_churn_rate: 6.2,
    p25_churn_rate: 3.5,
    p75_churn_rate: 10.5,
    median_tenure: 65,
    median_mrr_lost_30d_pct: 6.2
  },
  '5K-10K': {
    median_churn_rate: 4.8,
    p25_churn_rate: 2.5,
    p75_churn_rate: 8.0,
    median_tenure: 90,
    median_mrr_lost_30d_pct: 4.8
  },
  '10K-50K': {
    median_churn_rate: 3.5,
    p25_churn_rate: 1.8,
    p75_churn_rate: 6.0,
    median_tenure: 120,
    median_mrr_lost_30d_pct: 3.5
  }
}

Deno.serve(async (req) => {
  try {
    const { user_id } = await req.json()

    if (!user_id) {
      return json({ error: 'Missing user_id' }, 400)
    }

    // 1. Récupère les métriques du founder
    const { data: founder, error: founderError } = await supabaseAdmin
      .from('founder_metrics')
      .select('*')
      .eq('user_id', user_id)
      .single()

    if (founderError || !founder) {
      return json({ error: 'Founder metrics not found' }, 404)
    }

    // 2. Récupère les peers anonymisés dans le même bracket
    const { data: peers, error: peersError } = await supabaseAdmin
      .from('founder_metrics')
      .select('churn_rate, avg_customer_tenure, mrr_lost_30d, mrr')
      .eq('mrr_bracket', founder.mrr_bracket)
      .neq('user_id', user_id)

    if (peersError) {
      console.error(JSON.stringify({
        event: 'peers.fetch.failed',
        user_id,
        error: peersError.message
      }))
    }

    const validPeers = peers ?? []

    // 3. Calcule les benchmarks
    // Utilise peers réels si assez, sinon industrie
    const benchmark = validPeers.length >= MIN_PEERS
      ? computePeerBenchmark(founder, validPeers)
      : computeIndustryBenchmark(founder, INDUSTRY_BENCHMARKS[founder.mrr_bracket])

    // 4. Récupère la clé Anthropic
    const { data: anthropic_key } = await supabaseAdmin
      .rpc('get_anthropic_key', { p_user_id: user_id })

    // 5. Génère la lecture — Claude ou fallback
    let reading: any

    if (anthropic_key) {
      const anthropic = new Anthropic({ apiKey: anthropic_key })
      reading = await generateReading(anthropic, founder, benchmark, validPeers.length)
    } else {
      reading = buildFallbackReading(founder, benchmark)
    }

    // 6. Insert benchmark_results
    const { error: insertError } = await supabaseAdmin
      .from('benchmark_results')
      .insert({
        user_id,
        peer_count: validPeers.length,
        benchmark,
        reading
      })

    if (insertError) {
      console.error(JSON.stringify({
        event: 'benchmark_results.insert.failed',
        user_id,
        error: insertError.message
      }))
      return json({ error: 'Failed to save benchmark' }, 500)
    }

    console.log(JSON.stringify({
      event: 'benchmark-compare.completed',
      user_id,
      peer_count: validPeers.length,
      position: reading.position,
      using_industry_data: validPeers.length < MIN_PEERS
    }))

    // 7. Déclenche benchmark-report/ — fire and forget
    supabaseAdmin.functions.invoke('benchmark-report', {
      body: { user_id }
    }).catch((err) => {
      console.error(JSON.stringify({
        event: 'benchmark-report.invoke.failed',
        user_id,
        error: err.message
      }))
    })

    return json({ status: 'compared', position: reading.position }, 200)

  } catch (err) {
    console.error(JSON.stringify({
      event: 'benchmark-compare.fatal',
      error: err.message,
      stack: err.stack
    }))
    return json({ error: 'Internal server error' }, 500)
  }
})

// --- Calculs ---

function computePeerBenchmark(founder: any, peers: any[]) {
  const churnRates = peers.map(p => p.churn_rate).sort((a, b) => a - b)
  const tenures = peers.map(p => p.avg_customer_tenure).sort((a, b) => a - b)

  const median = (arr: number[]) => {
    const mid = Math.floor(arr.length / 2)
    return arr.length % 2 !== 0
      ? arr[mid]
      : (arr[mid - 1] + arr[mid]) / 2
  }

  const percentile = (arr: number[], p: number) => {
    const idx = Math.floor((p / 100) * arr.length)
    return arr[Math.min(idx, arr.length - 1)]
  }

  const medianChurn = median(churnRates)
  const founderChurn = founder.churn_rate

  // Position dans le bracket
  const betterThan = churnRates.filter(r => r > founderChurn).length
  const percentileRank = Math.round((betterThan / peers.length) * 100)

  // Gap vers le top quartile (p25 = meilleurs)
  const topQuartileChurn = percentile(churnRates, 25)
  const mrrGap = founder.mrr > 0
    ? ((founderChurn - topQuartileChurn) / 100) * founder.mrr
    : 0

  return {
    source: 'peers',
    peer_count: peers.length,
    median_churn_rate: Math.round(medianChurn * 100) / 100,
    p25_churn_rate: Math.round(percentile(churnRates, 25) * 100) / 100,
    p75_churn_rate: Math.round(percentile(churnRates, 75) * 100) / 100,
    median_tenure: Math.round(median(tenures)),
    founder_churn_rate: founderChurn,
    founder_tenure: founder.avg_customer_tenure,
    percentile_rank: percentileRank,
    top_quartile_churn: Math.round(topQuartileChurn * 100) / 100,
    monthly_opportunity: Math.round(Math.max(0, mrrGap) * 100) / 100
  }
}

function computeIndustryBenchmark(founder: any, industry: any) {
  const founderChurn = founder.churn_rate
  const mrrGap = founder.mrr > 0
    ? ((founderChurn - industry.p25_churn_rate) / 100) * founder.mrr
    : 0

  // Percentile approximé vs industrie
  let percentileRank = 50
  if (founderChurn <= industry.p25_churn_rate) percentileRank = 80
  else if (founderChurn <= industry.median_churn_rate) percentileRank = 55
  else if (founderChurn <= industry.p75_churn_rate) percentileRank = 30
  else percentileRank = 10

  return {
    source: 'industry',
    peer_count: 0,
    median_churn_rate: industry.median_churn_rate,
    p25_churn_rate: industry.p25_churn_rate,
    p75_churn_rate: industry.p75_churn_rate,
    median_tenure: industry.median_tenure,
    founder_churn_rate: founderChurn,
    founder_tenure: founder.avg_customer_tenure,
    percentile_rank: percentileRank,
    top_quartile_churn: industry.p25_churn_rate,
    monthly_opportunity: Math.round(Math.max(0, mrrGap) * 100) / 100
  }
}

// --- Lecture Claude ---

async function generateReading(
  anthropic: Anthropic,
  founder: any,
  benchmark: any,
  peerCount: number
): Promise<any> {
  const prompt = `You are a SaaS benchmark analyst. Interpret this founder's position versus peers.
Be direct. One number. One verdict. One opportunity.

FOUNDER METRICS:
- MRR: $${founder.mrr}
- Churn rate: ${founder.churn_rate}%/month
- Avg customer tenure: ${Math.round(founder.avg_customer_tenure)} days
- MRR bracket: ${founder.mrr_bracket}

BENCHMARK (${benchmark.source === 'peers' ? peerCount + ' real peers' : 'industry data'}):
- Median churn rate: ${benchmark.median_churn_rate}%
- Top quartile churn: ${benchmark.top_quartile_churn}%
- Bottom quartile churn: ${benchmark.p75_churn_rate}%
- Founder percentile rank: ${benchmark.percentile_rank}th (higher = better)
- Monthly opportunity if top quartile: $${benchmark.monthly_opportunity}

Return ONLY valid JSON:
{
  "position": "top | above_median | below_median | bottom",
  "verdict": "one sentence — exactly where they stand and what it means",
  "revenue_opportunity": number (monthly MRR recoverable if they hit top quartile),
  "benchmark_sentence": "one sentence comparing their churn to the median — use specific numbers"
}`

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 256,
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
    return buildFallbackReading(founder, benchmark)
  }
}

function buildFallbackReading(founder: any, benchmark: any): any {
  const position = founder.churn_rate <= benchmark.p25_churn_rate ? 'top'
    : founder.churn_rate <= benchmark.median_churn_rate ? 'above_median'
    : founder.churn_rate <= benchmark.p75_churn_rate ? 'below_median'
    : 'bottom'

  return {
    position,
    verdict: `Your churn rate of ${founder.churn_rate}% is ${position === 'top' || position === 'above_median' ? 'better' : 'worse'} than the ${benchmark.median_churn_rate}% median in your bracket.`,
    revenue_opportunity: benchmark.monthly_opportunity,
    benchmark_sentence: `Median churn in the ${founder.mrr_bracket} bracket is ${benchmark.median_churn_rate}%. Top quartile is ${benchmark.top_quartile_churn}%.`
  }
}

function json(data: object, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
