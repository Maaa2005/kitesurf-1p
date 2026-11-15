#!/bin/bash
# Stop the Kitesurf dev server started from $KITESURF_DIR (only those processes).
#   KITESURF_DIR  where Kitesurf is checked out (default: $HOME/dev/kitesurf)
KITESURF_DIR=${KITESURF_DIR:-$HOME/dev/kitesurf}
pkill -TERM -f "timeout [0-9]+ pnpm run dev" 2>/dev/null
pkill -TERM -f "$KITESURF_DIR/" 2>/dev/null
sleep 3
pgrep -fa "$KITESURF_DIR/" | grep -v bazel | cut -c1-120 || true
