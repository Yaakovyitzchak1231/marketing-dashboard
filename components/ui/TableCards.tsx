'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Copies each table column header into its cells' `data-label`, so every
 * table in <main> collapses into labelled cards under 640px (CSS in
 * globals.css). Runs on navigation and whenever the DOM under <main> changes.
 */
export function labelTables(root: ParentNode): void {
  root.querySelectorAll<HTMLTableElement>('table:not([data-no-cards])').forEach((table) => {
    const heads = Array.from(table.querySelectorAll<HTMLTableCellElement>('thead tr:last-child th')).map((th) => (th.getAttribute('data-label') ?? th.textContent ?? '').trim())
    if (!heads.length) return
    table.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((tr) => {
      let col = 0
      Array.from(tr.cells).forEach((cell) => {
        if (!cell.hasAttribute('data-label')) cell.setAttribute('data-label', heads[col] ?? '')
        if (cell.querySelector(':scope > input[type="checkbox"]') && cell.children.length === 1 && !(cell.textContent ?? '').trim()) cell.setAttribute('data-cell', 'select')
        col += cell.colSpan || 1
      })
    })
  })
}

export function TableCards() {
  const pathname = usePathname()
  useEffect(() => {
    const main = document.querySelector('main')
    if (!main) return
    labelTables(main)
    if (typeof MutationObserver === 'undefined') return
    let raf = 0
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => labelTables(main))
    })
    mo.observe(main, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
    }
  }, [pathname])
  return null
}
