'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { safeNextPath } from '@/lib/auth/next-path'

const BAD_CREDENTIALS = 'Incorrect email or password'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // The middleware sends a signed-in but not-allowed account here with
  // ?error=unauthorized_account. Say so instead of showing a blank form.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('error') === 'unauthorized_account') {
      setError('That account is not allowed to view this dashboard.')
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password
    })

    if (signInError) {
      setError(BAD_CREDENTIALS)
      setLoading(false)
      return
    }

    // On success the page used to hang on "Signing in..." forever: nothing
    // cleared loading and nothing navigated. A full navigation is deliberate
    // rather than router.push so the server component re-renders with the
    // session cookie already in place. `next` is the page the middleware
    // bounced them from; it is re-checked here because anyone can craft it.
    const next = safeNextPath(new URLSearchParams(window.location.search).get('next'))
    window.location.href = next ?? '/'
  }

  // 16px below the sm breakpoint: iOS Safari zooms the page when a focused
  // input's font-size is under 16px. Desktop keeps the 14px house size.
  const input =
    'block w-full rounded-card border border-line bg-surface px-3 py-2.5 text-[16px] sm:text-[14px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60'

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-6">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-ink">Cold email dashboard</h1>
          <p className="mt-1 text-[13px] text-ink-muted">Sign in to see your campaigns, live from Instantly.</p>
        </div>

        <form className="space-y-4 rounded-card border border-line bg-surface p-5 shadow-card" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="email" className="mb-1.5 block text-[12px] font-medium text-ink-muted">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={input}
              placeholder="you@company.com"
              disabled={loading}
              aria-invalid={error === BAD_CREDENTIALS || undefined}
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-[12px] font-medium text-ink-muted">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={input}
              placeholder="Password"
              disabled={loading}
              aria-invalid={error === BAD_CREDENTIALS || undefined}
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>

          {error && (
            <p id="login-error" role="alert" className="rounded-card border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-card bg-accent px-4 py-2.5 text-[14px] font-medium text-white hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:ring-offset-2 focus:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
