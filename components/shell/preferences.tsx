'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

/**
 * Per-browser UI preferences: theme and Review mode. Stored in localStorage;
 * nothing here touches the server.
 */
export type ThemePref = 'light' | 'dark' | 'system'

export const THEME_KEY = 'tapdash.theme'
export const REVIEW_KEY = 'tapdash.reviewMode'

interface Prefs {
  theme: ThemePref
  setTheme: (t: ThemePref) => void
  reviewMode: boolean
  setReviewMode: (on: boolean) => void
}

const Ctx = createContext<Prefs>({ theme: 'light', setTheme: () => {}, reviewMode: false, setReviewMode: () => {} })

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* private mode */
  }
}

export function applyTheme(t: ThemePref) {
  if (typeof document === 'undefined') return
  const dark = t === 'dark' || (t === 'system' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
}

/** Inline in <head> so the page paints in the right theme (no flash). */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}')||'light';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light')}catch(e){}`

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePref>('light')
  const [reviewMode, setReviewState] = useState(false)

  useEffect(() => {
    const t = read(THEME_KEY)
    if (t === 'light' || t === 'dark' || t === 'system') setThemeState(t)
    setReviewState(read(REVIEW_KEY) === '1')
  }, [])

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => applyTheme('system')
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [theme])

  const setTheme = useCallback((t: ThemePref) => {
    setThemeState(t)
    write(THEME_KEY, t)
  }, [])
  const setReviewMode = useCallback((on: boolean) => {
    setReviewState(on)
    write(REVIEW_KEY, on ? '1' : '0')
  }, [])

  return <Ctx.Provider value={{ theme, setTheme, reviewMode, setReviewMode }}>{children}</Ctx.Provider>
}

export function usePreferences(): Prefs {
  return useContext(Ctx)
}
