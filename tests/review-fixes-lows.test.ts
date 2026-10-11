import { describe, it, expect, vi } from 'vitest'

// Leftover Lows from Viktor's re-checks of #87 (720a859) and #89 (3986046).
const { holder } = vi.hoisted(() => ({ holder: { role: null as string | null } }))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`)
  },
}))
vi.mock('@/lib/db', () => ({ getDb: () => null, dbConfigured: () => false }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => holder.role,
  currentActorId: async () => 'someone',
  currentEmail: async () => null,
}))

import { companyDomainFromEmail } from '@/lib/leads/csv-import'
import { FREE_PROVIDERS } from '@/lib/verify/precheck'
import { deleteCostAction } from '@/app/actions/reports'
import { listMyCommentsAction } from '@/app/actions/page-comments'

describe('#89 Lows: email-domain company matching', () => {
  it('normalizes the email domain like a website column', () => {
    expect(companyDomainFromEmail('a@WWW.AcmeJewel.test')).toBe('acmejewel.test')
    expect(companyDomainFromEmail('a@acmejewel.test.')).toBe('acmejewel.test')
  })

  it('never turns a not-a-store host into a company domain', () => {
    expect(companyDomainFromEmail('shop@etsy.com')).toBeNull()
    expect(companyDomainFromEmail('x@facebook.com')).toBeNull()
  })

  it('treats Canadian / UK free-mail as free-mail', () => {
    for (const d of ['yahoo.ca', 'hotmail.ca', 'live.ca', 'outlook.co.uk', 'btinternet.com', 'sympatico.ca', 'shaw.ca', 'rogers.com']) {
      expect(FREE_PROVIDERS.has(d)).toBe(true)
      expect(companyDomainFromEmail(`person@${d}`)).toBeNull()
    }
  })
})

describe('#87 Lows: action role checks', () => {
  it('deleteCostAction needs Editor like addCostAction (a Viewer is refused before any delete)', async () => {
    holder.role = 'viewer'
    const f = new FormData()
    f.set('id', '1')
    await expect(deleteCostAction(f)).rejects.toThrow(/editor access/)
  })

  it('listMyCommentsAction is a read: a Viewer is not refused by the role check', async () => {
    holder.role = 'viewer'
    const r = await listMyCommentsAction()
    // No database in this test, so it stops at "not connected" -- past the role gate.
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toMatch(/access/)
    holder.role = null
    const anon = await listMyCommentsAction()
    expect(anon.ok).toBe(false)
  })
})
