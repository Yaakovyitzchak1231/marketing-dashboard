import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET as overviewGET } from '@/app/api/overview/route'
import { GET as campaignsGET } from '@/app/api/campaigns/route'
import { GET as trendGET } from '@/app/api/campaigns/[id]/trend/route'

// Mock Supabase client
const mockSupabase = {
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  gte: vi.fn().mockReturnThis(),
  lte: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  single: vi.fn(),
  inner: vi.fn().mockReturnThis()
}

vi.mock('@/lib/supabase', () => ({
  supabase: mockSupabase
}))

describe('API Layer - Null Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /api/overview', () => {
    it('returns null for all metrics when no data exists', async () => {
      mockSupabase.single.mockResolvedValue({ data: null, error: { code: 'PGRST116' } })
      
      const request = new Request('http://localhost/api/overview?range=7d')
      const response = await overviewGET(request)
      const data = await response.json()
      
      expect(data.emails_sent).toBeNull()
      expect(data.replies_human).toBeNull()
      expect(data.replies_autoresponder).toBeNull()
      expect(data.bounces).toBeNull()
      expect(data.opportunities).toBeNull()
      expect(data.opportunity_value).toBeNull()
      expect(data.mailbox_count).toBeNull()
      expect(data.healthy_mailboxes).toBeNull()
      expect(data.reply_rate).toBeNull()
      expect(data.bounce_rate).toBeNull()
    })

    it('returns null for rates when sent is 0 or null', async () => {
      mockSupabase.single.mockResolvedValue({
        data: {
          emails_sent: 0,
          replies_human: 5,
          replies_autoresponder: 2,
          bounces: 1,
          opportunities: 10,
          opportunity_value: 1000,
          mailbox_count: 5,
          healthy_mailboxes: 4
        },
        error: null
      })
      
      const request = new Request('http://localhost/api/overview?range=7d')
      const response = await overviewGET(request)
      const data = await response.json()
      
      expect(data.emails_sent).toBe(0)
      expect(data.replies_human).toBe(5)
      expect(data.reply_rate).toBeNull()  // 0 sent -> null rate
      expect(data.bounce_rate).toBeNull()  // 0 sent -> null rate
    })

    it('returns null for open_rate and unsubscribe when API does not provide them', async () => {
      mockSupabase.single.mockResolvedValue({
        data: {
          emails_sent: 1000,
          replies_human: 50,
          replies_autoresponder: 10,
          bounces: 5,
          opportunities: 20,
          opportunity_value: 2000,
          mailbox_count: 5,
          healthy_mailboxes: 4
        },
        error: null
      })
      
      const request = new Request('http://localhost/api/overview?range=7d')
      const response = await overviewGET(request)
      const data = await response.json()
      
      // These are not even in the accounts table - they should be null
      expect(data.open_rate).toBeNull()
      expect(data.unsubscribe).toBeNull()
    })

    it('computes reply_rate from raw counts, never averages', async () => {
      mockSupabase.single.mockResolvedValue({
        data: {
          emails_sent: 1000,
          replies_human: 50,
          replies_autoresponder: 10,
          bounces: 5,
          opportunities: 20,
          opportunity_value: 2000,
          mailbox_count: 5,
          healthy_mailboxes: 4
        },
        error: null
      })
      
      const request = new Request('http://localhost/api/overview?range=7d')
      const response = await overviewGET(request)
      const data = await response.json()
      
      // 50/1000 = 0.05
      expect(data.reply_rate).toBe(0.05)
      // Should NOT be 0.06 (which would be (50+10)/1000 - wrong, includes autoresponders)
      expect(data.reply_rate).not.toBe(0.06)
    })
  })

  describe('GET /api/campaigns', () => {
    it('returns null for missing metrics in daily_metrics', async () => {
      mockSupabase.single.mockResolvedValue({
        data: [
          {
            id: 'camp-1',
            external_id: 'ext-1',
            name: 'Campaign 1',
            status: 'active',
            created_at: '2024-01-01T00:00:00Z',
            daily_metrics: [{
              metric_date: '2024-01-15',
              emails_sent: 100,
              replies_total: 10,
              replies_human: 8,
              replies_autoresponder: 2,
              opportunities: 5,
              bounces: 2,
              open_rate: null,  // API doesn't provide
              unsubscribe: null  // API doesn't provide
            }]
          }
        ],
        error: null
      })
      
      const request = new Request('http://localhost/api/campaigns?range=7d')
      const response = await campaignsGET(request)
      const data = await response.json()
      
      expect(data.campaigns[0].open_rate).toBeNull()
      expect(data.campaigns[0].unsubscribe).toBeNull()
    })

    it('never coerces null to 0 for rates', async () => {
      mockSupabase.single.mockResolvedValue({
        data: [{
          id: 'camp-1',
          external_id: 'ext-1',
          name: 'Campaign 1',
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
          daily_metrics: [{
            metric_date: '2024-01-15',
            emails_sent: 100,
            replies_total: 10,
            replies_human: null,  // Missing
            replies_autoresponder: null,
            opportunities: null,
            bounces: null,
            open_rate: null,
            unsubscribe: null
          }]
        }],
        error: null
      })
      
      const request = new Request('http://localhost/api/campaigns?range=7d')
      const response = await campaignsGET(request)
      const data = await response.json()
      
      expect(data.campaigns[0].reply_rate).toBeNull()
      expect(data.campaigns[0].bounce_rate).toBeNull()
      expect(data.campaigns[0].replies_human).toBeNull()
      expect(data.campaigns[0].bounces).toBeNull()
    })
  })

  describe('GET /api/campaigns/[id]/trend', () => {
    it('returns null for open_rate and unsubscribe in trend data', async () => {
      mockSupabase.single.mockResolvedValue({
        data: {
          id: 'camp-1',
          external_id: 'ext-1',
          name: 'Campaign 1',
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
          daily_metrics: [
            {
              metric_date: '2024-01-14',
              emails_sent: 50,
              replies_total: 5,
              replies_human: 4,
              replies_autoresponder: 1,
              opportunities: 2,
              bounces: 1,
              open_rate: null,
              unsubscribe: null
            },
            {
              metric_date: '2024-01-15',
              emails_sent: 60,
              replies_total: 6,
              replies_human: 5,
              replies_autoresponder: 1,
              opportunities: 3,
              bounces: 0,
              open_rate: null,
              unsubscribe: null
            }
          ]
        },
        error: null
      })
      
      const params = Promise.resolve({ id: 'camp-1' })
      const request = new Request('http://localhost/api/campaigns/camp-1/trend?range=7d')
      const response = await trendGET(request, { params })
      const data = await response.json()
      
      expect(data.trend[0].open_rate).toBeNull()
      expect(data.trend[0].unsubscribe).toBeNull()
      expect(data.trend[1].open_rate).toBeNull()
      expect(data.trend[1].unsubscribe).toBeNull()
    })

    it('computes daily rates from raw counts per day', async () => {
      mockSupabase.single.mockResolvedValue({
        data: {
          id: 'camp-1',
          external_id: 'ext-1',
          name: 'Campaign 1',
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
          daily_metrics: [
            {
              metric_date: '2024-01-14',
              emails_sent: 100,
              replies_total: 10,
              replies_human: 8,
              replies_autoresponder: 2,
              opportunities: 5,
              bounces: 2,
              open_rate: null,
              unsubscribe: null
            }
          ]
        },
        error: null
      })
      
      const params = Promise.resolve({ id: 'camp-1' })
      const request = new Request('http://localhost/api/campaigns/camp-1/trend?range=7d')
      const response = await trendGET(request, { params })
      const data = await response.json()
      
      // 8/100 = 0.08
      expect(data.trend[0].reply_rate).toBe(0.08)
      // 2/100 = 0.02
      expect(data.trend[0].bounce_rate).toBe(0.02)
    })
  })
})