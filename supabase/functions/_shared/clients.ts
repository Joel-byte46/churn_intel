import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Client public — respecte RLS
// Utilisé pour les opérations liées au user authentifié
export const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_ANON_KEY')!
)

// Client admin — bypass RLS
// Uniquement pour : Vault, cron jobs, cascades inter-functions
// Jamais exposé côté client
export const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)
