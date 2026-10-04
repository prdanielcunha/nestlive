#!/bin/bash
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
root="$HOME/Library/Application Support/NestLive"
bin="$root/bin"
web="$root/web"
agent="$HOME/Library/LaunchAgents/com.millionsnest.nestlive.plist"
mkdir -p "$bin" "$web" "$(dirname "$agent")"
for name in NestLiveService NestLiveAudioNode NestLiveProductionNode; do
  cp "$src/$name" "$bin/$name"
  chmod +x "$bin/$name"
done
rm -rf "$web"/*
cp -R "$src/web/." "$web/"
cat > "$agent" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.millionsnest.nestlive</string>
<key>ProgramArguments</key><array><string>$bin/NestLiveService</string></array>
<key>WorkingDirectory</key><string>$root</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$root/service.stdout.log</string>
<key>StandardErrorPath</key><string>$root/service.stderr.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)" "$agent" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$agent"
sleep 2
open http://127.0.0.1:4317/local
echo "NestLive instalado."
