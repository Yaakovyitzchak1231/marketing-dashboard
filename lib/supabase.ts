import { createBrowserClient } from '@supabase/ssr'

// A plain @supabase/supabase-js client persisted the session in localStorage,
// which the server-side middleware cannot read -- so signing in succeeded while
// every protected route still redirected to /login. createBrowserClient writes
// the session to cookies as well, which is what middleware.ts validates.
export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)
