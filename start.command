#!/bin/bash
# Faceless Video Generator — daily launcher (macOS / Linux)
# Double-click this file in Finder to start the dev server and open the browser.

cd "$(dirname "$0")"

# A .command launched from Finder often does NOT inherit Homebrew's bin dirs on PATH,
# so tools installed via `brew` (node, ffmpeg, ffprobe, yt-dlp) can be invisible to the
# app even though they work in Terminal (→ "ffmpeg failed (rc=null)"). Prepend the
# standard Homebrew locations so they're always found, however the app was launched.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$PATH"

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is not installed."
    echo "Install Node.js 20+ from https://nodejs.org/"
    read -n 1 -s -r -p "Press any key to exit..."
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "[INFO] node_modules not found — installing dependencies first..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[ERROR] npm install failed."
        read -n 1 -s -r -p "Press any key to exit..."
        exit 1
    fi
fi

echo ""
echo "============================================"
echo "  Faceless Video Generator — starting dev server"
echo "  Browser will open at http://localhost:3000"
echo "  To stop: close this window or press Ctrl+C"
echo "============================================"
echo ""

# Open default browser after a short delay, in the background
( sleep 3 && open "http://localhost:3000" ) &

npm run dev
