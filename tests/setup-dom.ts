import '@testing-library/jest-dom/vitest'

/**
 * DOM setup for the component suites.
 *
 * `environment: jsdom` is applied per-file by the docblock in each `.tsx` suite
 * rather than globally, because the `.test.ts` suites are pure logic and jsdom
 * only slows them down. This file runs for every suite, so it must stay cheap:
 * jest-dom's matchers are the only thing loaded.
 */

// jsdom does not implement these, and the trend chart calls them on mount.
// Without the stubs a rendering test fails on a missing browser API rather
// than on the assertion it exists to make.
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }

  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }
}