'use client'

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { useId } from 'react'
import { cn } from './cn'
import { controlClass, labelClass, hintClass, selectClass } from './classes'

export { controlClass, labelClass, hintClass, selectClass }

/**
 * Label + control + hint. The label is a SIBLING of the control, tied by
 * htmlFor/id -- never a wrapper. Wrapping a <select> in its <label> made the
 * accessible name the label text plus every option's text
 * ("StageAnynewresearched..."), which is the bug this component exists to end.
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  optional,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  htmlFor: string
  className?: string
  optional?: boolean
  children: ReactNode
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className={labelClass}>
        {label}
        {optional ? <span className="ml-1 font-normal text-ink-faint">(optional)</span> : null}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-bad" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className={hintClass}>{hint}</p>
      ) : null}
    </div>
  )
}

type WithField = { label?: ReactNode; hint?: ReactNode; error?: ReactNode; optional?: boolean; wrapperClassName?: string }

export function Input({ label, hint, error, optional, wrapperClassName, id, className, ...props }: InputHTMLAttributes<HTMLInputElement> & WithField) {
  const auto = useId()
  const fid = id ?? auto
  const input = <input id={fid} className={cn(controlClass, className)} aria-invalid={error ? true : undefined} {...props} />
  if (!label) return input
  return (
    <Field label={label} hint={hint} error={error} optional={optional} htmlFor={fid} className={wrapperClassName}>
      {input}
    </Field>
  )
}

export function Textarea({ label, hint, error, optional, wrapperClassName, id, className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & WithField) {
  const auto = useId()
  const fid = id ?? auto
  const ta = <textarea id={fid} className={cn(controlClass, 'min-h-[5.5rem] leading-relaxed', className)} aria-invalid={error ? true : undefined} {...props} />
  if (!label) return ta
  return (
    <Field label={label} hint={hint} error={error} optional={optional} htmlFor={fid} className={wrapperClassName}>
      {ta}
    </Field>
  )
}

/**
 * A native select with a proper accessible name: pass `label` (rendered as a
 * sibling <label htmlFor>) or `aria-label`. Never wrap it in a <label>.
 */
export function Select({
  label,
  hint,
  error,
  optional,
  wrapperClassName,
  id,
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & WithField) {
  const auto = useId()
  const fid = id ?? auto
  const sel = (
    <select id={fid} className={cn(selectClass, className)} aria-invalid={error ? true : undefined} {...props}>
      {children}
    </select>
  )
  if (!label) return sel
  return (
    <Field label={label} hint={hint} error={error} optional={optional} htmlFor={fid} className={wrapperClassName}>
      {sel}
    </Field>
  )
}

export function Checkbox({
  label,
  description,
  id,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; description?: ReactNode }) {
  const auto = useId()
  const fid = id ?? auto
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input id={fid} type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 rounded border-line accent-accent max-md:h-5 max-md:w-5" {...props} />
      <div className="min-w-0">
        <label htmlFor={fid} className="block cursor-pointer text-sm text-ink">
          {label}
        </label>
        {description ? <p className="text-xs leading-snug text-ink-faint">{description}</p> : null}
      </div>
    </div>
  )
}

/** A titled group of fields inside a form (sectioned forms on phones). */
export function FieldGroup({ title, description, children, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <fieldset className={cn('min-w-0 border-0 p-0', className)}>
      <legend className="mb-0.5 text-sm font-semibold text-ink">{title}</legend>
      {description ? <p className="mb-3 text-xs text-ink-faint">{description}</p> : <div className="mb-3" />}
      <div className="grid gap-4">{children}</div>
    </fieldset>
  )
}
