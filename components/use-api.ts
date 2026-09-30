'use client'

import { useCallback } from 'react'
import { supabase } from '@/lib/supabase'

/**
 * Authenticated fetch against our own API routes. The routes read the Bearer
 * token and build a request-scoped Supabase client, so RLS sees the real
 * signed-in user for writes.
 */
export function useApi() {
  const call = useCallback(async (path: string, init?: RequestInit) => {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error((body as { error?: string }).error || `Request failed (${res.status})`)
    }
    return body
  }, [])
  return call
}
