import { describe, it, expect, afterEach, vi } from 'vitest'
vi.mock('server-only', () => ({}))

import { createTestDb } from './helpers/pglite-db'
import { AuthError, canAtLeast, isFallbackOwner, requireRole, resolveRole } from '@/lib/auth/roles'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isFallbackOwner', () => {
  it('matches ALLOWED_USER_EMAIL case-insensitively', () => {
    vi.stubEnv('ALLOWED_USER_EMAIL', 'yaakov@example.com')
    expect(isFallbackOwner('Yaakov@Example.com')).toBe(true)
    expect(isFallbackOwner('someone@example.com')).toBe(false)
  })
  it('is false when ALLOWED_USER_EMAIL is unset', () => {
    vi.stubEnv('ALLOWED_USER_EMAIL', '')
    expect(isFallbackOwner('anyone@example.com')).toBe(false)
  })
})

describe('resolveRole', () => {
  it('the env owner fallback is always owner, even with no database', async () => {
    vi.stubEnv('ALLOWED_USER_EMAIL', 'yaakov@example.com')
    expect(await resolveRole('yaakov@example.com', null)).toBe('owner')
  })

  it('the env owner fallback wins even if a database row disagrees', async () => {
    vi.stubEnv('ALLOWED_USER_EMAIL', 'yaakov@example.com')
    const db = await createTestDb()
    try {
      // No row at all for yaakov@example.com -- the fallback still answers 'owner'.
      expect(await resolveRole('yaakov@example.com', db)).toBe('owner')
    } finally {
      await db.close()
    }
  })

  it('an unknown email is denied (null), not silently widened', async () => {
    vi.stubEnv('ALLOWED_USER_EMAIL', 'yaakov@example.com')
    const db = await createTestDb()
    try {
      expect(await resolveRole('stranger@example.com', db)).toBeNull()
      expect(await resolveRole(null, db)).toBeNull()
      expect(await resolveRole('stranger@example.com', null)).toBeNull()
    } finally {
      await db.close()
    }
  })

  it('a role recorded in lp.actors resolves for a non-fallback email', async () => {
    vi.stubEnv('ALLOWED_USER_EMAIL', 'yaakov@example.com')
    const db = await createTestDb()
    try {
      await db.tx((q) => q.query(
        `insert into lp.actors (id, kind, display_name, harness, active, role, email) values ('izzy', 'human', 'Izzy', 'dashboard', true, 'editor', 'izzy@example.com')`,
      ), 'owner')
      expect(await resolveRole('izzy@example.com', db)).toBe('editor')
      expect(await resolveRole('Izzy@Example.com', db)).toBe('editor')
    } finally {
      await db.close()
    }
  })

  it('a deactivated human is denied', async () => {
    vi.stubEnv('ALLOWED_USER_EMAIL', 'yaakov@example.com')
    const db = await createTestDb()
    try {
      await db.tx((q) => q.query(
        `insert into lp.actors (id, kind, display_name, harness, active, role, email) values ('izzy', 'human', 'Izzy', 'dashboard', false, 'editor', 'izzy@example.com')`,
      ), 'owner')
      expect(await resolveRole('izzy@example.com', db)).toBeNull()
    } finally {
      await db.close()
    }
  })
})

describe('canAtLeast / requireRole', () => {
  it('ranks viewer < editor < owner', () => {
    expect(canAtLeast('viewer', 'viewer')).toBe(true)
    expect(canAtLeast('viewer', 'editor')).toBe(false)
    expect(canAtLeast('editor', 'viewer')).toBe(true)
    expect(canAtLeast('owner', 'editor')).toBe(true)
    expect(canAtLeast(null, 'viewer')).toBe(false)
  })

  it('requireRole blocks a viewer from an edit action', () => {
    expect(() => requireRole('viewer', 'editor')).toThrow(AuthError)
    expect(() => requireRole('editor', 'editor')).not.toThrow()
    expect(() => requireRole('owner', 'editor')).not.toThrow()
    expect(() => requireRole(null, 'viewer')).toThrow(AuthError)
  })
})
