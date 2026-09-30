#!/usr/bin/env python3
"""Contract tests: the collector's columns must match migration 002 exactly.

@build-qa caught the real failure mode for T4: the e2e suite passed because it
used a fake Supabase with the collector's own column names, so a schema
mismatch was invisible to every test in the repo. These tests close that gap by
parsing migration 002 and diffing it against what the row builders actually
write.

A test that runs the collector and checks it against itself proves nothing.
These run the collector and check it against the migration.
"""
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import collect_instantly as ci  # noqa: E402

MIGRATION = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "supabase", "migrations", "002_reply_counter_correction.sql",
)

# Columns the database supplies or that Supabase keys on. The collector must
# not write them, and their absence from a row is not a defect.
DB_OWNED = {
    "id", "collected_at", "metric_date", "campaign_id",
    "source_updated_at", "created_at",
}


def migration_columns(table: str) -> set:
    sql = open(MIGRATION).read()
    m = re.search(rf"CREATE TABLE (?:IF NOT EXISTS )?{table} \((.*?)\n\);", sql, re.S)
    assert m, f"{table} not found in migration 002"
    cols = set()
    for line in m.group(1).split("\n"):
        line = line.strip()
        if not line or line.startswith("--"):
            continue
        c = re.match(r"([a-z_][a-z0-9_]*)\s+"
                     r"(int|text|boolean|numeric|date|bigserial|uuid|timestamptz)", line)
        if c:
            cols.add(c.group(1))
    return cols


class TestDailyMetricsMatchesMigration:
    def test_no_column_outside_the_migration(self):
        row = ci.build_daily_metrics({"analytics": {}}, "camp-uuid")
        written = set(row) - DB_OWNED
        extra = written - migration_columns("daily_metrics")
        assert not extra, (
            f"collector writes columns absent from migration 002: {sorted(extra)}. "
            f"Every upsert would fail with 'column does not exist'."
        )

    def test_every_column_is_written(self):
        """A column the collector never fills is dead schema or a silent gap."""
        row = ci.build_daily_metrics({"analytics": {}}, "camp-uuid")
        written = set(row) - DB_OWNED
        missing = migration_columns("daily_metrics") - DB_OWNED - written
        assert not missing, f"migration columns never written by the collector: {sorted(missing)}"

    def test_no_derived_human_reply_column(self):
        """The reason replies_human cannot exist. See migration 002."""
        row = ci.build_daily_metrics({"analytics": {}}, "camp-uuid")
        assert "replies_human" not in row
        assert "replies_autoresponder" not in row
        assert "replies_total" not in row
        for col in ("replies_unique", "replies_automatic_unique", "replies_all"):
            assert col in row

    def test_stores_raw_counts_not_computed_rates(self):
        row = ci.build_daily_metrics({"analytics": {}}, "camp-uuid")
        assert "reply_rate" not in row
        assert "bounce_rate" not in row
        assert "open_rate" not in row
        assert "opens_unique" in row


class TestAccountsMatchesMigration:
    def _row(self):
        return {k: v for k, v in ci.compute_account_rates(
            {}, [], campaigns=[], inventory_count=8).items()
            if not k.startswith("_")}

    def test_no_column_outside_the_migration(self):
        extra = set(self._row()) - DB_OWNED - migration_columns("accounts")
        assert not extra, f"accounts upsert writes unknown columns: {sorted(extra)}"

    def test_writes_the_inventory_counts(self):
        """The partial-data banner's numbers, or copy has nothing to render."""
        row = self._row()
        assert row["campaigns_inventory_count"] == 8
        assert "campaigns_collected_count" in row

    def test_mailbox_counts_are_null_when_senders_failed(self):
        """A failed LIST_ACCOUNTS must not read as 'zero mailboxes'."""
        row = ci.compute_account_rates({"emails_sent_count": 10}, [],
                                        campaigns=[], inventory_count=1)
        assert row["mailbox_count"] is None
        assert row["healthy_mailboxes"] is None


