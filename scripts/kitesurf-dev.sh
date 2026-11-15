#!/bin/bash
# Start the Kitesurf dev server (WSL or Linux) and keep its output in a log file.
# The leak test reads this log, so the gate's tests need the server started this way.
#   KITESURF_DIR  where Kitesurf is checked out (default: $HOME/dev/kitesurf)
#   KS_LOG        log file                      (default: $HOME/dev/kitesurf-dev.log)
#   KS_TIMEOUT    seconds before it is stopped  (default: 7000)
#   KITESURF_PORT port Kitesurf listens on      (default: 8787; read by Kitesurf itself, not by this script)
KITESURF_DIR=${KITESURF_DIR:-$HOME/dev/kitesurf}
LOG=${KS_LOG:-$HOME/dev/kitesurf-dev.log}
cd "$KITESURF_DIR" || exit 1
exec timeout "${KS_TIMEOUT:-7000}" pnpm run dev > "$LOG" 2>&1
