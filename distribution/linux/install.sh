#!/usr/bin/env bash
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
root="${XDG_DATA_HOME:-$HOME/.local/share}/nestlive"
bin="$root/bin"
web="$root/web"
mkdir -p "$bin" "$web"
for name in NestLiveService NestLiveAudioNode NestLiveProductionNode; do
  install -m 755 "$src/$name" "$bin/$name"
done
rm -rf "$web"/*
cp -R "$src/web/." "$web/"
if command -v systemctl >/dev/null 2>&1; then
  unit="$HOME/.config/systemd/user/nestlive.service"
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<EOF
[Unit]
Description=NestLive
After=network.target

[Service]
Type=simple
WorkingDirectory=$root
ExecStart=$bin/NestLiveService
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now nestlive.service
else
  nohup "$bin/NestLiveService" >"$root/nestlive.log" 2>&1 &
fi
sleep 2
command -v xdg-open >/dev/null 2>&1 && xdg-open http://127.0.0.1:4317/local >/dev/null 2>&1 || true
echo "NestLive instalado em $root"
