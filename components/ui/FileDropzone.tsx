'use client'

import { useId, useRef, useState, type DragEvent } from 'react'
import { UploadCloud, FileText, X } from 'lucide-react'
import { cn } from './cn'

/**
 * A styled drop zone around a real <input type="file">, so it still posts
 * with its form (server actions read it by `name`). Click, keyboard or drop.
 */
export function FileDropzone({
  name,
  accept,
  label = 'Drop a file here, or browse',
  hint,
  id,
  className,
  onFile,
}: {
  name: string
  accept?: string
  label?: string
  hint?: string
  id?: string
  className?: string
  onFile?: (f: File | null) => void
}) {
  const auto = useId()
  const fid = id ?? auto
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [over, setOver] = useState(false)

  const pick = (f: File | null) => {
    setFile(f)
    onFile?.(f)
  }
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files?.[0]
    if (!f || !input.current) return
    const dt = new DataTransfer()
    dt.items.add(f)
    input.current.files = dt.files
    pick(f)
  }

  return (
    <div className={className}>
      <label
        htmlFor={fid}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-card border border-dashed px-4 py-6 text-center transition-colors focus-within:ring-2 focus-within:ring-accent/30',
          over ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2 hover:border-ink-faint/60',
        )}
      >
        {file ? <FileText aria-hidden="true" className="h-5 w-5 text-accent" /> : <UploadCloud aria-hidden="true" className="h-5 w-5 text-ink-faint" />}
        <span className="text-sm font-medium text-ink">{file ? file.name : label}</span>
        <span className="text-xs text-ink-faint">{file ? `${Math.max(1, Math.round(file.size / 1024))} KB` : hint}</span>
        <input
          ref={input}
          id={fid}
          type="file"
          name={name}
          accept={accept}
          className="sr-only"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
      </label>
      {file ? (
        <button
          type="button"
          onClick={() => {
            if (input.current) input.current.value = ''
            pick(null)
          }}
          className="mt-1.5 inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" /> Remove file
        </button>
      ) : null}
    </div>
  )
}
