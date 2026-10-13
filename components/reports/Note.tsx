/** The one-line result of the last action (?note=&tone= from a server action redirect). */
export function ActionNote({ note, tone }: { note?: string | string[]; tone?: string | string[] }) {
  const text = Array.isArray(note) ? note[0] : note
  if (!text) return null
  const bad = (Array.isArray(tone) ? tone[0] : tone) === 'bad'
  return (
    <p role="status" className={`mb-4 rounded-card border px-3 py-2 text-sm print:hidden ${bad ? 'border-bad/30 bg-bad-soft text-bad' : 'border-good/30 bg-good-soft text-good'}`}>
      {text}
    </p>
  )
}
