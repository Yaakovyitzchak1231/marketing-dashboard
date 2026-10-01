import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    // Two environments in one run. The .test.ts suites are pure logic and want
    // `node`; the .test.tsx suites render components and need a DOM. Vitest
    // resolves this per file via the docblock convention below, so both live in
    // one project instead of two configs that can drift apart.
    environment: 'node',
    globals: true,
    /**
     * .tsx is included deliberately and was previously missing.
     *
     * The include pattern was tests only, ending in .test.ts, which silently
     * matched no component tests at all -- shell.test.tsx renders the freshness
     * indicator and asserts on data-stale, and it had never executed. Every
     * render-path rule this project claims to enforce was untested.
     */
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup-dom.ts'],
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})