#!/usr/bin/env bash
# Keeps the agent's state (leads.db, dashboard.json, actions/) on the
# "agent-data" branch, separate from the code.
#   state.sh pull         clone the branch into ./state (or start empty)
#   state.sh push "msg"   commit ./state and push, retrying if the dashboard pushed meanwhile
set -euo pipefail

BRANCH="${STATE_BRANCH:-agent-data}"
DIR="${STATE_DIR:-state}"
# STATE_REMOTE overrides the remote (used by tests).
REMOTE="${STATE_REMOTE:-https://x-access-token:${GH_TOKEN:?GH_TOKEN is required}@github.com/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}.git}"

case "${1:-}" in
  pull)
    rm -rf "$DIR"
    if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
      git clone --quiet --branch "$BRANCH" --single-branch --depth 1 "$REMOTE" "$DIR"
      echo "state: loaded branch $BRANCH"
    else
      mkdir -p "$DIR"
      git -C "$DIR" init --quiet -b "$BRANCH"
      git -C "$DIR" remote add origin "$REMOTE"
      echo "state: branch $BRANCH does not exist yet; starting empty"
    fi
    mkdir -p "$DIR/actions"
    touch "$DIR/actions/.keep"
    ;;
  push)
    cd "$DIR"
    printf 'output/screenshots/\n*.tmp\n*.db-wal\n*.db-shm\n' > .gitignore
    git add -A
    if git diff --cached --quiet; then
      echo "state: nothing changed"
      exit 0
    fi
    git -c user.name="lead-scout agent" -c user.email="actions@users.noreply.github.com" commit --quiet -m "${2:-agent run}"
    for attempt in 1 2 3 4 5; do
      if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
        # The dashboard may have added action files meanwhile; they never touch our files.
        git pull --quiet --rebase origin "$BRANCH" || { git rebase --abort || true; sleep $((attempt * 3)); continue; }
      fi
      if git push --quiet origin "HEAD:$BRANCH"; then
        echo "state: saved to $BRANCH"
        exit 0
      fi
      sleep $((attempt * 3))
    done
    echo "state: could not push after 5 attempts" >&2
    exit 1
    ;;
  *)
    echo "usage: state.sh pull | push \"message\"" >&2
    exit 2
    ;;
esac
