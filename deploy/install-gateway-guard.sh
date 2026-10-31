#!/usr/bin/env bash
# 不停止QQ/DSH/桥接，不保存密码；加密凭据需另行授权配置。
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo '需要root安装系统级恢复服务。' >&2; exit 1; }
APP=/opt/qqbot/app
STATE=/var/lib/qqbot-gateway-guard
install -d -o root -g root -m 700 "$STATE" /etc/qqbot/credentials
install -d -o root -g root -m 755 /usr/local/libexec /run/qqbot-gateway-guard
BACKUP="$STATE/backups/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 700 "$BACKUP"
for file in /usr/local/libexec/qqbot-gateway-guard.py /etc/systemd/system/qqbot-gateway-guard.service /etc/systemd/system/qqbot-gateway-guard.timer; do
  if [[ -e "$file" ]]; then cp -p "$file" "$BACKUP/$(basename "$file")"; fi
done
systemctl stop qqbot-gateway-guard.timer qqbot-gateway-guard.service 2>/dev/null || true
install -o root -g root -m 644 "$APP/deploy/gateway-recovery.py" /usr/local/libexec/.qqbot-gateway-guard.py.new
mv /usr/local/libexec/.qqbot-gateway-guard.py.new /usr/local/libexec/qqbot-gateway-guard.py
for kind in service timer; do
  install -o root -g root -m 644 "$APP/deploy/qqbot-gateway-guard.$kind" "/etc/systemd/system/qqbot-gateway-guard.$kind"
done
systemd-analyze verify /etc/systemd/system/qqbot-gateway-guard.service /etc/systemd/system/qqbot-gateway-guard.timer
systemctl daemon-reload
systemctl enable --now qqbot-gateway-guard.timer
systemctl start qqbot-gateway-guard.service
echo "恢复服务已安装；受保护备份：$BACKUP"
echo '在线时仅检查状态；缺少密码凭据时不会进行密码登录。'
