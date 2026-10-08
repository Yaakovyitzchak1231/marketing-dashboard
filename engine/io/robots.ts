/**
 * robots.txt for a store's own site: the engine reads it once per host and
 * skips paths disallowed for all agents ("User-agent: *"). Unreachable or
 * missing robots.txt = allowed (the common reading of the standard).
 */
export interface Robots {
  allows(path: string): boolean
}

export function parseRobots(txt: string): Robots {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = []
  let cur: { agents: string[]; rules: { allow: boolean; path: string }[] } | null = null
  let lastWasAgent = false
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] }
        groups.push(cur)
      }
      cur.agents.push(val.toLowerCase())
      lastWasAgent = true
    } else if ((key === 'disallow' || key === 'allow') && cur) {
      lastWasAgent = false
      if (val) cur.rules.push({ allow: key === 'allow', path: val })
    } else lastWasAgent = false
  }
  const star = groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules)
  const toRe = (p: string) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'))
  const rules = star.map((r) => ({ ...r, re: toRe(r.path), len: r.path.length }))
  return {
    allows(path: string) {
      let best: { allow: boolean; len: number } | null = null
      for (const r of rules) if (r.re.test(path) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r
      return best ? best.allow : true
    },
  }
}

export const ALLOW_ALL: Robots = { allows: () => true }
