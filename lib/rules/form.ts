/**
 * The Rules page's one form -> a rule document. Pure (no I/O) so it is tested
 * directly. Rows are req.<i>.* and fld.<i>.*, in on-screen order, plus one blank
 * "add" row each (req.new.*, fld.new.*) that is added when its field/name is filled.
 * `intent` moves or removes a row: req-up:<i>, req-down:<i>, req-del:<i> (same for fld).
 */
type Get = (k: string) => string

function rows(get: Get, prefix: string, count: number, keys: string[], blank: string) {
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    const r: Record<string, unknown> = {}
    for (const k of keys) r[k] = get(`${prefix}.${i}.${k}`)
    out.push(r)
  }
  const add: Record<string, unknown> = {}
  for (const k of keys) add[k] = get(`${prefix}.new.${k}`)
  if (String(add[blank] ?? '').trim()) out.push({ ...add, id: '' })
  return out
}

function move<T>(list: T[], intent: string, prefix: string): T[] {
  const m = new RegExp(`^${prefix}-(up|down|del):(\\d+)$`).exec(intent)
  if (!m) return list
  const i = Number(m[2])
  if (i < 0 || i >= list.length) return list
  const out = [...list]
  if (m[1] === 'del') out.splice(i, 1)
  else {
    const j = m[1] === 'up' ? i - 1 : i + 1
    if (j < 0 || j >= out.length) return list
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const REQ_KEYS = ['id', 'label', 'enabled', 'field', 'op', 'value', 'min_confidence', 'max_age_days']
const FLD_KEYS = ['id', 'name', 'source', 'required', 'fallback', 'min_confidence', 'max_age_days', 'enabled']

export function ruleDocFromForm(get: Get): { doc: { name: string; requirements: Record<string, unknown>[]; fields: Record<string, unknown>[] }; intent: string } {
  const intent = get('intent') || 'save'
  const n = (k: string) => Math.max(0, Math.min(100, Number(get(k)) || 0))
  const bool = (r: Record<string, unknown>, k: string) => {
    r[k] = r[k] === 'on' || r[k] === 'true' || r[k] === 'yes'
  }
  const reqs = rows(get, 'req', n('req.count'), REQ_KEYS, 'field').map((r) => {
    bool(r, 'enabled')
    return r
  })
  const flds = rows(get, 'fld', n('fld.count'), FLD_KEYS, 'name').map((r) => {
    bool(r, 'enabled')
    bool(r, 'required')
    return r
  })
  // A row added from the blank line starts enabled.
  if (reqs.length > n('req.count')) reqs[reqs.length - 1].enabled = true
  if (flds.length > n('fld.count')) flds[flds.length - 1].enabled = true
  return {
    doc: { name: get('name'), requirements: move(reqs, intent, 'req'), fields: move(flds, intent, 'fld') },
    intent,
  }
}
