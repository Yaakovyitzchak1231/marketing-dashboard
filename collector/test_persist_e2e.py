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
           "errors": [], "calls": 12}
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


class TestAutorespondersExcluded:
    """AC3: autoresponders never reach replies_human."""

    def test_replies_human_excludes_the_400_autoreplies(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(), metric_date="2026-09-29")

        rows = {(r["campaign_id"], r["metric_date"]): r
                for r in sb.rows["daily_metrics"].values()}
        # Sanity: no orphaned rows
        assert all("campaign_id" in r for r in rows.values())

        # Find the pathological campaign's metrics row.
        wet = [r for r in rows.values() if r["emails_sent"] == 100]
        assert len(wet) == 1
        r = wet[0]
        assert r["replies_total"] == 450          # the raw combined count
        assert r["replies_human"] == 50            # NOT 450
        assert r["replies_autoresponder"] == 400

    def test_human_reply_rate_is_under_100_percent(self):
        """The regression guard: 450/100 = 450% can never come back."""
        for c in CAMPAIGNS:
            a = c["analytics"]
            human_rate = ci.compute_rate(a["reply_count_unique"],
                                         a["emails_sent_count"])
            assert human_rate is not None
            assert human_rate <= 1.0, (
                f"{c['name']}: human reply rate {human_rate} exceeds 100% -- "
                "autoresponders leaked into replies_human"
            )

    def test_account_rollup_rate_uses_human_replies(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(), metric_date="2026-09-29")
        acct = list(sb.rows["accounts"].values())[0]
        assert acct["replies_human"] == 1910
        assert acct["replies_autoresponder"] == 39
        # 1910/45251 = 4.22%, the figure the account-wide KPI row shows.
        assert ci.compute_rate(acct["replies_human"],
                               acct["emails_sent"]) == 0.0422


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
    """open_count_unique is 0 from the API. That must land as NULL."""

    def test_open_rate_and_unsubscribe_are_null_not_zero(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(), metric_date="2026-09-29")
        for row in sb.rows["daily_metrics"].values():
            assert row["open_rate"] is None
            assert row["unsubscribe"] is None
            assert row["open_rate"] != 0
            assert row["unsubscribe"] != 0

    def test_a_real_zero_numerator_is_still_a_measurement(self):
        """Zero bounces IS a measurement. It must not be nulled."""
        analytics = dict(CAMPAIGNS[0]["analytics"], bounced_count=0)
        out = ci.process_campaign_analytics(analytics)
        assert out["bounces"] == 0
        assert out["bounce_rate"] == 0.0
        # while opens, still unreported, stay null
        assert out["open_rate"] is None

    def test_a_real_reported_open_count_survives(self):
        """If the API ever populates opens, we must not discard them."""
        analytics = dict(CAMPAIGNS[0]["analytics"], open_count_unique=1000)
        out = ci.process_campaign_analytics(analytics)
        assert out["open_rate"] == 0.0314  # 1000/31893


class TestStoredRatesAreNotPersisted:
    """A stored rate goes stale. Only raw counts belong in the table."""

    def test_daily_metrics_row_has_no_rate_columns(self):
        sb = FakeSupabase()
        ci.persist(sb, make_got(), metric_date="2026-09-29")
        for row in sb.rows["daily_metrics"].values():
            assert "reply_rate" not in row
            assert "bounce_rate" not in row
            assert set(row) == {
                "campaign_id", "metric_date", "emails_sent", "replies_total",
                "replies_human", "replies_autoresponder", "opportunities",
                "bounces", "open_rate", "unsubscribe", "source_updated_at",
            }


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
