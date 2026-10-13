import Link from 'next/link'
import type { Db } from '@/lib/db/types'
import { Card } from '@/components/dashboard/primitives'
import { getProfile, ITEM_KINDS, type ItemKind } from '@/lib/campaign-profiles/store'

const KIND_WORDS: Record<ItemKind, { one: string; many: string }> = {
  keyword: { one: 'keyword', many: 'keywords' },
  topic: { one: 'topic', many: 'topics' },
  competitor: { one: 'competitor', many: 'competitors' },
  feed: { one: 'feed', many: 'feeds' },
  forum: { one: 'forum', many: 'forums' },
  directory: { one: 'directory', many: 'directories' },
  trade_show: { one: 'trade show', many: 'trade shows' },
  signal_rule: { one: 'signal rule', many: 'signal rules' },
  fingerprint: { one: 'fingerprint', many: 'fingerprints' },
  social_channel: { one: 'social channel', many: 'social channels' },
  negative_keyword: { one: 'negative keyword', many: 'negative keywords' },
  search_phrase: { one: 'search phrase', many: 'search phrases' },
  place_category: { one: 'place category', many: 'place categories' },
}

/** "Restaurants · 12 keywords · 5 competitors · 8 feeds · 3 signal rules" — shown on the campaign page. */
export async function ProfileSummaryCard({ db, campaignId }: { db: Db; campaignId: number }) {
  const { profile, items, exists } = await getProfile(db, campaignId)
  const counts = ITEM_KINDS.map((k) => ({ kind: k, n: items[k].filter((i) => i.status === 'approved').length })).filter((x) => x.n > 0)
  const totalItems = Object.values(items).reduce((n, list) => n + list.filter((i) => i.status === 'approved').length, 0)
  return (
    <Card className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <p className="min-w-0 truncate text-sm text-ink">
        {exists && profile.industry ? (
          <>
            <span className="font-medium text-ink">{profile.industry}</span>
            {counts.length ? (
              <>
                {' · '}
                {counts.map(({ kind, n }) => `${n} ${n === 1 ? KIND_WORDS[kind].one : KIND_WORDS[kind].many}`).join(' · ')}
              </>
            ) : (
              ' · no profile items approved yet'
            )}
          </>
        ) : (
          <span className="text-ink-faint">No campaign profile set up yet{totalItems ? ` (${totalItems} item${totalItems === 1 ? '' : 's'} pending)` : ''}.</span>
        )}
      </p>
      <Link href={`/campaigns/${campaignId}/profile`} className="shrink-0 text-xs text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
        {exists && profile.setup_status === 'active' ? 'Edit profile' : 'Set up profile'}
      </Link>
    </Card>
  )
}
