#!/usr/bin/env bash
set -euo pipefail
systemctl --user disable --now nestlive.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/nestlive.service"
systemctl --user daemon-reload 2>/dev/null || true
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/nestlive"
echo "NestLive removido."
