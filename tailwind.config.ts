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
/** A colour token backed by a CSS variable in app/globals.css. */
const v = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Every colour is a CSS variable from app/globals.css (space-separated
        // RGB channels), so light/dark themes swap in one place and opacity
        // modifiers (`bg-accent/10`) keep working. Do not add hex values here.
        canvas: v('canvas'), // page background
        surface: v('surface'), // cards, table header
        'surface-2': v('surface-2'), // rail, sunken panels, disabled fields
        paper: v('surface-2'),
        // Hairlines. `line` for structure, `line-soft` for interior division.
        line: v('line'),
        'line-soft': v('line-soft'),
        hairline: v('line-soft'),
        // Ink ramp: body, secondary, de-emphasised.
        ink: v('ink'),
        'ink-muted': v('ink-muted'),
        'ink-faint': v('ink-faint'),
        // THE accent. One colour, used sparingly.
        accent: v('accent'),
        'accent-strong': v('accent-strong'),
        'accent-soft': v('accent-soft'),
        'on-accent': v('on-accent'),
        // Unavailable / not-reported: a warm grey, never a red.
        unavailable: v('unavailable'),
        warn: v('warn'),
        'warn-soft': v('warn-soft'),
        good: v('good'),
        'good-soft': v('good-soft'),
        bad: v('bad'),
        'bad-soft': v('bad-soft'),
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
        // Figures use the same system face with tabular digits (set globally
        // in globals.css), so columns align digit-for-digit without the
        // code-editor look of a monospace face.
        numeric: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      fontSize: {
        // A restrained scale. No 7xl hero numbers.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        metric: ['1.75rem', { lineHeight: '2.1rem', letterSpacing: '-0.02em' }],
        'metric-sm': ['1.25rem', { lineHeight: '1.6rem', letterSpacing: '-0.01em' }],
      },
      borderRadius: {
        card: '12px',
        control: '8px',
        input: '8px',
        sheet: '16px',
      },
      boxShadow: {
        // Hairline-first: cards are defined by their border, not a drop shadow.
        card: '0 1px 2px rgb(var(--c-shadow) / 0.04)',
        raised: '0 1px 2px rgb(var(--c-shadow) / 0.06), 0 4px 12px rgb(var(--c-shadow) / 0.08)',
        overlay: '0 2px 6px rgb(var(--c-shadow) / 0.08), 0 16px 40px rgb(var(--c-shadow) / 0.18)',
      },
      spacing: {
        // Desktop side rail width (the main column is padded by the same amount).
        rail: '15rem',
        // Minimum touch target.
        tap: '2.75rem',
      },
      zIndex: {
        // Stacking order, low to high. The comment layer's pill sits at 50, so
        // sheets and the phone drawer (55) cover it; the view-only toast is 60.
        rail: '30',
        bar: '40',
        sheet: '55',
        palette: '65',
        toast: '70',
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
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'slide-in-up': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        shimmer: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
      },
      animation: {
        'fade-in': 'fade-in 240ms ease-out',
        'slide-in-right': 'slide-in-right 220ms cubic-bezier(0.32, 0.72, 0, 1)',
        'slide-in-up': 'slide-in-up 220ms cubic-bezier(0.32, 0.72, 0, 1)',
        shimmer: 'shimmer 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}

export default config
