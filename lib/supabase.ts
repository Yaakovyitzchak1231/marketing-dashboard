import { createBrowserClient } from '@supabase/ssr'

/**
 * The browser-side Supabase client, built lazily.
 *
 * A plain `@supabase/supabase-js` client persisted the session in
 * localStorage, which the server-side middleware cannot read -- so signing in
 * succeeded while every protected route still redirected to /login.
 * createBrowserClient writes the session to cookies as well, which is what
 * middleware.ts validates.
 *
 * It is a LAZY getter rather than a module-scope constant. `createBrowserClient`
 * throws immediately when the project URL or anon key is missing, and a
 * module-scope call therefore ran during `next build`'s prerender pass, where
 * those NEXT_PUBLIC_* values are not guaranteed to be present. That failed the
 * whole production build on a page that needs no data at all.
 *
 * Deferring construction to first use keeps the failure where it belongs: in
 * the browser, at sign-in time, where a missing configuration is a real,
 * actionable error rather than a build-time crash.
 */

/**
 * The error a misconfigured deploy raises on first use, phrased for whoever
 * has to fix it rather than for a stack trace.
 */
function configurationError(): Error {
  return new Error(
    'Supabase is not configured: NEXT_PUBLIC_SUPABASE_URL and ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY must both be set.',
  )
}

let client: ReturnType<typeof createBrowserClient> | null = null

/**
 * The shared browser client, constructed on first use.
 *
 * @throws when Supabase is not configured. Callers are UI code that can
 * surface the message; a silent unusable client would instead present as
 * "sign-in does nothing", which is the bug this project already fixed once.
 */
export function getSupabase(): ReturnType<typeof createBrowserClient> {
  if (client) return client

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) throw configurationError()

  client = createBrowserClient(url, anonKey)
  return client
}

/**
 * Kept for existing call sites that read the client as a value.
 *
 * Deprecated in favour of `getSupabase()`: this still constructs at import
 * time, so it carries the same build-time fragility and is kept only so the
 * migration can be done one call site at a time. Any new code must call
 * `getSupabase()` inside the function that needs it.
 */
export const supabase = new Proxy({} as ReturnType<typeof createBrowserClient>, {
  get(_target, prop) {
    return getSupabase()[prop as keyof ReturnType<typeof createBrowserClient>]
  },
})