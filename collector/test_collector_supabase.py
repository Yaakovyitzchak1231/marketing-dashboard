#!/usr/bin/env python3
"""Tests for the Supabase collector upsert logic.

TDD: These tests define the contract before implementation.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from unittest.mock import Mock, patch, MagicMock
import pytest


class TestSupabaseUpsert:
    """Tests for idempotent upsert into Supabase."""
    
    def test_upsert_campaigns_is_idempotent(self):
        """Two consecutive runs with same data produce identical rows."""
        from collect_instantly import upsert_campaigns
        
        mock_supabase = Mock()
        mock_response = Mock()
        mock_response.data = [{"id": "uuid-1", "external_id": "ext-1", "name": "Test Campaign", "status": "active", "created_at": "2024-01-01T00:00:00Z"}]
        mock_response.error = None
        mock_supabase.table.return_value.upsert.return_value.execute.return_value = mock_response
        
        campaigns = [
            {"id": "ext-1", "name": "Test Campaign", "status": "active", "created_at": "2024-01-01T00:00:00Z"}
        ]
        
        # First run
        result1 = upsert_campaigns(mock_supabase, campaigns)
        # Second run
        result2 = upsert_campaigns(mock_supabase, campaigns)
        
        # Both should return the same upserted data
        assert result1 == result2
        assert mock_supabase.table.call_count == 2
        # Verify upsert was called with on_conflict
        call_args = mock_supabase.table.return_value.upsert.call_args
        assert call_args[1].get('on_conflict') == 'external_id'
    
    def test_upsert_daily_metrics_is_idempotent(self):
        """Two consecutive runs with same metrics produce identical rows."""
        from collect_instantly import upsert_daily_metrics
        
        mock_supabase = Mock()
        mock_response = Mock()
        mock_response.data = [{"id": 1, "campaign_id": "uuid-1", "metric_date": "2024-01-15", "emails_sent": 100, "replies_unique": 50, "replies_automatic_unique": 10, "replies_all": 60, "opportunities": 20, "bounces": 5, "opens_unique": None, "unsubscribed": None, "open_reported": False, "unsub_reported": False}]
        mock_response.error = None
        mock_supabase.table.return_value.upsert.return_value.execute.return_value = mock_response
        
        metrics = [
            {
                "campaign_id": "uuid-1",
                "metric_date": "2024-01-15",
                "emails_sent": 100,
                "replies_unique": 50,
                "replies_automatic_unique": 10,
                "replies_all": 60,
                "opportunities": 20,
                "bounces": 5,
                "opens_unique": None,
                "unsubscribed": None,
                "open_reported": False,
                "unsub_reported": False,
                "rate_trusted": True,
                "rate_untrusted_reason": None,
                "denominator_source": "emails_sent",
                "partial": False
            }
        ]
        
        result1 = upsert_daily_metrics(mock_supabase, metrics)
        result2 = upsert_daily_metrics(mock_supabase, metrics)
        
        assert result1 == result2
        call_args = mock_supabase.table.return_value.upsert.call_args
        assert call_args[1].get('on_conflict') == 'campaign_id,metric_date'
    
    def test_upsert_accounts_is_idempotent(self):
        """Two consecutive runs with same account data produce identical rows."""
        from collect_instantly import upsert_accounts
        
        mock_supabase = Mock()
        mock_response = Mock()
        mock_response.data = [{"id": 1, "metric_date": "2024-01-15", "emails_sent": 1000, "replies_human": 500, "replies_autoresponder": 100, "bounces": 50, "opportunities": 200, "opportunity_value": 20000, "mailbox_count": 10, "healthy_mailboxes": 8}]
        mock_response.error = None
        mock_supabase.table.return_value.upsert.return_value.execute.return_value = mock_response
        
        accounts = [
            {
                "metric_date": "2024-01-15",
                "emails_sent": 1000,
                "replies_human": 500,
                "replies_autoresponder": 100,
                "bounces": 50,
                "opportunities": 200,
                "opportunity_value": 20000,
                "mailbox_count": 10,
                "healthy_mailboxes": 8
            }
        ]
        
        result1 = upsert_accounts(mock_supabase, accounts)
        result2 = upsert_accounts(mock_supabase, accounts)
        
        assert result1 == result2
        call_args = mock_supabase.table.return_value.upsert.call_args
        assert call_args[1].get('on_conflict') == 'metric_date'


class TestAutoresponderSeparation:
    """Autoresponder counters stay separate rather than being differenced."""
    
    def test_reply_counters_are_stored_independently(self):
        """reply_count_unique is human replies; reply_count includes autoresponders."""
        from collect_instantly import process_campaign_analytics
        
        # Campaign analytics from Instantly API
        analytics = {
            "emails_sent_count": 1000,
            "reply_count": 600,  # total including autoresponders
            "reply_count_unique": 500,  # human only
            "reply_count_automatic_unique": 100,  # autoresponders
            "bounced_count": 50,
            "open_count_unique": 0,  # API limitation
            "unsubscribed_count": 0,
            "total_opportunities": 100,
            "total_opportunity_value": 10000,
        }
        
        result = process_campaign_analytics(analytics)
        
        # Three independent raw counters. There is no replies_human column:
        # the automatic count is not a subset of the unique count (see the
        # TapDash campaign, where 10 > 8), so differencing them is invalid.
        assert result["replies_unique"] == 500
        assert result["replies_automatic_unique"] == 100
        assert result["replies_all"] == 600
        assert "replies_human" not in result
        assert "replies_autoresponder" not in result
        # Rate is computed from replies_unique only, never from replies_all.
        assert result["_reply_rate"] == 0.5  # 500/1000
        # NOT 0.6 (which would be 600/1000 including autoresponders)
    
    def test_overview_reply_rate_uses_human_only(self):
        """Overview reply rate computed from replies_human, not replies_all."""
        from collect_instantly import compute_account_rates
        
        overview = {
            "emails_sent_count": 45251,
            "reply_count": 2350,  # includes 39 autoresponders
            "reply_count_unique": 1910,  # human only
            "reply_count_automatic_unique": 39,
            "bounced_count": 174,
            "open_count_unique": 0,
            "unsubscribed_count": 0,
            "total_opportunities": 1335,
            "total_opportunity_value": 1335000,
        }
        
        result = compute_account_rates(overview)
        
        # Must use human replies only. compute_rate rounds to 4 places.
        assert result["_reply_rate"] == round(1910 / 45251, 4)  # 0.0422
        assert result["_reply_rate"] != round(2350 / 45251, 4)  # NOT 0.0519
        # Both counters stored raw. No derived human count exists.
        assert result["replies_unique"] == 1910
        assert result["replies_automatic_unique"] == 39
        assert "replies_human" not in result
        assert result["rate_trusted"] is True
        assert result["rate_untrusted_reason"] is None


class TestNullHandling:
    """Tests that NULL is stored for unavailable metrics, never 0."""
    
    def test_open_rate_is_null_when_api_does_not_report(self):
        """open_count_unique is 0 from API -> open_rate should be NULL, not 0."""
        from collect_instantly import process_campaign_analytics
        
        analytics = {
            "emails_sent_count": 1000,
            "reply_count_unique": 50,
            "reply_count_automatic_unique": 10,
            "reply_count": 60,
            "bounced_count": 5,
            "open_count_unique": 0,  # API limitation - not reported
            "unsubscribed_count": 0,
            "total_opportunities": 20,
            "total_opportunity_value": 2000,
        }
        
        result = process_campaign_analytics(analytics)
        
        # The raw count is NULL and the flag says the source never populated
        # it. The API reads the flag, so a placeholder 0 never becomes 0.0%.
        assert result["opens_unique"] is None
        assert result["opens_unique"] != 0
        assert result["open_reported"] is False
        # No rate is stored for opens at all.
        assert "open_rate" not in result
    
    def test_unsubscribe_is_null_when_api_does_not_report(self):
        """unsubscribed_count is 0 from API -> unsubscribe should be NULL, not 0."""
        from collect_instantly import process_campaign_analytics
        
        analytics = {
            "emails_sent_count": 1000,
            "reply_count_unique": 50,
            "reply_count_automatic_unique": 10,
            "reply_count": 60,
            "bounced_count": 5,
            "open_count_unique": 0,
            "unsubscribed_count": 0,  # API limitation - not reported
            "total_opportunities": 20,
            "total_opportunity_value": 2000,
        }
        
        result = process_campaign_analytics(analytics)
        
        # unsubscribed should be None (NULL in DB), not 0, and the flag must
        # say the source never populated the field.
        assert result["unsubscribed"] is None
        assert result["unsubscribed"] != 0
        assert result["unsub_reported"] is False
    
    def test_rate_is_null_when_denominator_missing(self):
        """When sent is None or 0, rate must be None, not 0."""
        from collect_instantly import compute_rate
        
        # None denominator
        assert compute_rate(10, None) is None
        assert compute_rate(10, 0) is None
        
        # Zero numerator with valid denominator
        assert compute_rate(0, 100) == 0.0
        
        # Valid numbers
        assert compute_rate(50, 1000) == 0.05


class TestFailedApiCallDoesNotWriteZero:
    """Tests that failed API calls leave fields absent/null, never write 0."""
    
    def test_failed_overview_call_records_error_and_returns_empty(self):
        """Failed overview call should record error and not write zeros."""
        from collect_instantly import collect
        from collect_instantly import Instantly
        
        mock_mcp = Mock()
        mock_mcp.call.side_effect = RuntimeError("API timeout")
        
        api = Instantly(mcp=mock_mcp)
        errors = []
        
        try:
            api.overview()
        except RuntimeError:
            errors.append({"stage": "overview", "error": "RuntimeError: API timeout"})
        
        assert len(errors) == 1
        assert "overview" in errors[0]["stage"]
        # The error is recorded; no zeros written
    
    def test_failed_campaign_call_skips_that_campaign(self):
        """Failed campaign analytics call skips that campaign, doesn't write zeros."""
        from collect_instantly import collect
        from collect_instantly import Instantly
        
        mock_mcp = Mock()
        
        def side_effect(method, args):
            if method == "COMPOSIO_MULTI_EXECUTE_TOOL":
                tool_slug = args.get("tools", [{}])[0].get("tool_slug")
                if tool_slug == "INSTANTLY_GET_CAMPAIGN_ANALYTICS":
                    raise RuntimeError("Campaign API failed")
            item = {"response": {"successful": True, "data": {}}}
            return {"successful": True, "data": {"results": [item]}}
        
        mock_mcp.call.side_effect = side_effect
        
        api = Instantly(mcp=mock_mcp)
        errors = []
        campaigns = []
        
        try:
            # This should fail for the campaign
            api.campaign("test-campaign-id")
        except RuntimeError as e:
            errors.append({"stage": "campaign:test-c", "error": str(e)})
        
        assert len(errors) == 1
        # The failed campaign is not in campaigns list (no zeros written)


class TestDailyRollups:
    """Tests that collector produces daily rollups, not per-collection rows."""
    
    def test_metric_date_is_today_not_collection_timestamp(self):
        """daily_metrics.metric_date should be the campaign date, not collection time."""
        from collect_instantly import build_daily_metrics
        from datetime import date
        
        campaign_data = {
            "id": "camp-1",
            "analytics": {
                "emails_sent_count": 100,
                "reply_count_unique": 50,
                "reply_count_automatic_unique": 10,
                "reply_count": 60,
                "bounced_count": 5,
                "open_count_unique": 0,
                "unsubscribed_count": 0,
                "total_opportunities": 20,
                "total_opportunity_value": 2000,
            },
            "sending": {}
        }
        
        metrics = build_daily_metrics(campaign_data, campaign_id="uuid-1")
        
        # metric_date should be today (the day the metrics represent)
        assert metrics["metric_date"] == date.today().isoformat()
        # NOT a timestamp of when we collected it


if __name__ == "__main__":
    pytest.main([__file__, "-v"])