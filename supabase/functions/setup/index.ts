import { supabaseAdmin } from '../_shared/clients.ts'

const ANTHROPIC_TEST_URL = 'https://api.anthropic.com/v1/messages'

Deno.serve(async (req) => {
  try {
    // 1. Auth — récupère le user depuis le JWT
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Missing authorization header' }, 401)
    }

    const { data: { user }, error: authError } = await supabaseAdmin
      .auth
      .getUser(authHeader.replace('Bearer ', ''))

    if (authError || !user) {
      return json({ error: 'Unauthorized' }, 401)
    }

    // 2. Parse le body
    const { anthropic_key } = await req.json()

    if (!anthropic_key || !anthropic_key.startsWith('sk-ant-')) {
      return json({ error: 'Invalid key format' }, 400)
    }

    // 3. Valide la clé — appel test minimal
    const testRes = await fetch(ANTHROPIC_TEST_URL, {
      method: 'POST',
      headers: {
        'x-api-key': anthropic_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }]
      })
    })

    if (!testRes.ok) {
      const err = await testRes.json()
      return json({
        error: 'Invalid Anthropic key',
        detail: err?.error?.message ?? 'Unknown error'
      }, 400)
    }

    // 4. Stocke dans Vault via la fonction SQL sécurisée
    const { error: vaultError } = await supabaseAdmin
      .rpc('store_anthropic_key', {
        p_user_id: user.id,
        p_key: anthropic_key
      })

    if (vaultError) {
      console.error(JSON.stringify({
        event: 'vault.store.failed',
        user_id: user.id,
        error: vaultError.message
      }))
      return json({ error: 'Failed to store key' }, 500)
    }

    // 5. Met à jour le profil user
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        anthropic_key_set: true,
        setup_completed: true
      })
      .eq('id', user.id)

    if (updateError) {
      return json({ error: 'Failed to update user profile' }, 500)
    }

    console.log(JSON.stringify({
      event: 'setup.completed',
      user_id: user.id
    }))

    // 6. Déclenche le premier cycle d'analyse
    // Fire and forget — on ne bloque pas la réponse
    supabaseAdmin.functions.invoke('connect', {
      body: { user_id: user.id }
    }).catch((err) => {
      console.error(JSON.stringify({
        event: 'connect.invoke.failed',
        user_id: user.id,
        error: err.message
      }))
    })

    return json({ status: 'ready' }, 200)

  } catch (err) {
    console.error(JSON.stringify({
      event: 'setup.fatal',
      error: err.message
    }))
    return json({ error: 'Internal server error' }, 500)
  }
})

// Helper
function json(data: object, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
