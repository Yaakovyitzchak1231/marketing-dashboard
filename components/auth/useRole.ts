'use client'

import { useEffect, useState } from 'react'
import type { Role } from '@/lib/auth/roles'

/**
 * The signed-in person's dashboard role, on the client, for UI only (hiding a
 * button a viewer can't use, picking the right message). It is NOT a security
 * check: middleware.ts and each server action stay the gate.
 *
 * Reads GET /api/internal/role (the route middleware itself uses; a GET, so a
 * viewer is never refused). One request per page load, shared by every caller.
 * `undefined` while loading, `null` when unknown or signed out.
 */
let cached: Promise<Role | null> | null = null

export function fetchRole(): Promise<Role | null> {
  if (!cached) {
    cached = fetch('/api/internal/role', { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { role: null }))
      .then((j: { role?: unknown }) => (j.role === 'viewer' || j.role === 'editor' || j.role === 'owner' ? j.role : null))
      .catch(() => null)
  }
  return cached
}

/** Test hook: forget the cached answer. */
export function resetRoleCache(): void {
  cached = null
}

export function useRole(): Role | null | undefined {
  const [role, setRole] = useState<Role | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    fetchRole().then((r) => {
      if (live) setRole(r)
    })
    return () => {
      live = false
    }
  }, [])
  return role
}

/** The exact words the middleware sends a viewer on any write. */
export const VIEWER_REFUSAL = 'Viewers can look but not change things'
