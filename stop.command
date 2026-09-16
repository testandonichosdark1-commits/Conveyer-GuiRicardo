#!/bin/bash
# Conveyer Grok — stop server (macOS / Linux)
# Use if Ctrl+C doesn't kill the dev server or you see "port 3000 in use".

echo "Looking for processes on port 3000..."
echo ""

PIDS=$(lsof -ti :3000 2>/dev/null)

if [ -z "$PIDS" ]; then
    echo "No process found on port 3000."
else
    for PID in $PIDS; do
        echo "Killing PID $PID"
        kill -9 "$PID" 2>/dev/null || true
    done
fi

# The optional wigolo photo-search daemon, if one was started. Safe when it never was —
# it prints "nothing to stop" and exits. It also refuses to kill a recycled pid that
# doesn't belong to wigolo, so this can't take an unrelated process down with it.
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
    node scripts/wigolo.mjs stop 2>/dev/null || true
fi

echo ""
echo "Done. You can close this window or run start.command again."
sleep 3
