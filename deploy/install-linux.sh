#!/usr/bin/env bash
# 仅部署 qq-bridge 与 DSH；不下载、部署或启动 SnowLuma。
set -euo pipefail
umask 077

BASE=/opt/qqbot
NODE_VERSION=24.18.0
DSH_VERSION=0.2.0-rc.2
APP="$BASE/app"
RUNTIME="$BASE/runtime"

[[ $(id -u) == 0 ]] || { echo '请以 root 运行安装脚本。' >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo '当前脚本仅验证 x86_64。' >&2; exit 1; }
[[ -f "$APP/package-lock.json" ]] || { echo '尚未上传项目。' >&2; exit 1; }

if ! id qqbot >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$BASE/state/home" --no-create-home --shell /usr/sbin/nologin qqbot
fi
install -d -o qqbot -g qqbot -m 700 "$RUNTIME" "$BASE/state" "$BASE/state/home" "$BASE/state/dsh" "$BASE/state/workspace" "$RUNTIME/downloads" "$RUNTIME/dsh"

if [[ ! -x "$RUNTIME/node/bin/node" ]]; then
  ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
  cd "$RUNTIME/downloads"
  curl --fail --location --connect-timeout 10 --max-time 120 --output "$ARCHIVE" "https://nodejs.org/dist/v${NODE_VERSION}/$ARCHIVE"
  curl --fail --location --connect-timeout 10 --max-time 30 --output SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  awk -v file="$ARCHIVE" '$2 == file' SHASUMS256.txt > selected.sha256
  [[ -s selected.sha256 ]] || { echo '官方校验清单缺少目标文件。' >&2; exit 1; }
  sha256sum -c selected.sha256
  install -d -m 755 "$RUNTIME/node"
  tar -xJf "$ARCHIVE" -C "$RUNTIME/node" --strip-components=1
fi
export PATH="$RUNTIME/node/bin:$RUNTIME/dsh/node_modules/.bin:$PATH"
export DSH_HOME="$BASE/state/dsh"
export HOME="$BASE/state/home"

echo '安装锁定版本的桥接依赖与独立 DSH 运行时。'
cd "$APP"
npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=25000
node scripts/patch-snowluma-sdk.mjs
# DSH 需要 peer dependencies；不能沿用桥接项目 .npmrc 的 legacy-peer-deps。
npm install --prefix "$RUNTIME/dsh" --save-exact "@deepseek-ai/dsh@$DSH_VERSION" --ignore-scripts --legacy-peer-deps=false --no-audit --no-fund --fetch-retries=0 --fetch-timeout=25000

if [[ ! -e "$APP/config.json" ]]; then
  python3 - "$APP" <<'PY'
import json, pathlib, secrets, sys
app = pathlib.Path(sys.argv[1])
config = json.loads((app / 'config.example.json').read_text())
config['dsh']['baseUrl'] = 'http://127.0.0.1:13080'
config['snowluma'].update(wsUrl='ws://127.0.0.1:13001', httpUrl='http://127.0.0.1:13000', followDiscoveredEndpoint=False)
config['consolePort'] = 13100
config['consoleToken'] = secrets.token_urlsafe(32)
config['sessionCwd'] = '/opt/qqbot/state/workspace'
config['pricing'] = {'models': {}}
config['allowAllWhenEmpty'] = False
(app / 'config.json').write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
PY
fi
install -d -m 700 "$APP/state"
chown -R qqbot:qqbot "$APP" "$RUNTIME" "$BASE/state"
chown qqbot:qqbot "$BASE"
chmod 700 "$BASE"

echo '安装两套群聊预设和 MCP，使用本服务独立的 DSH_HOME。'
runuser -u qqbot -- env HOME="$HOME" DSH_HOME="$DSH_HOME" PATH="$PATH" node "$RUNTIME/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" web --help >/dev/null
runuser -u qqbot -- env HOME="$HOME" DSH_HOME="$DSH_HOME" PATH="$PATH" QQ_BRIDGE_SKIP_DSH_INSTALL=1 node scripts/setup-dsh.mjs

for unit in qqbot-dsh qqbot-bridge; do
  if [[ -e "/etc/systemd/system/$unit.service" ]]; then
    cp -p "/etc/systemd/system/$unit.service" "/etc/systemd/system/$unit.service.bak-$(date +%Y%m%d%H%M%S)"
  fi
  install -m 644 "$APP/deploy/$unit.service" "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
systemctl enable qqbot-dsh.service qqbot-bridge.service
# enable --now 不会刷新已经 active 的进程；重装后需加载新代码、preset 与 unit。
systemctl restart qqbot-dsh.service qqbot-bridge.service
systemctl is-active --quiet qqbot-dsh.service
systemctl is-active --quiet qqbot-bridge.service
echo 'DSH 与桥接服务已提交启动；仍需检查健康状态、填写模型凭据并接入 QQ。'
