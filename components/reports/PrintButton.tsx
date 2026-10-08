'use client'

import { BUTTON } from '@/components/app/PageShell'

/** Opens the browser's print dialog; "Save as PDF" there makes the PDF. */
export function PrintButton({ label = 'Print / save as PDF' }: { label?: string }) {
  return (
    <button type="button" className={`${BUTTON} print:hidden`} onClick={() => window.print()}>
      {label}
    </button>
  )
}
