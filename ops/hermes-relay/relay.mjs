#!/usr/bin/env node
// Dashboard <-> Hermes relay (runs on the OVH box as a systemd user service). See README.md.
// Outbound only: listens to a private ntfy topic for wake-up pings, reads Hermes' feed from the
// dashboard, hands work to Hermes' own Runs API on 127.0.0.1, posts results back.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { makeRelay, parseNtfyLine, readEnvFile } from './lib.mjs'

const HOME = homedir()
const cfg = { ...process.env }
// Hermes' API key is read from Hermes' own .env (never copied anywhere).
if (!cfg.HERMES_API_KEY) {
  const f = cfg.HERMES_ENV_FILE || join(HOME, '.hermes/profiles/leaddesk/.env')
  if (existsSync(f)) cfg.HERMES_API_KEY = readEnvFile(readFileSync(f, 'utf8')).API_SERVER_KEY
}
cfg.AGENT_ID = cfg.AGENT_ID || 'hermes'
for (const k of ['DASHBOARD_URL', 'DASHBOARD_AGENT_KEY', 'NTFY_TOPIC', 'HERMES_API_KEY']) {
  if (!cfg[k]) {
    console.error(`missing ${k} (see README.md)`)
    process.exit(2)
  }
}
const NTFY = (cfg.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '')
const STATE_DIR = cfg.STATE_DIR || join(HOME, '.local/state/dashboard-relay')
mkdirSync(STATE_DIR, { recursive: true })
const STATE_FILE = join(STATE_DIR, 'state.json')
const FALLBACK_MS = Math.max(5, Number(cfg.FALLBACK_POLL_MINUTES || 60)) * 60_000

const log = (m) => console.log(`${new Date().toISOString()} ${m}`)
let state = { runs: {}, ntfy_since: null }
try {
  state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }
} catch {
  /* first start */
}
const saveState = (s) => {
  writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(s, null, 1))
  renameSync(`${STATE_FILE}.tmp`, STATE_FILE)
}
const exec = (bin, args) =>
  new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: 60_000, env: process.env }, (err, stdout, stderr) =>
      err ? reject(new Error(`${bin} ${args[0]} failed: ${String(stderr || err.message).slice(0, 300)}`)) : resolve(stdout),
    ),
  )

const relay = makeRelay({ fetch, exec, cfg, log, state, saveState })

let draining = false
let again = false
async function drainSoon(why) {
  if (draining) {
    again = true
    return
  }
  draining = true
  try {
    do {
      again = false
      const n = await relay.drain()
      if (n) log(`${why}: handled ${n}`)
    } while (again)
  } catch (e) {
    log(`drain (${why}) failed: ${e.message}`)
  } finally {
    draining = false
  }
}

async function listen() {
  let backoff = 1000
  for (;;) {
    try {
      const since = state.ntfy_since ? `?since=${encodeURIComponent(state.ntfy_since)}` : '?since=10m'
      const res = await fetch(`${NTFY}/${cfg.NTFY_TOPIC}/json${since}`)
      if (!res.ok || !res.body) throw new Error(`ntfy answered ${res.status}`)
      log('listening for pings')
      backoff = 1000
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true })
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          const p = parseNtfyLine(line)
          if (p?.isMessage) {
            if (p.id) {
              state.ntfy_since = p.id
              saveState(state)
            }
            void drainSoon('ping')
          }
        }
      }
      throw new Error('ntfy stream ended')
    } catch (e) {
      log(`${e.message}; reconnecting in ${Math.round(backoff / 1000)} s`)
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 60_000)
    }
  }
}

log(`relay up for ${cfg.AGENT_ID} -> ${cfg.DASHBOARD_URL}`)
void drainSoon('startup')
setInterval(() => void drainSoon('fallback poll'), FALLBACK_MS)
setInterval(() => void relay.checkRuns().catch((e) => log(`checkRuns: ${e.message}`)), 5_000)
void listen()
