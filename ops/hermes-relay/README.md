# Dashboard ↔ Hermes relay

A small Node service on Yaakov's OVH server (Hermes' box). It connects Hermes to the marketing
dashboard through event-driven wake-ups, without opening any inbound port:

```
Yaakov assigns / messages Hermes on the dashboard
  → dashboard pings an ntfy topic (only an id; actual latency depends on the provider)
  → relay (outbound HTTPS stream to ntfy) wakes, reads Hermes' feed: GET /api/ops/feed (Hermes' own key)
  → claims the task, starts a Hermes run: POST http://127.0.0.1:8643/v1/runs   (Hermes' Runs API,
    configured in the leaddesk profile; deterministic idempotency keys per event/attempt)
  → acks the event (dashboard shows "delivered")
  → when the run finishes: complete_task / fail_task with Hermes' output (or a reply message)

Safety rules (built into lib.mjs, tested in tests/hermes-relay.test.ts):
- Only `assigned`, `handoff`, `mention` and `message` events start a run; `task_update`, `approval`
  and anything else are acknowledged and logged only.
- Only senders listed in RUN_FROM (default `owner,tab`) start a run; others are acked + logged.
- Hermes can answer an allowed agent's request once: a reply goes to a person as a message, onto the
  task thread as a comment, or onto a pinned page comment as a reply. On a task thread, agent
  @mentions are defused but `@owner` (a known human, from `list_actors`) is kept, so escalating to a
  person still works. An agent's DM with no task gets one reply marked `no_reply: true`; the server
  records that as an `auto_reply`, and the relay acks `auto_reply` events without running them — so
  cooperating updated clients do not ping-pong. Other clients must honor the same marker.
- A pinned page comment (`page_comment_id` on the event) is answered with `page_comment_reply`, not
  a DM, so the answer lands in the pin's thread.
- All dashboard text reaches Hermes inside one clearly labeled untrusted block.
- Run starts use notification-scoped idempotency keys; interrupted recovery uses a new attempt key.
  The last 1,000 finished events are also deduplicated locally. This is not an exactly-once guarantee.
Agent → Yaakov pings: the dashboard queues a "relay" item for Hermes → relay runs
  `hermes send -t whatsapp "<text>"` (Hermes' own WhatsApp sender, no LLM) → ack.
  Held over Shabbos by the dashboard (per-person setting, default on).
```

Why this shape (research: `hermes_integration_research_oct9.md`): the Runs API is the intake Hermes'
docs name for outside programs and dashboards, and the only one that returns Hermes' answer to the
caller. No Hermes config change, no Hermes restart, no Hermes code patch. ntfy (open source, free,
no account required on the public service) carries only wake-up ids; the content is read from the dashboard with Hermes' key.
An unguessable topic is not access control: use protected self-hosted transport for sensitive deployments.
A missed ping is caught by a fallback poll every 60 min. Already-persisted pending work is checked by
the 5-second run timer, with a 2-minute delay between start retries.

Files: `relay.mjs` (service), `lib.mjs` (logic, tested in `tests/hermes-relay.test.ts`),
`dashboard-relay.service` (systemd user unit), `env.example`.

## Install (only after Yaakov's OK and the matching server release)

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

Test with approval: assign a small task to Hermes on the dashboard. Record the timestamps for
claim, acknowledgement and report; do not infer receipt from channel configuration alone.

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
- State (runs, pending starts, recently finished events, ntfy cursor) lives in
  `~/.local/state/dashboard-relay/state.json`. A returned task claim is persisted **before**
  attempting a run. A 429 re-offer reuses that claim instead of claiming again. The relay sends
  `claim_attempt` on heartbeat / complete_task / fail_task. Before a start, poll or restart, the
  claim must be verified; a temporary heartbeat error defers work, not authorizes it.
- The remote claim and local state file are not atomic. If a claim response or its initial state
  write is lost, operator reconciliation may be needed. Run only one relay process per state file.
  In-process checks/drains are serialized; this is not a distributed lock.
- Start requests are bounded to three failures. Stop/failure reporting remains in state until it
  succeeds. Pending starts are serviced without waiting for another feed wake-up.
- A run interrupted by a Hermes restart — or one Hermes no longer knows (404) — is started again with
  a deterministic idempotency key, at most 3 attempts; its state is kept until the restart succeeds.
  If the restart keeps failing, or the task lease is lost, the relay stops instead of starting more
  work: the task is marked failed with `retry: false` (or a comment is posted) so a person sees it,
  never a silent requeue. Stopping relay work does not cancel an already-running Hermes request;
  inspect it before re-queuing. A lost status/response cannot prove an external side effect did not happen.
- Deploy with the server supporting `claim_attempt`, `page_comment_id`, `no_reply` and `auto_reply`.
  The relay's response posting is at-least-once: a lost acknowledgement can duplicate a comment or
  message. Exactly-once posting needs server-side idempotency, not just a local state file.
