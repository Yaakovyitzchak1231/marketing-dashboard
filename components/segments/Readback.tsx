'use client'

/** The plain-English readback underneath the builder -- the same string
 *  lib/segments/readback.ts computes server-side, shown as the person types. */
export function Readback({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p className="rounded-control border border-line bg-canvas px-3 py-2 text-sm italic text-ink-muted" data-testid="segment-readback">
      {text}
    </p>
  )
}
