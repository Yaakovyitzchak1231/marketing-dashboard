import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _supabase: SupabaseClient | null = null
let _initError: Error | null = null

function getSupabaseClient(): SupabaseClient {
  if (_initError) {
    throw _initError
  }
  if (_supabase) {
    return _supabase
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    _initError = new Error('Supabase configuration missing: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required')
    throw _initError
  }

  _supabase = createClient(supabaseUrl, supabaseAnonKey)
  return _supabase
}

// Proxy that lazily initializes on first property access
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop: string | symbol) {
    const client = getSupabaseClient()
    const value = client[prop as keyof SupabaseClient]
    return typeof value === 'function' ? value.bind(client) : value
  }
})