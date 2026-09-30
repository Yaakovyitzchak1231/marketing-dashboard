import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  STAGE_LABELS,
  KNOWN_STAGES,
  UNKNOWN_STAGE_LABEL,
  splitStage,
  isKnownStage,
  labelForStage,
  groupStages,
} from '@/lib/stages'
import { GET as errorsGET } from '@/app/api/collection-errors/route'

const mockSupabase = vi.hoisted(() => ({
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  gte: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({ supabase: mockSupabase }))

/**
 * The stages below are the literal strings the collector writes today, read
 * from `collect_instantly.py`'s `_err(...)` call sites. If someone adds a stage
 * without a label, the unknown-stage tests are what should fail.
 */
const COLLECTOR_STAGES = ['overview', 'list_campaigns', 'campaign:8ddf6580', 'senders']

describe('stage labels', () => {
  it('labels every stage the live collector emits', () => {
    for (const stage of COLLECTOR_STAGES) {
      expect(isKnownStage(stage)).toBe(true)
      expect(labelForStage(stage).known).toBe(true)
    }
  })

  it('never returns a raw stage key as a label', () => {
    // The failure mode this exists to prevent: an unmapped stage printing
    // itself, e.g. "list_campaigns" rendered to a human.
    for (const stage of [...COLLECTOR_STAGES, 'brand_new_stage', 'campaign:zzzz', '']) {
      const { label } = labelForStage(stage)
      expect(label).not.toBe(stage)
      expect(label).not.toContain('_')
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('falls back to a neutral label for an unknown stage', () => {
    const info = labelForStage('brand_new_stage')
    expect(info.label).toBe(UNKNOWN_STAGE_LABEL)
    expect(info.known).toBe(false)
  })

  it('splits a campaign stage into prefix and id', () => {
    expect(splitStage('campaign:8ddf6580')).toEqual({
      prefix: 'campaign',
      campaignExternalId: '8ddf6580',
    })
    expect(splitStage('senders')).toEqual({
      prefix: 'senders',
      campaignExternalId: null,
    })
  })

  it('exposes the campaign id on a campaign stage', () => {
    expect(labelForStage('campaign:8ddf6580').campaignExternalId).toBe('8ddf6580')
    expect(labelForStage('overview').campaignExternalId).toBeNull()
  })

  it('maps the three account-wide stages to their labels', () => {
    expect(STAGE_LABELS.overview).toBe('Account overview')
    expect(STAGE_LABELS.senders).toBe('Sending accounts')
    expect(STAGE_LABELS.campaign).toBe('Campaign analytics')
  })

  it('groups repeated stages with a count instead of repeating sentences', () => {
    const groups = groupStages([
      { stage: 'campaign:aaa' },
      { stage: 'campaign:bbb' },
      { stage: 'campaign:ccc' },
      { stage: 'senders' },
    ])
    // Each campaign is its own stage, so only senders collapses.
    expect(groups).toHaveLength(4)
    const senders = groups.find((g) => g.stage === 'senders')
    expect(senders?.count).toBe(1)
  })

  it('groups an identical repeated stage with the right count', () => {
    const groups = groupStages([
      { stage: 'campaign:8ddf6580' },
      { stage: 'campaign:8ddf6580' },
      { stage: 'overview' },
    ])
    const campaign = groups.find((g) => g.stage === 'campaign:8ddf6580')
    expect(campaign?.count).toBe(2)
  })

  it('returns an empty list for no errors rather than a placeholder', () => {
    expect(groupStages([])).toEqual([])
  })

  it('keeps every known stage reachable', () => {
    for (const stage of KNOWN_STAGES) {
      expect(labelForStage(stage).known).toBe(true)
    }
  })
})

describe('GET /api/collection-errors', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports partial with the collector error labels', async () => {
    mockSupabase.limit.mockResolvedValue({
      data: [
        {
          collected_at: '2026-09-30T01:22:05Z',
          run_started_at: '2026-09-30T01:21:50Z',
          stage: 'senders',
          campaign_external_id: null,
          error: 'RuntimeError: malformed response',
          resolved: false,
        },
        {
          collected_at: '2026-09-30T01:21:53Z',
          run_started_at: '2026-09-30T01:21:50Z',
          stage: 'campaign:8ddf6580',
          campaign_external_id: '8ddf6580-...',
          error: 'HTTPError: 502',
          resolved: false,
        },
      ],
      error: null,
    })

    const res = await errorsGET(new Request('http://localhost/api/collection-errors?hours=24'))
    const d = await res.json()

    expect(d.partial).toBe(true)
    expect(d.unresolved_count).toBe(2)
    expect(d.last_attempt).toBe('2026-09-30T01:22:05Z')
    expect(d.stages.map((s: { label: string }) => s.label)).toContain('Sending accounts')
    // No stage key is ever used AS a label. The raw `stage` field stays in the
    // payload on purpose -- it is how a reader traces a banner back to the
    // collector call that failed -- but nothing renders it.
    for (const s of d.stages) {
      expect(s.label).not.toContain(':')
      expect(s.label).not.toContain('_')
    }
    expect(d.stages.map((s: { label: string }) => s.label)).not.toContain('campaign:8ddf6580')
  })

  it('reports not-partial when every error is resolved', async () => {
    mockSupabase.limit.mockResolvedValue({
      data: [
        {
          collected_at: '2026-09-29T01:00:00Z',
          run_started_at: '2026-09-29T00:59:00Z',
          stage: 'senders',
          campaign_external_id: null,
          error: 'HTTPError: 502',
          resolved: true,
        },
      ],
      error: null,
    })

    const res = await errorsGET(new Request('http://localhost/api/collection-errors'))
    const d = await res.json()
    expect(d.partial).toBe(false)
    expect(d.stages).toEqual([])
  })

  it('treats an empty table as unknown, not as healthy', async () => {
    // Nothing has ever run. That is not the same as "no failures".
    mockSupabase.limit.mockResolvedValue({ data: [], error: null })
    const res = await errorsGET(new Request('http://localhost/api/collection-errors'))
    const d = await res.json()
    expect(d.stages).toEqual([])
    expect(d.unresolved_count).toBe(0)
    expect(d.total_in_window).toBe(0)
    expect(d.last_attempt).toBeNull()
  })

  it('reports the error feed itself failing as partial with a null count', async () => {
    mockSupabase.limit.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const res = await errorsGET(new Request('http://localhost/api/collection-errors'))
    const d = await res.json()
    expect(res.status).toBe(500)
    expect(d.partial).toBe(true)
    expect(d.unresolved_count).toBeNull()
    expect(d.stages).toEqual([])
  })
})
