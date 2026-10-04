#!/bin/bash
set -euo pipefail
agent="$HOME/Library/LaunchAgents/com.millionsnest.nestlive.plist"
launchctl bootout "gui/$(id -u)" "$agent" 2>/dev/null || true
rm -f "$agent"
rm -rf "$HOME/Library/Application Support/NestLive"
echo "NestLive removido."
