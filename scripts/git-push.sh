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
    BRANCH="${2:-}"
    # rewrite origin to the authenticated URL for this one command only
    git -c credential.helper= push "$AUTH" "$REF" 2>&1 | sed "s|${TOKEN}|***|g"
    # Pushing to a URL does NOT update refs/remotes/origin/*. Without this the
    # local tracking ref stays at the pre-push commit and the supervisor monitor
    # reports a phantom "N commit(s) ahead of origin/<branch>" for work that is
    # already on the remote. verify_commits.py documents git-push.sh as updating
    # the tracking ref; that was true of nothing until now.
    if [ -n "$BRANCH" ]; then
      git -c credential.helper= fetch "$AUTH" \
        "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" 2>&1 \
        | sed "s|${TOKEN}|***|g" || true
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
