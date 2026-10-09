/**
 * Browser-side helpers for pinning a comment to an element: a selector that finds the element
 * again, a short description of what it is and what it said, and where to draw the pin later.
 * Pure DOM code (no React), so it is tested in jsdom.
 */

export interface Anchor {
  selector: string | null
  anchor_label: string | null
  anchor_text: string | null
  off_x: number
  off_y: number
  x_pct: number
  y_pct: number
}

/** Marks the comment layer's own UI: clicks there are never "pick this element". */
export const UI_ATTR = 'data-comment-ui'

function esc(s: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS
  if (css?.escape) return css.escape(s)
  return s.replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`)
}
function attrValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Is this id stable enough to anchor to? React's useId (":r1:") and random-looking ids are not. */
function stableId(id: string): boolean {
  return !!id && !/^:|^radix-|^headlessui-|\d{4,}/.test(id) && id.length <= 80
}

function unique(doc: Document, sel: string, el: Element): boolean {
  try {
    const all = doc.querySelectorAll(sel)
    return all.length === 1 && all[0] === el
  } catch {
    return false
  }
}

/**
 * A CSS selector that finds this element again: an explicit data-comment-anchor, a stable id, a
 * data-testid, or else a short tag:nth-of-type path from the nearest anchorable ancestor.
 */
export function selectorFor(el: Element, doc: Document = el.ownerDocument): string | null {
  const parts: string[] = []
  let cur: Element | null = el
  for (let depth = 0; cur && depth < 14; depth++) {
    if (cur === doc.body || cur === doc.documentElement) break
    const anchor = cur.getAttribute('data-comment-anchor')
    if (anchor) {
      parts.unshift(`[data-comment-anchor="${attrValue(anchor)}"]`)
      break
    }
    if (stableId(cur.id) && unique(doc, `#${esc(cur.id)}`, cur)) {
      parts.unshift(`#${esc(cur.id)}`)
      break
    }
    const testId = cur.getAttribute('data-testid')
    if (testId && unique(doc, `[data-testid="${attrValue(testId)}"]`, cur)) {
      parts.unshift(`[data-testid="${attrValue(testId)}"]`)
      break
    }
    const tag = cur.tagName.toLowerCase()
    const parent: Element | null = cur.parentElement
    let seg = tag
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName)
      if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`
    }
    parts.unshift(seg)
    cur = parent
  }
  if (!parts.length) return null
  // Anchored at the body when the walk reached it, so the path cannot match somewhere else.
  const first = parts[0]
  const rooted = first.startsWith('#') || first.startsWith('[') ? parts.join(' > ') : `body > ${parts.join(' > ')}`
  return rooted.length <= 1000 && unique(doc, rooted, el) ? rooted : null
}

const ROLE: Record<string, string> = {
  a: 'link', button: 'button', input: 'field', textarea: 'text box', select: 'dropdown', img: 'image',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  td: 'table cell', th: 'column header', tr: 'table row', table: 'table', li: 'list item', label: 'label',
  nav: 'navigation', section: 'section', p: 'paragraph', svg: 'chart or icon', canvas: 'chart',
}

function squash(s: string | null | undefined, max: number): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** What he pointed at, in words: 'button "Send"', 'table cell', and its visible text (never a field's value). */
export function describe(el: Element): { anchor_label: string; anchor_text: string | null } {
  const tag = el.tagName.toLowerCase()
  const role = el.getAttribute('role') || ROLE[tag] || 'element'
  const aria = squash(el.getAttribute('aria-label'), 60)
  let name = aria
  if (!name && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
    name = squash(el.getAttribute('placeholder') || el.getAttribute('name'), 60)
  }
  if (!name && tag === 'img') name = squash(el.getAttribute('alt'), 60)
  // Field values can hold anything he typed (or a secret); never snapshot them.
  const isField = tag === 'input' || tag === 'textarea' || tag === 'select'
  const raw = isField ? '' : squash((el as HTMLElement).innerText ?? el.textContent, 300)
  if (!name && raw && raw.length <= 60 && (role === 'button' || role === 'link' || role === 'heading' || role === 'column header')) name = raw
  return { anchor_label: name ? `${role} "${name}"` : role, anchor_text: raw || null }
}

function docSize(doc: Document) {
  const d = doc.documentElement
  return { w: Math.max(d.scrollWidth, d.clientWidth, 1), h: Math.max(d.scrollHeight, d.clientHeight, 1) }
}
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

/** Everything needed to find the spot again, from the clicked element and the click point (viewport coordinates). */
export function anchorFor(el: Element, clientX: number, clientY: number): Anchor {
  const doc = el.ownerDocument
  const win = doc.defaultView ?? window
  const r = el.getBoundingClientRect()
  const { w, h } = docSize(doc)
  const d = describe(el)
  return {
    selector: selectorFor(el, doc),
    anchor_label: d.anchor_label,
    anchor_text: d.anchor_text,
    off_x: r.width > 0 ? clamp01((clientX - r.left) / r.width) : 0.5,
    off_y: r.height > 0 ? clamp01((clientY - r.top) / r.height) : 0.5,
    x_pct: clamp01((clientX + win.scrollX) / w),
    y_pct: clamp01((clientY + win.scrollY) / h),
  }
}

export interface PinSpot {
  x: number
  y: number
  /** false when the element is gone or hidden and the pin sits at its old spot on the page instead. */
  found: boolean
}

/** Where to draw a pin, in document coordinates. */
export function spotFor(
  c: { selector: string | null; off_x: number | null; off_y: number | null; x_pct: number | null; y_pct: number | null },
  doc: Document = document,
): PinSpot | null {
  const win = doc.defaultView ?? window
  if (c.selector) {
    let el: Element | null = null
    try {
      el = doc.querySelector(c.selector)
    } catch {
      el = null
    }
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 || r.height > 0) {
        return { x: r.left + win.scrollX + (c.off_x ?? 0.5) * r.width, y: r.top + win.scrollY + (c.off_y ?? 0.5) * r.height, found: true }
      }
    }
  }
  if (c.x_pct == null || c.y_pct == null) return null
  const { w, h } = docSize(doc)
  return { x: c.x_pct * w, y: c.y_pct * h, found: false }
}

/** Is this element part of the comment layer itself? */
export function inCommentUi(el: Element | null): boolean {
  return !!el?.closest?.(`[${UI_ATTR}]`)
}

/** The page's name as the nav shows it ("Leads"), else its first heading. */
export function pageTitle(doc: Document = document): string | null {
  const nav = doc.querySelector('nav [aria-current="page"]')
  const h1 = doc.querySelector('main h1, h1')
  const t = squash(nav?.textContent, 80) || squash(h1?.textContent, 80)
  return t || null
}
