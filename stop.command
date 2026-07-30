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

echo ""
echo "Done. You can close this window or run start.command again."
sleep 3
