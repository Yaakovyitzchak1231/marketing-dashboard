import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The one Vitest config for this repo (a second vitest.config.mts used to sit
// beside it with a different environment and setup file; Vitest only ever read
// vitest.config.ts, so the .mts one was dead config that disagreed with reality).
const root = path.dirname(fileURLToPath(import.meta.url))

// .mts so Vite loads it as ESM (a .ts config in a non-"type": "module"
// package goes through Vite's deprecated CJS loader and warns on every run).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': root },
  },
  test: {
    // Logic suites (*.test.ts) run in plain Node; component suites (*.test.tsx)
    // get a DOM automatically, so a new component test cannot silently run
    // without one. A per-file `@vitest-environment` docblock still wins.
    environment: 'node',
    environmentMatchGlobs: [['tests/**/*.test.tsx', 'jsdom']],
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup-dom.ts'],
    // Tests must never see a developer's real keys: no env file is loaded here,
    // and suites that need env vars set dummy values themselves.
    unstubEnvs: true,
  },
})
