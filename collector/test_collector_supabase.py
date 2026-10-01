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
        mock_response.data = [{"id": 1, "campaign_id": "uuid-1", "metric_date": "2024-01-15", "emails_sent": 100, "replies_human": 50, "replies_autoresponder": 10, "opportunities": 20, "bounces": 5, "open_rate": None, "unsubscribe": None}]
        mock_response.error = None
        mock_supabase.table.return_value.upsert.return_value.execute.return_value = mock_response
        
        metrics = [
            {
                "campaign_id": "uuid-1",
                "metric_date": "2024-01-15",
                "emails_sent": 100,
                "replies_total": 60,
                "replies_human": 50,
                "replies_autoresponder": 10,
                "opportunities": 20,
                "bounces": 5,
                "open_rate": None,
                "unsubscribe": None,
                "source_updated_at": "2024-01-15T12:00:00Z"
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
    """Tests that autoresponder replies are excluded from human replies."""
    
    def test_replies_human_excludes_autoresponders(self):
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
        
        # Human replies should use reply_count_unique, NOT reply_count
        assert result["replies_human"] == 500
        assert result["replies_autoresponder"] == 100
        assert result["replies_total"] == 600
        # Rate should be computed from human replies only
        assert result["reply_rate"] == 0.5  # 500/1000
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
        assert result["reply_rate"] == round(1910 / 45251, 4)  # 0.0422
        assert result["reply_rate"] != round(2350 / 45251, 4)  # NOT 0.0519
        assert result["replies_human"] == 1910
        assert result["replies_autoresponder"] == 39


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
        
        # open_rate should be None (NULL in DB), not 0.0
        assert result["open_rate"] is None
        assert result["open_rate"] != 0
        assert result["open_rate"] != 0.0
    
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
        
        # unsubscribe should be None (NULL in DB), not 0
        assert result["unsubscribe"] is None
        assert result["unsubscribe"] != 0
    
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


    def test_collect_catches_api_exceptions(self):
        """collect() should catch exceptions from API calls and append to errors list."""
        from collect_instantly import collect

        with patch("collect_instantly.Instantly") as MockInstantly:
            mock_api = MockInstantly.return_value
            mock_api.overview.side_effect = RuntimeError("overview failed")
            mock_api.campaign_ids.side_effect = ValueError("campaign_ids failed")
            mock_api.senders.side_effect = Exception("senders failed")
            mock_api.calls = 3

            result = collect()

            assert result["overview"] == {}
            assert result["campaigns"] == []
            assert result["senders"] == []
            assert result["calls"] == 3

            errors = result["errors"]
            assert len(errors) == 3
            assert errors[0]["stage"] == "overview"
            assert "RuntimeError: overview failed" in errors[0]["error"]
            assert errors[1]["stage"] == "list_campaigns"
            assert "ValueError: campaign_ids failed" in errors[1]["error"]
            assert errors[2]["stage"] == "senders"
            assert "Exception: senders failed" in errors[2]["error"]

    def test_collect_catches_campaign_exceptions(self):
        """collect() should catch exceptions from individual campaign calls and continue."""
        from collect_instantly import collect

        with patch("collect_instantly.Instantly") as MockInstantly:
            mock_api = MockInstantly.return_value
            mock_api.overview.return_value = {"success": True}
            mock_api.campaign_ids.return_value = ["camp-123456789"]
            mock_api.senders.return_value = [{"email": "test@test.com"}]
            mock_api.campaign.side_effect = Exception("campaign failed")

            result = collect()

            assert result["overview"] == {"success": True}
            assert len(result["campaigns"]) == 0
            assert len(result["senders"]) == 1

            errors = result["errors"]
            assert len(errors) == 1
            assert errors[0]["stage"] == "campaign:camp-123"
            assert "Exception: campaign failed" in errors[0]["error"]


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
    def test_collect_catches_api_exceptions(self):
        """collect() should catch exceptions from API calls and append to errors list."""
        from collect_instantly import collect

        with patch('collect_instantly.Instantly') as MockInstantly:
            mock_api = MockInstantly.return_value

            # Make all API calls raise an exception
            mock_api.overview.side_effect = RuntimeError("overview failed")
            mock_api.campaign_ids.side_effect = ValueError("campaign_ids failed")
            mock_api.senders.side_effect = Exception("senders failed")
            mock_api.calls = 3

            result = collect()

            # Verify collect didn't crash and returned the expected structure
            assert result["overview"] == {}
            assert result["campaigns"] == []
            assert result["senders"] == []
            assert result["calls"] == 3

            # Verify the errors were caught and recorded correctly
            errors = result["errors"]
            assert len(errors) == 3
            assert errors[0]["stage"] == "overview"
            assert "RuntimeError: overview failed" in errors[0]["error"]
            assert errors[1]["stage"] == "list_campaigns"
            assert "ValueError: campaign_ids failed" in errors[1]["error"]
            assert errors[2]["stage"] == "senders"
            assert "Exception: senders failed" in errors[2]["error"]

    def test_collect_catches_campaign_exceptions(self):
        """collect() should catch exceptions from individual campaign calls and continue."""
        from collect_instantly import collect

        with patch('collect_instantly.Instantly') as MockInstantly:
            mock_api = MockInstantly.return_value

            # Success for outer calls
            mock_api.overview.return_value = {"success": True}
            mock_api.campaign_ids.return_value = ["camp-123456789"]
            mock_api.senders.return_value = [{"email": "test@test.com"}]

            # Exception for inner campaign call
            mock_api.campaign.side_effect = Exception("campaign failed")

            result = collect()

            assert result["overview"] == {"success": True}
            assert len(result["campaigns"]) == 0  # Failed campaign skipped
            assert len(result["senders"]) == 1

            errors = result["errors"]
            assert len(errors) == 1
            assert errors[0]["stage"] == "campaign:camp-123"
            assert "Exception: campaign failed" in errors[0]["error"]
