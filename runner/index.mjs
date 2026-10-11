#!/usr/bin/env node
// The TapDash background job runner. Runs on Yaakov's OVH server as a
// systemd user service (see ../ops/runner/). Plain Node 22, zero npm
// dependencies: just `fetch` (global since Node 18). Logic lives in lib.mjs
// (tested in tests/jobs-runner.test.ts with a mocked fetch, no network and no
// real dashboard); this file is only env-reading and the poll loop, the same
// split as ops/hermes-relay/{relay.mjs,lib.mjs}.
//
// Loop: every POLL_SECONDS, POST /api/ops {op:'claim_jobs'} as actor 'system'
// (its own bearer key -- never Postgres directly: "the DB is the single
// source of truth; agents use the API, each with its own key"). Each claimed
// job runs its handler (runner/handlers/*.mjs, kind -> handler) under an
// AbortController timeout, then POSTs finish_job_run with the result.
//
// Env (see ../ops/runner/env.example):
//   DASHBOARD_URL   e.g. https://marketing-dashboard-xi-five.vercel.app
//   RUNNER_KEY      the 'system' actor's own ops API key (never logged)
//   RUNNER_ID       a stable id for this process, e.g. ovh-runner-1 (default: hostname:pid)
//   POLL_SECONDS    how often to check for due jobs (default 15)
//   CLAIM_LIMIT     how many due jobs to claim per poll (default 5)
import { hostname } from 'node:os'
import { loadHandlers } from './handlers/index.mjs'
import { makeOps, pollOnce } from './lib.mjs'

const DASHBOARD_URL = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '')
const RUNNER_KEY = process.env.RUNNER_KEY || ''
const RUNNER_ID = process.env.RUNNER_ID || `${hostname()}:${process.pid}`
const POLL_SECONDS = Math.max(5, Number(process.env.POLL_SECONDS) || 15)
const CLAIM_LIMIT = Math.max(1, Number(process.env.CLAIM_LIMIT) || 5)

function log(line) {
  // One line per event. Never log RUNNER_KEY or any secret the dashboard sends back.
  console.log(`${new Date().toISOString()} ${line}`)
}

if (!DASHBOARD_URL || !RUNNER_KEY) {
  log('missing DASHBOARD_URL or RUNNER_KEY -- see ops/runner/env.example. Exiting.')
  process.exit(2)
}

const ops = makeOps({ dashboardUrl: DASHBOARD_URL, runnerKey: RUNNER_KEY })
const handlers = await loadHandlers()
log(`loaded ${handlers.size} handler${handlers.size === 1 ? '' : 's'}: ${[...handlers.keys()].join(', ') || '(none)'}`)

let stopping = false
let inFlight = 0
process.on('SIGTERM', () => {
  log('SIGTERM received: finishing in-flight runs, then exiting (no new claims)')
  stopping = true
})
process.on('SIGINT', () => {
  log('SIGINT received: finishing in-flight runs, then exiting (no new claims)')
  stopping = true
})

log(`runner ${RUNNER_ID} starting, polling every ${POLL_SECONDS}s against ${DASHBOARD_URL}`)
while (!stopping) {
  try {
    const started = await pollOnce({ ops, handlers, runnerId: RUNNER_ID, claimLimit: CLAIM_LIMIT, log })
    inFlight = started.length
  } catch (e) {
    log(`poll failed: ${e.message}`)
  } finally {
    inFlight = 0
  }
  if (stopping) break
  await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000))
}
void inFlight
log('stopped')
process.exit(0)
