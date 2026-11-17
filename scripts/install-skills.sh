#!/usr/bin/env bash
# Installs the two Claude Code skills the Factory (/factory) depends on into ~/.claude/skills.
#   roteiro-7-things              writes the script + the YouTube description
#   foxhole-thumbnail-generator   writes the thumbnail scene, text and arrow prompt
#
# They are NOT in git (they hold the channel briefs). Unzip the file you were sent so that
# this folder exists next to package.json:   ./skills/roteiro-7-things  ./skills/foxhole-thumbnail-generator
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d skills/roteiro-7-things ] || [ ! -d skills/foxhole-thumbnail-generator ]; then
  echo "skills/ not found. Unzip skills-fabrica.zip into this project's root first:" >&2
  echo "  unzip skills-fabrica.zip -d skills" >&2
  exit 1
fi
mkdir -p "$HOME/.claude/skills"
for s in roteiro-7-things foxhole-thumbnail-generator; do
  if [ -e "$HOME/.claude/skills/$s" ]; then
    echo "~/.claude/skills/$s already exists — kept (delete it first to replace)."
  else
    cp -R "skills/$s" "$HOME/.claude/skills/$s"
    echo "installed $s"
  fi
done
