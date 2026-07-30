#!/bin/bash
# Faceless Video Generator — one-time installer (macOS / Linux)
# Double-click this file in Finder to install npm dependencies.

cd "$(dirname "$0")"

echo ""
echo "============================================"
echo "  Faceless Video Generator — installation"
echo "============================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is not installed."
    echo "Install Node.js 20+ from https://nodejs.org/"
    echo "Then run install.command again."
    read -n 1 -s -r -p "Press any key to exit..."
    exit 1
fi

echo "Installing dependencies (this may take a few minutes)..."
echo ""
npm install
if [ $? -ne 0 ]; then
    echo ""
    echo "[ERROR] npm install failed. See messages above."
    read -n 1 -s -r -p "Press any key to exit..."
    exit 1
fi

echo ""
echo "============================================"
echo "  Done! Run start.command to launch the app."
echo "============================================"
echo ""
read -n 1 -s -r -p "Press any key to exit..."
