/**
 * Portable campaign-profile documents (plan 1.16).
 *
 * Export is the shape import accepts. Competitors are items of kind
 * `competitor` — there is no separate registry table (folded into
 * lp.campaign_profile_items by design). Import never overwrites a live
 * item and always records source 'import'. Verification stamps are not
 * copied: a check that passed on another campaign is not proof here.
 */
import type { Db, Queryable } from '../db/types.ts'
import {
  ProfileError,
  addItems,
  getProfile,
  parseProfileItem,
  parseProfilePatch,
  upsertProfile,
  type CampaignProfile,
  type ItemInput,
  type ItemKind,
  type ItemStatus,
  type ProfileItem,
  type ProfilePatch,
} from './store.ts'

export interface ProfileDocumentItem {
  kind: ItemKind
  name: string
  value: string | null
  config: Record<string, unknown>
  status: ItemStatus
  rationale: string | null
  sort: number
}

export interface ProfileDocument {
  profile: Pick<CampaignProfile, 'industry' | 'vertical' | 'description' | 'icp' | 'value_prop' | 'newsletter_list' | 'utm' | 'kpis' | 'setup_status'>
  items: ProfileDocumentItem[]
}

export interface ValidatedDocument {
  profile: ProfilePatch | null
  items: ItemInput[]
}

const DOC_KEYS = new Set(['profile', 'items'])

/** Check a document without writing. Unknown top-level keys are refused. */
export function validateProfileDocument(body: unknown): ValidatedDocument {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProfileError('Send {profile?, items?} as JSON.')
  const b = body as Record<string, unknown>
  for (const k of Object.keys(b)) {
    if (!DOC_KEYS.has(k)) throw new ProfileError(`${k} can't be set on a profile document.`)
  }
  let profile: ProfilePatch | null = null
  if (b.profile != null) {
    if (typeof b.profile !== 'object' || Array.isArray(b.profile)) throw new ProfileError('profile must be an object.')
    if (Object.keys(b.profile as object).length) profile = parseProfilePatch(b.profile)
  }
  const items: ItemInput[] = []
  if (b.items != null) {
    if (!Array.isArray(b.items)) throw new ProfileError('items must be a list.')
    if (b.items.length > 500) throw new ProfileError('At most 500 items at a time.')
    b.items.forEach((v, i) => items.push(parseItemForImport(v, i)))
  }
  if (!profile && !items.length) throw new ProfileError('Nothing to validate.')
  return { profile, items }
}

/** Same item checks as add. Caller source and verify stamps are dropped. */
function parseItemForImport(v: unknown, i: number): ItemInput {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ProfileError(`items[${i}] must be an object.`)
  const b = { ...(v as Record<string, unknown>) }
  delete b.source
  delete b.verify_status
  delete b.verify_detail
  const parsed = parseProfileItem({ ...b, source: 'import' }, i)
  return { ...parsed, source: 'import' }
}

export async function exportProfileDocument(db: Queryable, campaignId: number): Promise<{ exists: boolean } & ProfileDocument> {
  const got = await getProfile(db, campaignId)
  const items: ProfileDocumentItem[] = []
  for (const list of Object.values(got.items)) {
    for (const it of list) items.push(toDocItem(it))
  }
  items.sort((a, b) => a.kind.localeCompare(b.kind) || a.sort - b.sort || a.name.localeCompare(b.name))
  return {
    exists: got.exists,
    profile: {
      industry: got.profile.industry,
      vertical: got.profile.vertical,
      description: got.profile.description,
      icp: got.profile.icp,
      value_prop: got.profile.value_prop,
      newsletter_list: got.profile.newsletter_list,
      utm: got.profile.utm,
      kpis: got.profile.kpis,
      setup_status: got.profile.setup_status,
    },
    items,
  }
}

function toDocItem(it: ProfileItem): ProfileDocumentItem {
  return {
    kind: it.kind,
    name: it.name,
    value: it.value,
    config: it.config,
    status: it.status,
    rationale: it.rationale,
    sort: it.sort,
  }
}

export interface ImportResult {
  profile: CampaignProfile | null
  added: ProfileItem[]
  already: { kind: ItemKind; name: string }[]
}

/** Merge a document into a campaign. Existing live items are left alone. */
export async function importProfileDocument(db: Db, actor: string, campaignId: number, body: unknown): Promise<ImportResult> {
  const doc = validateProfileDocument(body)
  let profile: CampaignProfile | null = null
  if (doc.profile) profile = await upsertProfile(db, actor, campaignId, doc.profile)
  else await getProfile(db, campaignId)
  if (!doc.items.length) return { profile, added: [], already: [] }
  // addItems re-parses each object and treats a present-but-empty verify_status as invalid.
  // Drop those keys so a validated item (source forced to import) round-trips.
  const items = doc.items.map((it) => ({
    kind: it.kind,
    name: it.name,
    value: it.value ?? null,
    config: it.config ?? {},
    status: it.status,
    source: 'import' as const,
    rationale: it.rationale ?? null,
    sort: it.sort,
  }))
  const added = await addItems(db, actor, campaignId, items, 'import')
  return { profile, added: added.added, already: added.already }
}