class TestReportFlagsAreMeasured:
    """Bug 3. open_reported must be observed, not defaulted."""

    def test_false_when_every_campaign_reports_zero_opens(self):
        campaigns = [{"analytics": {"open_count_unique": 0}} for _ in range(8)]
        flags = ci.source_populates({"open_count_unique": 0}, campaigns)
        assert flags["open_reported"] is False

    def test_true_once_any_campaign_reports_a_nonzero_count(self):
        """The day Instantly starts populating opens, this flips automatically."""
        campaigns = [{"analytics": {"open_count_unique": 0}},
                     {"analytics": {"open_count_unique": 5}}]
        flags = ci.source_populates({"open_count_unique": 0}, campaigns)
        assert flags["open_reported"] is True

    def test_placeholder_zero_becomes_null_when_unpopulated(self):
        assert ci._reported(0, populated=False) is None

    def test_real_zero_survives_once_the_source_populates(self):
        """A genuine 0 opens is a measurement and must not be nulled."""
        assert ci._reported(0, populated=True) == 0

    def test_nonzero_survives_regardless(self):
        assert ci._reported(1000, populated=False) == 1000
        assert ci._reported(1000, populated=True) == 1000


class TestRateGateSuppressesImpossibleRates:
    """The 450% and 333% campaigns, by their real numbers."""

    @pytest.mark.parametrize("replies,sent,expected", [
        (9, 2, ci.REASON_NUMERATOR_EXCEEDS),     # IRS Penalty Back, 450%
        (10, 3, ci.REASON_NUMERATOR_EXCEEDS),    # PB Signups TEST, 333%
    ])
    def test_impossible_rates_are_withheld_with_a_reason(self, replies, sent, expected):
        rate, trusted, reason = ci.rate_gate(replies, sent)
        assert rate is None
        assert trusted is False
        assert reason == expected

    @pytest.mark.parametrize("num,den", [(9, 2), (10, 3), (1357, 464), (1000, 999)])
    def test_no_computed_rate_ever_exceeds_one(self, num, den):
        rate, _, _ = ci.rate_gate(num, den)
        assert rate is None or rate <= 1

    def test_valid_campaigns_still_compute(self):
        rate, trusted, reason = ci.rate_gate(1357, 31893)
        assert rate == 0.0425
        assert trusted is True and reason is None

    def test_account_rate_is_valid(self):
        rate, trusted, _ = ci.rate_gate(1910, 45545)
        assert rate == 0.0419
        assert trusted is True

    def test_zero_denominator_is_no_sends_not_zero_rate(self):
        rate, trusted, reason = ci.rate_gate(0, 0)
        assert rate is None and reason == ci.REASON_NO_SENDS

    def test_partial_row_withholds_its_rate(self):
        """Valid arithmetic, but not a measurement of the campaign."""
        rate, trusted, reason = ci.rate_gate(100, 1000, partial=True)
        assert rate is None and trusted is False
        assert reason == ci.REASON_PARTIAL

    def test_collector_error_stage_is_the_reason(self):
        rate, _, reason = ci.rate_gate(None, None,
                                       error_reason="campaign:8ddf6580")
        assert reason == "campaign:8ddf6580"

    def test_rate_and_trust_flag_are_stored_together(self):
        """The flag and the number ship in one row so they cannot disagree."""
        row = ci.process_campaign_analytics(
            {"emails_sent_count": 2, "reply_count_unique": 9})
        assert row["_reply_rate"] is None
        assert row["rate_trusted"] is False
        assert row["rate_untrusted_reason"] == ci.REASON_NUMERATOR_EXCEEDS
        assert row["denominator_source"] == "emails_sent"


class TestStageKeysMatchTheT3Map:
    """The banner labels and the collector's stage strings must stay aligned."""

    def test_every_stage_the_collector_emits_has_a_label(self):
        stages = set(re.findall(r'_err\((?:f?)"([^"]+)"',
                                open(ci.__file__).read()))
        prefixes = {s.split(":")[0] for s in stages}
        ts = open(os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), "lib", "stages.ts")).read()
        mapped = set(re.findall(r"^\s{2}(\w+):\s*'", ts, re.M))
        assert prefixes <= mapped, (
            f"collector emits stages with no label in lib/stages.ts: "
            f"{sorted(prefixes - mapped)}"
        )

    def test_failed_campaign_ids_are_extracted_from_stage_strings(self):
        errs = [{"stage": "campaign:8ddf6580"}, {"stage": "senders"}]
        assert ci._failed_campaign_ids(errs) == {"8ddf6580"}
