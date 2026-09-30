#!/bin/bash
# git-push helper for the marketing-dashboard repo.
# The GitHub token lives ONLY in leaddesk's private env file; builders call this
# script instead of embedding credentials in a remote URL (which would leak the
# token into `git remote -v`, logs, and any agent that runs `git config -l`).

set -euo pipefail
REPO="/home/hermes/projects/marketing-dashboard"
ENVFILE="/home/hermes/.hermes/profiles/leaddesk/secrets/github_token.env"

TOKEN="$(grep -E '^GITHUB_TOKEN=' "$ENVFILE" | cut -d= -f2- | tr -d '\r\n"'"'"'')"

if [ -z "$TOKEN" ]; then
  echo "ERROR: no token in $ENVFILE" >&2
  exit 1
fi

AUTH="https://Yaakovyitzchak1231:${TOKEN}@github.com/Yaakovyitzchak1231/marketing-dashboard.git"

cd "$REPO"
case "${1:-}" in
  push)
    shift
    REF="${1:-HEAD}"
    # rewrite origin to the authenticated URL for this one command only
    git -c credential.helper= push "$AUTH" "$REF" 2>&1 | sed "s|${TOKEN}|***|g"
    # Keep the local remote-tracking ref current. Pushing to a URL rather than
    # to the named remote does NOT update refs/remotes/origin/*, so the branch
    # looked absent from the remote on every later read. verify_commits.py
    # flagged task/t11-collector-live as NOT PUSHED repeatedly even though it
    # was on GitHub (monitor false positive, 2026-09-30).
    BRANCH="$(git rev-parse --abbrev-ref "$REF" 2>/dev/null || true)"
    SHA="$(git rev-parse "$REF" 2>/dev/null || true)"
    if [ -n "$BRANCH" ] && [ "$BRANCH" != "HEAD" ] && [ -n "$SHA" ]; then
        git update-ref "refs/remotes/origin/$BRANCH" "$SHA"
        echo "tracking ref updated: origin/$BRANCH -> ${SHA:0:7}"
    fi
    ;;
  pull)
    git -c credential.helper= fetch "$AUTH" 2>&1 | sed "s|${TOKEN}|***|g"
    git -c credential.helper= merge --ff-only FETCH_HEAD
    ;;
  *)
    echo "usage: git-push.sh push [refspec] | git-push.sh pull" >&2
    exit 2
    ;;
esac
