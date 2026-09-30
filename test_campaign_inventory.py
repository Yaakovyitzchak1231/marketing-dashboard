#!/usr/bin/env python3
"""Test that the campaign inventory is complete (not truncated)."""

import sys
sys.path.insert(0, "/home/hermes/.hermes/profiles/mkt-data/workspace/marketing-dashboard")
from composio_mcp import MCP

def test_campaign_inventory_complete():
    """Test that we can retrieve all 8 campaigns, not just 2."""
    mcp = MCP()
    
    # Call the list campaigns endpoint
    result = mcp.call('COMPOSIO_MULTI_EXECUTE_TOOL', {
        'tools': [{'tool_slug': 'INSTANTLY_LIST_CAMPAIGNS', 'arguments': {'account': 'instantly_moline-parsec', 'limit': 100}}]
    })
    
    # The response has data_preview (truncated) and remote_file_info
    # We need to read the remote file for full data using COMPOSIO_REMOTE_BASH_TOOL
    remote_file = result['data'].get('remote_file_info', {}).get('file_path')
    assert remote_file, f"Remote file path not found in response: {result}"
    
    # Read the full data from the remote file using COMPOSIO_REMOTE_BASH_TOOL
    bash_result = mcp.call('COMPOSIO_REMOTE_BASH_TOOL', {
        'command': 'cat ' + remote_file + ' | python3 -c "import sys, json; data=json.load(sys.stdin); items=data[\\"results\\"][0][\\"response\\"][\\"data\\"][\\"items\\"]; print(len(items)); [print(item[\\"id\\"]) for item in items]"'
    })
    
    assert bash_result['successful'], f"Failed to read remote file: {bash_result}"
    
    stdout = bash_result['data']['stdout'].strip()
    if not stdout:
        print(f"stderr: {bash_result['data']['stderr']}")
        raise AssertionError("Empty stdout")
    
    lines = stdout.split('\n')
    count = int(lines[0])
    ids = lines[1:]
    
    # We expect 8 campaigns total (verified via COUNT_LAUNCHED_CAMPAIGNS)
    assert count == 8, f"Expected 8 campaigns, got {count}"
    
    # All IDs should be unique
    assert len(set(ids)) == len(ids), "Duplicate campaign IDs found"
    
    print(f"✓ Campaign inventory complete: {count} campaigns")
    for cid in ids:
        print(f"  {cid}")

if __name__ == '__main__':
    test_campaign_inventory_complete()