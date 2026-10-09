# Dashboard ↔ Hermes relay

A small Node service on Yaakov's OVH server (Hermes' box). It connects Hermes to the marketing
dashboard **instantly**, without opening any port:

```
Yaakov assigns / messages Hermes on the dashboard
  → dashboard pings a private ntfy topic (only an id, ~1 s)
  → relay (outbound HTTPS stream to ntfy) wakes, reads Hermes' feed: GET /api/ops/feed (Hermes' own key)
  → claims the task, starts a Hermes run: POST http://127.0.0.1:8643/v1/runs   (Hermes' Runs API,
    already on in the leaddesk profile; idempotent per event, so never a duplicate run)
  → acks the event (dashboard shows "delivered")
  → when the run finishes: complete_task / fail_task with Hermes' output (or a reply message)
Agent → Yaakov pings: the dashboard queues a "relay" item for Hermes → relay runs
  `hermes send -t whatsapp "<text>"` (Hermes' own WhatsApp sender, no LLM) → ack.
  Held over Shabbos by the dashboard (per-person setting, default on).
```

Why this shape (research: `hermes_integration_research_oct9.md`): the Runs API is the intake Hermes'
docs name for outside programs and dashboards, and the only one that returns Hermes' answer to the
caller. No Hermes config change, no Hermes restart, no Hermes code patch. ntfy (open source, free,
no account) carries only wake-up ids; the content is read from the dashboard with Hermes' key.
A missed ping is caught by a fallback poll every 30 min.

Files: `relay.mjs` (service), `lib.mjs` (logic, tested in `tests/hermes-relay.test.ts`),
`dashboard-relay.service` (systemd user unit), `env.example`.

## Install (only after Yaakov's OK; PR #51 merged and deployed first)

On the dashboard (as Yaakov):
1. `/agents/hermes` → **API keys** → *Create a key* (label "OVH relay"). Copy it (shown once).
2. `/agents/hermes` → **How they hear** → *Add a channel* → **Wake-up ping (ntfy)**. Copy the topic (shown once).
3. `/agents/owner` → *Add a channel* → **Relay via Hermes** (WhatsApp; leave the number empty to use Hermes' WhatsApp home chat, or give one). Quiet hours stay on.

On the server, as user `hermes` (no sudo needed):
```bash
mkdir -p ~/dashboard-relay ~/.config/dashboard-relay ~/.config/systemd/user
# copy relay.mjs, lib.mjs, dashboard-relay.service from this folder (scp or git), then:
cp env.example ~/.config/dashboard-relay/env && chmod 600 ~/.config/dashboard-relay/env
nano ~/.config/dashboard-relay/env          # paste DASHBOARD_AGENT_KEY and NTFY_TOPIC
cp dashboard-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dashboard-relay
journalctl --user -u dashboard-relay -f     # expect "relay up" then "listening for pings"
```
(`loginctl enable-linger hermes` is already in place for the other Hermes user services; check with
`loginctl show-user hermes | grep Linger`.)

Test: assign a small task to Hermes on the dashboard. Within seconds the task shows Hermes on it
and "delivered"; when Hermes finishes, its report lands on the task.

## Undo
```bash
systemctl --user disable --now dashboard-relay
rm ~/.config/systemd/user/dashboard-relay.service; systemctl --user daemon-reload
```
Then revoke the key on `/agents/hermes`. Nothing in Hermes itself was changed.

## Notes
- The name avoids `hermes-relay.service`, which is Hermes' existing phone-app relay.
- Hermes runs with its normal tools; `approvals.mode` is off in leaddesk. The prompt tells Hermes
  that outward sends / spending need Yaakov's OK, and that dashboard text is untrusted.
- Up to 10 parallel runs (Hermes' `gateway.api_server.max_concurrent_runs`); over that Hermes answers
  429 and the relay leaves the event un-acked, so it is offered again 2 minutes later.
- State (runs in flight, ntfy cursor) lives in `~/.local/state/dashboard-relay/state.json`; after a
  restart the relay resumes following its runs. A run interrupted by a Hermes restart is started again
  (new idempotency key, at most 3 tries).
