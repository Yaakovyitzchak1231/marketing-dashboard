import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _serverSupabase: SupabaseClient | null = null
let _serverInitError: Error | null = null

function getServerSupabaseClient(): SupabaseClient {
  if (_serverInitError) {
    throw _serverInitError
  }
  if (_serverSupabase) {
    return _serverSupabase
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    _serverInitError = new Error('Supabase server configuration missing: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
    throw _serverInitError
  }

  _serverSupabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  })
  return _serverSupabase
}

// Export a function that returns the lazy-initialized client
// This preserves the existing call pattern: createServerSupabaseClient()
export function createServerSupabaseClient(): SupabaseClient {
  return getServerSupabaseClient()
}