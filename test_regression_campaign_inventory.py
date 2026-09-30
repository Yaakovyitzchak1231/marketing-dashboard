#!/usr/bin/env python3
"""Regression test: campaign inventory must never be silently truncated.

This test FAILS if the collector returns fewer than the true campaign count
(verified via INSTANTLY_COUNT_LAUNCHED_CAMPAIGNS).
"""

import sys
sys.path.insert(0, "/home/hermes/.hermes/profiles/mkt-data/workspace/marketing-dashboard")
from composio_mcp import MCP
import collect_instantly


def test_campaign_inventory_not_truncated():
    """Collector must return ALL campaigns, not just the truncated preview."""
    mcp = MCP()
    api = collect_instantly.Instantly(mcp)

    # Ground truth: total campaigns from COUNT_LAUNCHED_CAMPAIGNS
    count_result = mcp.call('COMPOSIO_MULTI_EXECUTE_TOOL', {
        'tools': [{'tool_slug': 'INSTANTLY_COUNT_LAUNCHED_CAMPAIGNS', 'arguments': {'account': 'instantly_moline-parsec'}}]
    })
    true_count = count_result['data']['results'][0]['response']['data']['count']

    # What the collector actually returns
    collected_ids = api.campaign_ids()
    collected_count = len(collected_ids)

    print(f"True count (COUNT_LAUNCHED_CAMPAIGNS): {true_count}")
    print(f"Collected count (campaign_ids()): {collected_count}")
    print(f"Collected IDs: {collected_ids}")

    # This assertion is the regression guard
    assert collected_count == true_count, (
        f"CAMPAIGN INVENTORY TRUNCATED: collector returned {collected_count} "
        f"campaigns but true count is {true_count}. "
        f"The collector is reading from data_preview instead of the full remote file."
    )

    print("✓ Regression test PASSED: campaign inventory is complete")


if __name__ == '__main__':
    test_campaign_inventory_not_truncated()