import { describe, expect, it } from 'vitest'
import { agoWords, loadRunnerSignals, runnerLabel, runnerStatus, RUNNER_ONLINE_MS } from '@/lib/jobs/runner-status'

const NOW = new Date('2026-10-11T14:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

describe('runnerStatus', () => {
  it('never connected when there is no heartbeat at all', () => {
    const st = runnerStatus({ actorSeenAt: null, keyUsedAt: null, lastRun: null }, NOW)
    expect(st).toEqual({ state: 'never', lastSeen: null, runner: null })
    expect(runnerLabel(st, NOW)).toBe('Runner never connected')
  })

  it('online when the newest signal is recent, using the newest of the three', () => {
    const st = runnerStatus({ actorSeenAt: ago(60 * 60_000), keyUsedAt: ago(20_000), lastRun: { runner: 'ovh-runner-1', at: ago(10 * 60_000).toISOString() } }, NOW)
    expect(st.state).toBe('online')
    expect(st.lastSeen).toBe(ago(20_000).toISOString())
    expect(runnerLabel(st, NOW)).toBe('Runner online (ovh-runner-1) · last seen just now')
  })

  it('offline past the threshold', () => {
    const st = runnerStatus({ actorSeenAt: ago(RUNNER_ONLINE_MS + 1000), keyUsedAt: null, lastRun: null }, NOW)
    expect(st.state).toBe('offline')
    expect(runnerLabel(st, NOW)).toBe('Runner offline · last seen 5m ago')
    expect(runnerStatus({ actorSeenAt: ago(RUNNER_ONLINE_MS), keyUsedAt: null, lastRun: null }, NOW).state).toBe('online')
  })

  it('ignores unparseable times', () => {
    expect(runnerStatus({ actorSeenAt: 'nope', keyUsedAt: null, lastRun: { runner: 'r', at: null } }, NOW).state).toBe('never')
  })
})

describe('agoWords', () => {
  it('reads short', () => {
    expect(agoWords(ago(90_000).toISOString(), NOW)).toBe('2m ago')
    expect(agoWords(ago(3 * 3600_000).toISOString(), NOW)).toBe('3h ago')
    expect(agoWords(ago(3 * 86400_000).toISOString(), NOW)).toBe('3d ago')
    expect(agoWords(null, NOW)).toBe('never')
  })
})

describe('loadRunnerSignals', () => {
  it('maps the one-row query', async () => {
    const t = new Date('2026-10-11T13:59:00Z')
    const q = { query: async () => ({ rows: [{ actor_seen: t, key_used: null, runner: 'ovh-runner-1', run_at: t }] }) } as never
    expect(await loadRunnerSignals(q)).toEqual({ actorSeenAt: t, keyUsedAt: null, lastRun: { runner: 'ovh-runner-1', at: t } })
  })
  it('no run row means no lastRun', async () => {
    const q = { query: async () => ({ rows: [{ actor_seen: null, key_used: null, runner: null, run_at: null }] }) } as never
    expect((await loadRunnerSignals(q)).lastRun).toBeNull()
  })
})
