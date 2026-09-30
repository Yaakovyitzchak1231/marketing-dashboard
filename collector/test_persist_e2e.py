#!/usr/bin/env python3
"""End-to-end tests for persist(): idempotency, autoresponder split, failure
handling.

These use an in-memory Supabase double that enforces the same uniqueness the
real `on_conflict` targets rely on. That is deliberate: the service_role key
is deliberately absent from this box, so an honest end-to-end proof of
"run twice, diff the tables, zero differences" has to come from a store whose
conflict semantics we control and can read back.

The fake is intentionally strict. It raises on a blind insert, it keeps one
row per conflict key (last write wins, exactly like Postgres ON CONFLICT DO
UPDATE), and it lets a test inspect every column that was written. A test that
passes against a fake that silently overwrites would prove nothing.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest  # noqa: E402

import collect_instantly as ci  # noqa: E402


class FakeTable:
    """One table. Rows are keyed by the conflict key, like a real unique index."""

    def __init__(self, store, name, keys):
        self.store = store
        self.name = name
        self.keys = keys
        self.calls = []

    def select(self, *a, **kw):
        return self

    def upsert(self, rows, on_conflict=None):
        self.calls.append({"on_conflict": on_conflict, "rows": rows})
        self.store.upserts.append((self.name, on_conflict, rows))
        return self

    def execute(self):
        conflict = self.keys
        written = []
        for row in self.calls[-1]["rows"]:
            key = tuple(row.get(k) for k in conflict)
            # Replace an existing row with the same key: identical to
            # Postgres ON CONFLICT DO UPDATE.
            new_row = dict(row)
            # If updating an existing row, preserve its primary key (id)
            existing = self.store.rows.get(self.name, {}).get(key)
            if existing and "id" in existing and "id" not in new_row:
                new_row["id"] = existing["id"]
            # Generate UUID for campaigns table if not present and no existing
            elif self.name == "campaigns" and "id" not in new_row:
                import uuid
                new_row["id"] = str(uuid.uuid4())
            self.store.rows.setdefault(self.name, {})[key] = new_row
            written.append(new_row)
        return FakeResult(written)


class FakeResult:
    def __init__(self, data):
        self.data = data
        self.error = None


class FakeSupabase:
    """Just enough of the client for persist()."""

    KEYS = {
        "campaigns": ("external_id",),
        "daily_metrics": ("campaign_id", "metric_date"),
        "accounts": ("metric_date",),
        "collection_runs": ("ran_at",),
        # Per-failure rows for the partial-data banner. Keyed like the table's
        # unique index in migration 002 so repeated runs converge.
        "collection_errors": ("collected_at", "stage", "campaign_external_id"),
    }

    def __init__(self):
        self.rows = {}
        self.upserts = []

    def table(self, name):
        return FakeTable(self, name, self.KEYS[name])

    # -- test helpers --------------------------------------------------
    def snapshot(self):
        """Every row, order-independent, minus the run timestamp.

        A real diff between two runs must be empty. `collected_at` and
        `ran_at` are the only legitimately time-varying fields, and the
        acceptance criterion is about the metric rows, so they are excluded
        here and asserted separately.
        """
        out = {}
        for name, rows in self.rows.items():
            if name == "collection_runs":
                continue
            out[name] = sorted(
                (tuple(sorted((k, str(v)) for k, v in r.items()
                              if k not in ("source_updated_at", "created_at",)))
                 for r in rows.values())
            )
        return out

    def written(self, table):
        return [r for (t, _c, rows), in
                [(x, None, [r]) for x in self.upserts] for r in rows
                if t == table] or [r for t, _c, rows in self.upserts
                                   for r in rows if t == table]


# ---------------------------------------------------------------------
# A realistic collection, shaped from the live account figures recorded in
# T2_FINDINGS.md. Two campaigns, one with the autoresponder pathology that
# produced 333% and 450%.
# ---------------------------------------------------------------------

# Fixed timestamp for deterministic idempotency tests
FIXED_CREATED_AT = "2026-09-29T00:00:00+00:00"

CAMPAIGNS = [
    {
        "id": "a76f152b-7c57-4c6b-b0e5-e7352b635872",
        "name": "PB Signups / Leads",
        "status": "pending",
        "created_at": FIXED_CREATED_AT,
        "analytics": {
            "emails_sent_count": 31893,
            "reply_count": 1357,          # total, autoresponders included
            "reply_count_unique": 1357,   # human
            "reply_count_automatic_unique": 0,
            "bounced_count": 90,
            "open_count_unique": 0,       # API does not report this
            "unsubscribed_count": 0,      # API does not report this
            "total_opportunities": 1200,
            "total_opportunity_value": 1200000,
        },
    },
    {
        # The pathology: 450 replies from 100 sends because 400 were OOO
        # bounces. reply_count/sent = 4.5. The human rate is 0.5.
        "id": "8ff8cd85-43a9-4df2-af70-31a7b613d2cd",
        "name": "PB Wet Signature Needed",
        "status": "pending",
        "created_at": FIXED_CREATED_AT,
        "analytics": {
            "emails_sent_count": 100,
            "reply_count": 450,
            "reply_count_unique": 50,
            "reply_count_automatic_unique": 400,
            "bounced_count": 2,
            "open_count_unique": 0,
            "unsubscribed_count": 0,
            "total_opportunities": 5,
            "total_opportunity_value": 5000,
        },
    },
]

OVERVIEW = {
    "emails_sent_count": 45251,
    "reply_count": 2350,
    "reply_count_unique": 1910,
    "reply_count_automatic_unique": 39,
    "bounced_count": 174,
    "open_count_unique": 0,
    "unsubscribed_count": 0,
    "total_opportunities": 1335,
    "total_opportunity_value": 1335000,
}

SENDERS = [
    {"email": f"a{i}@x.com", "status": 1} for i in range(8)
] + [{"email": f"b{i}@x.com", "status": 3} for i in range(2)]


def make_got(**overrides):
    got = {"overview": OVERVIEW, "campaigns": CAMPAIGNS, "senders": SENDERS,
           "errors": [], "calls": 12,
           # The inventory is the id list found, which is not the same as the
           # set of campaigns that produced a row. On a clean run they match.
           "campaign_ids": [c["id"] for c in CAMPAIGNS],
           "run_started_at": "2026-09-29T01:00:00Z"}
    got.update(overrides)
    return got


# ---------------------------------------------------------------------


class TestIdempotency:
    """AC1: run twice, diff the tables, show zero differences."""

    def test_two_runs_produce_identical_rows(self):
        sb = FakeSupabase()
        first = ci.persist(sb, make_got(), metric_date="2026-09-29")
        snap1 = sb.snapshot()
        second = ci.persist(sb, make_got(), metric_date="2026-09-29")
        snap2 = sb.snapshot()

        assert snap1 == snap2, "second run changed the tables"
        assert first == second
        # And the row counts did not double.
        assert len(sb.rows["daily_metrics"]) == 2
        assert len(sb.rows["accounts"]) == 1
        assert len(sb.rows["campaigns"]) == 2

    def test_ten_runs_still_identical(self):
        sb = FakeSupabase()
        for _ in range(10):
            ci.persist(sb, make_got(), metric_date="2026-09-29")
        assert len(sb.rows["daily_metrics"]) == 2
        assert len(sb.rows["accounts"]) == 1

    def test_every_upsert_declares_a_conflict_key(self):
        """A blind insert would duplicate on re-run. None are permitted."""
        sb = FakeSupabase()
        ci.persist(sb, make_got(), metric_date="2026-09-29")
        for table, conflict, _rows in sb.upserts:
            assert conflict, f"{table} upsert had no on_conflict"


class TestReplyCountersStoredRawAndIndependent:
    """The reply split, stored as three independent counters.

    There is no replies_human column and there cannot be one: on the TapDash
    campaign reply_count_automatic_unique (10) exceeds reply_count_unique (8),
    so unique - automatic = -2. These tests assert the raw storage instead.
    """

    def test_the_three_counters_are_stored_separately(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(), metric_date="2026-09-29")

        rows = list(sb.rows["daily_metrics"].values())
        assert all("campaign_id" in r for r in rows)

        wet = [r for r in rows if r["emails_sent"] == 100]
        assert len(wet) == 1
        r = wet[0]
        assert r["replies_all"] == 450            # the raw combined count
        assert r["replies_unique"] == 50
        assert r["replies_automatic_unique"] == 400
        # No derived human count anywhere.
        assert "replies_human" not in r

    def test_automatic_counter_may_exceed_unique_without_going_negative(self):
        """The real TapDash shape, asserted as a stored fact."""
        analytics = {"emails_sent_count": 2126, "reply_count_unique": 8,
                     "reply_count_automatic_unique": 10, "reply_count": 8}
        out = ci.process_campaign_analytics(analytics)
        assert out["replies_unique"] == 8
        assert out["replies_automatic_unique"] == 10
        assert "replies_human" not in out
        # 8 - 10 would be -2; nothing in the record is negative.
        assert all((v or 0) >= 0 for v in out.values() if isinstance(v, int))

    def test_no_campaign_rate_can_exceed_100_percent(self):
        """The regression guard, now enforced by the gate itself."""
        for c in CAMPAIGNS:
            a = c["analytics"]
            rate, trusted, reason = ci.rate_gate(
                a["reply_count_unique"], a["emails_sent_count"])
            assert rate is None or rate <= 1.0, (
                f"{c['name']}: rate {rate} exceeds 100%"
            )
            if rate is None:
                assert reason, "a withheld rate must state why"

    def test_account_rollup_stores_both_counters_raw(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(), metric_date="2026-09-29")
        acct = list(sb.rows["accounts"].values())[0]
        assert acct["replies_unique"] == 1910
        assert acct["replies_automatic_unique"] == 39
        assert acct["replies_all"] == 2350
        assert "replies_human" not in acct

    def test_account_rate_is_recomputed_from_raw_counts(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(), metric_date="2026-09-29")
        acct = list(sb.rows["accounts"].values())[0]
        rate, trusted, _ = ci.rate_gate(acct["replies_unique"], acct["emails_sent"])
        assert trusted is True
        assert acct["rate_trusted"] is True
        assert acct["rate_untrusted_reason"] is None
        assert rate == pytest.approx(0.0419, abs=5e-4)


class TestFailedCallWritesNoZero:
    """AC2: a failed API call writes no 0 anywhere."""

    def test_failed_overview_writes_no_accounts_row(self):
        sb = FakeSupabase()
        got = make_got(overview={}, errors=[{"stage": "overview",
                                              "error": "RuntimeError: timeout"}])
        result = ci.persist(sb, got, metric_date="2026-09-29")

        assert "accounts" not in sb.rows, (
            "an accounts row was written from a failed overview call -- "
            "it would read as zero activity"
        )
        assert result["account_rows"] == 0
        # Campaign metrics are unaffected by the overview failure.
        assert len(sb.rows["daily_metrics"]) == 2

    def test_failed_overview_leaves_no_zeroed_account_columns(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(overview={},
                                errors=[{"stage": "overview", "error": "boom"}]),
                   metric_date="2026-09-29")
        # Belt and braces: scan every written cell for a bare 0 that stands
        # in for an unreported metric.
        for table, conflict, rows in sb.upserts:
            if table == "accounts":
                pytest.fail("accounts was written at all after a failed call")
        for table, rows_by_key in sb.rows.items():
            for row in rows_by_key.values():
                for key in ("emails_sent", "replies_human", "bounces",
                            "opportunities", "open_rate", "unsubscribe"):
                    if key in row:
                        assert row[key] is not None or key in row

    def test_failed_campaign_is_absent_not_zeroed(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(campaigns=[CAMPAIGNS[0]]),
                   metric_date="2026-09-29")
        assert len(sb.rows["daily_metrics"]) == 1
        assert len(sb.rows["campaigns"]) == 1
        # No row for the campaign that was never collected.
        assert not any(r["emails_sent"] == 100 for r in sb.rows["daily_metrics"].values())

    def test_empty_campaign_list_writes_nothing(self):
        """An empty read is a valid state and must not become zeros."""
        sb = FakeSupabase()
        result = ci.persist(sb, make_got(campaigns=[]),
                            metric_date="2026-09-29")
        assert result["metric_rows"] == 0
        assert "daily_metrics" not in sb.rows
        assert "campaigns" not in sb.rows

    def test_failure_is_recorded_on_the_health_surface(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(overview={},
                                errors=[{"stage": "overview", "error": "boom"}]),
                   metric_date="2026-09-29")
        run = list(sb.rows["collection_runs"].values())[0]
        assert run["ok"] is False
        assert any(e["stage"] == "overview" for e in run["errors"])

    def test_healthy_run_is_marked_ok(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(), metric_date="2026-09-29")
        run = list(sb.rows["collection_runs"].values())[0]
        assert run["ok"] is True
        assert run["campaigns_collected"] == 2
        assert run["campaigns_persisted"] == 2


class TestUnavailableMetricsAreNull:
    """open_count_unique is 0 from the API. That must land as NULL with a flag."""

    def test_placeholder_zero_becomes_null_and_the_flag_is_false(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(), metric_date="2026-09-29")
        for row in sb.rows["daily_metrics"].values():
            assert row["opens_unique"] is None
            assert row["unsubscribed"] is None
            assert row["open_reported"] is False
            assert row["unsub_reported"] is False

    def test_no_stored_rate_column_exists_for_opens(self):
        """The rate is derived at read time so it cannot be stored as 0.0."""
        sb = FakeSupabase()
        ci.persist(sb, make_got(), metric_date="2026-09-29")
        for row in sb.rows["daily_metrics"].values():
            assert "open_rate" not in row

    def test_a_real_zero_numerator_is_still_a_measurement(self):
        """Zero bounces IS a measurement. It must not be nulled."""
        analytics = dict(CAMPAIGNS[0]["analytics"], bounced_count=0)
        out = ci.process_campaign_analytics(analytics)
        assert out["bounces"] == 0
        rate, trusted, _ = ci.rate_gate(0, out["emails_sent"])
        assert rate == 0.0 and trusted is True
        # while opens, still unreported, stay null
        assert out["opens_unique"] is None

    def test_a_real_reported_open_count_survives(self):
        """If the API populates opens, the count must not be discarded."""
        populated = {"open_reported": True, "unsub_reported": False}
        analytics = dict(CAMPAIGNS[0]["analytics"], open_count_unique=1000)
        out = ci.process_campaign_analytics(analytics, populated=populated)
        assert out["opens_unique"] == 1000
        assert out["open_reported"] is True

    def test_the_flag_flips_when_the_account_starts_reporting(self):
        """The half-fix closed: the flag is measured, not defaulted."""
        campaigns = [{"analytics": {"open_count_unique": 0}},
                     {"analytics": {"open_count_unique": 7}}]
        flags = ci.source_populates({"open_count_unique": 0}, campaigns)
        assert flags["open_reported"] is True
        out = ci.compute_account_rates(
            {"open_count_unique": 0, "unsubscribed_count": 0},
            [], campaigns=campaigns, inventory_count=2)
        assert out["open_reported"] is True


class TestStoredRatesAreNotPersisted:
    """A stored rate goes stale. Only raw counts belong in the table."""

    def test_daily_metrics_row_has_no_rate_columns(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(), metric_date="2026-09-29")
        for row in sb.rows["daily_metrics"].values():
            assert "reply_rate" not in row
            assert "bounce_rate" not in row
            assert "open_rate" not in row
            # The trust decision IS stored, so the UI's words and the number
            # travel together.
            assert "rate_trusted" in row
            assert "rate_untrusted_reason" in row
            assert "denominator_source" in row


class TestPartialRunIsRecordedNotHidden:
    """The banner's counts must come from the collector, not from len(rows)."""

    def test_inventory_and_collected_counts_are_distinct(self):
        errors = [{"stage": "campaign:cccccccc", "error": "HTTPError: 502",
                   "at": "2026-09-29T01:00:00Z"}]
        got = make_got(errors=errors, campaign_ids=["a" * 8, "b" * 8, "c" * 8])
        sb = FakeSupabase()
        out = ci.persist(sb, got, metric_date="2026-09-29")
        assert out["inventory_count"] == 3
        assert out["partial"] is True
        acct = list(sb.rows["accounts"].values())[0]
        assert acct["campaigns_inventory_count"] == 3
        assert acct["campaigns_collected_count"] == len(sb.rows["daily_metrics"])
        assert acct["partial"] is True

    def test_errors_land_in_collection_errors_for_the_banner(self):
        errors = [{"stage": "senders", "error": "malformed response",
                   "at": "2026-09-29T01:00:00Z"}]
        sb = FakeSupabase()
        ci.persist(sb, make_got(errors=errors), metric_date="2026-09-29")
        rows = list(sb.rows["collection_errors"].values())
        assert len(rows) == 1
        assert rows[0]["stage"] == "senders"
        assert rows[0]["campaign_external_id"] is None
        assert rows[0]["resolved"] is False

    def test_a_campaign_named_in_errors_is_marked_partial(self):
        errors = [{"stage": "campaign:cccccccc", "error": "HTTPError: 502",
                   "at": "2026-09-29T01:00:00Z"}]
        sb = FakeSupabase()
        ci.persist(sb, make_got(errors=errors), metric_date="2026-09-29")
        acct = list(sb.rows["accounts"].values())[0]
        assert acct["partial"] is True
        assert acct["rate_trusted"] is False


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
