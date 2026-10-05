import { describe, it, expect } from 'vitest'
import { nextRevisionNumber, resolveActor } from '@/lib/revisions'

describe('revision numbers stay honest', () => {
  it('starts at 1 when the source did not say, and does not treat that as 0', () => {
    expect(nextRevisionNumber(null)).toBe(1)
    expect(nextRevisionNumber(null)).not.toBe(0)
  })

  it('increments a stored number, including a stored 0', () => {
    expect(nextRevisionNumber(1)).toBe(2)
    expect(nextRevisionNumber(0)).toBe(1)
  })

  it('uses the session email, or agent:<profile>, and ignores a spoofed email header', () => {
    const email = resolveActor(
      { headers: { get: () => 'not-jacob@example.com' } },
      'yaakovytroutai@gmail.com',
    )
    expect(email).toBe('yaakovytroutai@gmail.com')

    const agent = resolveActor(
      { headers: { get: () => 'agent:build-data' } },
      'yaakovytroutai@gmail.com',
    )
    expect(agent).toBe('agent:build-data')

    const missing = resolveActor({ headers: { get: () => null } }, null)
    expect(missing).toBeNull()
  })
})
