import type { Config } from 'tailwindcss'

/**
 * Design tokens -- the single source of truth for the dashboard's look.
 *
 * @build-copy owns every rendered word; these tokens own everything else. The
 * naming here is deliberately semantic (surface / line / ink / accent) so copy
 * can be written against intent ("this is unavailable") without knowing the
 * colour system.
 *
 * DESIGN STANDARD (AGENTS.md, binding):
 *   Committed, light, de-slopped. Warm off-white, hairline borders, tabular
 *   figures, ONE restrained accent. No gradient mush, no emoji as decoration,
 *   no generic dashboard chrome, no AI-slop patterns.
 *
 * The accent is a single muted ink-blue. It is used for one thing at a time --
 * a selected range, an active tab, a link. It is never a background wash and
 * never a gradient.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm off-white surfaces. Not #fff -- pure white reads as clinical
        // and makes hairline borders disappear.
        canvas: '#faf9f7', // page background
        surface: '#ffffff', // cards, table header
        // Hairlines. Two weights: `line` for structure, `line-soft` for
        // interior division that should not compete with it.
        line: '#e3e0da',
        'line-soft': '#efede8',
        // Ink ramp. `ink` is body text, `ink-muted` is secondary,
        // `ink-faint` is for genuinely de-emphasised text.
        ink: '#1c1a17',
        'ink-muted': '#5f5a52',
        'ink-faint': '#8a847a',
        // THE accent. One colour, used sparingly.
        accent: '#2f5d8c',
        'accent-soft': '#eef2f7',
        // Unavailable / not-reported state. A warm grey, never a red:
        // a missing metric is not an error, it is an absence of data.
        unavailable: '#a8a29a',
        // Caution. Used only for a genuinely degraded value.
        warn: '#8a5a20',
      },
      fontFamily: {
        // System stack -- no webfont, no FOUT, no layout shift.
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        // Every figure uses this so columns align digit-for-digit.
        numeric: [
          'ui-monospace',
          'SFMono-Regular',
          'SF Mono',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      fontSize: {
        // A restrained scale. No 7xl hero numbers.
        metric: ['1.75rem', { lineHeight: '2.1rem', letterSpacing: '-0.02em' }],
        'metric-sm': ['1.25rem', { lineHeight: '1.6rem', letterSpacing: '-0.01em' }],
      },
      borderRadius: {
        card: '4px',
      },
      boxShadow: {
        // Hairline-first: cards are defined by their border, not a drop shadow.
        card: '0 1px 2px rgba(28, 26, 23, 0.04)',
      },
      maxWidth: {
        shell: '1200px',
      },
      screens: {
        // 390px is Jacob's phone. Tailwind's default `sm` (640) is too wide to
        // be the first breakpoint, so `xs` is defined explicitly for the
        // narrowest layout decisions.
        xs: '400px',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'fade-in': 'fade-in 240ms ease-out',
      },
    },
  },
  plugins: [],
}

export default config
