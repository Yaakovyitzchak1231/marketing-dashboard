// Phase 2 review (#87 finding 1, Instinct write-up A): every exported server action in
// app/actions/ must check the caller's role (actorFor / requireRole) or be a listed read.
// Reads the source text, so no mocks. It found the campaigns actions writing as
// 'owner' with no role check; those now call actorFor('editor').
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'app', 'actions')

/**
 * Exported server actions that may run without actorFor()/requireRole().
 * Key = `file.ts:exportName`. Every entry needs a reason, and only reads belong
 * here: they change nothing. Viewers cannot call any server action at all
 * (middleware.ts refuses every mutating request from a viewer, and a server
 * action is always a POST), so an entry here is reachable by Editors and Owners only.
 */
const ALLOW: Record<string, string> = {
  'campaign-profiles.ts:getProfileAction': 'read',
  'campaign-profiles.ts:aiConfiguredAction': 'read: is the AI key set',
  'campaign-profiles.ts:verifyFeedAction': 'read: fetches a feed URL to check it, stores nothing',
  'campaign-profiles.ts:approvedItemsAction': 'read',
  'campaign-profiles.ts:listPoolsAction': 'read',
  'edit.ts:entityHistoryAction': 'read',
  'leads-import.ts:parseCsvAction': 'read: parses the uploaded text, no database',
  'merge.ts:mergeCandidatesAction': 'read: lists candidates; mergeAction is owner-gated',
  'segments.ts:listFieldsAction': 'read',
  'segments.ts:listCampaignsForPickerAction': 'read',
  'segments.ts:listPresetsAction': 'read',
  'segments.ts:aiConfiguredAction': 'read',
  'segments.ts:previewSegmentAction': 'read: counts and samples, saves nothing',
  'segments.ts:listSegmentsAction': 'read',
  'segments.ts:getSegmentAction': 'read',
  'segments.ts:segmentMembersAction': 'read',
  'settings.ts:listActorKindsForSettings': 'read',
  'traits.ts:previewTraitAction': 'read: validates and redirects to a preview URL',
  'traits.ts:computePreviewFromQuery': 'read: computes values for 5 sample rows, saves nothing',
}

/** Actions gated at viewer on purpose. They must be reads; anything that writes needs editor or owner. */
const VIEWER_READS: Record<string, string> = {
  'page-comments.ts:listMyCommentsAction': "read: the caller's own comments",
  'pools.ts:poolsPageRole': 'read: whether the signed-in person is an owner, so the pools page can hide owner buttons',
}

/** Split a file into [name, body] for each `export async function name(...) { ... }`. */
function exportedActions(src: string): { name: string; body: string }[] {
  const re = /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g
  const hits: { name: string; start: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) hits.push({ name: m[1], start: m.index })
  return hits.map((h, i) => ({ name: h.name, body: src.slice(h.start, i + 1 < hits.length ? hits[i + 1].start : src.length) }))
}

const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f))

describe("every 'use server' action checks the caller's role", () => {
  it('finds the action files (guards against the glob silently matching nothing)', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  for (const file of files) {
    const src = readFileSync(join(DIR, file), 'utf8')
    if (!/^\s*['"]use server['"]/m.test(src.slice(0, 400))) continue
    for (const { name, body } of exportedActions(src)) {
      const key = `${file}:${name}`
      it(`${key} calls actorFor(...) or requireRole(...)`, () => {
        if (ALLOW[key]) return
        const gated = /\bactorFor\(\s*['"](viewer|editor|owner)['"]\s*\)/.test(body) || /\brequireRole\(/.test(body)
        expect(gated, `${key} is a server action with no role check. Add \`const ME = await actorFor('editor'|'owner')\` as its first statement, or add it to ALLOW with a reason.`).toBe(true)
      })
    }
  }

  it('ALLOW has no stale entries', () => {
    const all = new Set<string>()
    for (const file of files) for (const a of exportedActions(readFileSync(join(DIR, file), 'utf8'))) all.add(`${file}:${a.name}`)
    for (const k of Object.keys(ALLOW)) expect(all.has(k), `${k} is in ALLOW but no longer exists`).toBe(true)
  })

  it('VIEWER_READS has no stale entries', () => {
    const all = new Set<string>()
    for (const file of files) for (const a of exportedActions(readFileSync(join(DIR, file), 'utf8'))) all.add(`${file}:${a.name}`)
    for (const k of Object.keys(VIEWER_READS)) expect(all.has(k), `${k} is in VIEWER_READS but no longer exists`).toBe(true)
  })

  it('only the listed reads are gated at viewer (a viewer cannot write)', () => {
    for (const file of files) {
      const src = readFileSync(join(DIR, file), 'utf8')
      for (const { name, body } of exportedActions(src)) {
        const key = `${file}:${name}`
        if (ALLOW[key] || VIEWER_READS[key]) continue
        expect(/actorFor\(\s*['"]viewer['"]\s*\)/.test(body), `${key} gates on viewer, which cannot write. Use editor or owner, or list it in VIEWER_READS if it only reads.`).toBe(false)
      }
    }
  })
})
