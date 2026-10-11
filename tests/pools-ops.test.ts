import { describe, it, expect } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('pool ops', () => {
  it('list_pools is open to any actor', async () => {
    const db: TestDb = await createTestDb()
    try {
      const pools = (await runOp(db, 'tab', 'list_pools', {})) as { id: string }[]
      expect(pools.map((p) => p.id)).toContain('jeweler')
    } finally {
      await db.close()
    }
  })

  it('create_pool / update_pool are owner-only', async () => {
    const db: TestDb = await createTestDb()
    try {
      await expect(runOp(db, 'tab', 'create_pool', { label: 'Dental Clinics' })).rejects.toThrow(OpsError)
      const created = (await runOp(db, 'owner', 'create_pool', { label: 'Dental Clinics' })) as { id: string }
      expect(created.id).toBe('dental_clinics')
      await expect(runOp(db, 'tab', 'update_pool', { id: 'dental_clinics', label: 'x' })).rejects.toThrow(OpsError)
      const updated = (await runOp(db, 'owner', 'update_pool', { id: 'dental_clinics', label: 'Dental & Orthodontic' })) as { label: string }
      expect(updated.label).toBe('Dental & Orthodontic')
    } finally {
      await db.close()
    }
  })

  it('update_pool on an unknown id is a clear 404', async () => {
    const db: TestDb = await createTestDb()
    try {
      await expect(runOp(db, 'owner', 'update_pool', { id: 'nope', label: 'x' })).rejects.toMatchObject({ status: 404 })
    } finally {
      await db.close()
    }
  })
})
