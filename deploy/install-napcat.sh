#!/usr/bin/env bash
# 使用独立 NapCat Docker 网关；运行前设置 QQ_BOT_ACCOUNT 和 QQ_OWNER_ACCOUNT。
set -euo pipefail
umask 077
BASE=/opt/qqbot
APP="$BASE/app"
: "${QQ_BOT_ACCOUNT:?请设置 QQ_BOT_ACCOUNT}"
: "${QQ_OWNER_ACCOUNT:?请设置 QQ_OWNER_ACCOUNT}"
[[ "$QQ_BOT_ACCOUNT" =~ ^[1-9][0-9]+$ && "$QQ_OWNER_ACCOUNT" =~ ^[1-9][0-9]+$ ]] || { echo "QQ 账号必须为正整数。" >&2; exit 1; }
export QQ_BOT_ACCOUNT QQ_OWNER_ACCOUNT
export NAPCAT_UID="$(id -u qqbot)"
export NAPCAT_GID="$(id -g qqbot)"
install -d -o qqbot -g qqbot -m 700 "$BASE/gateway" "$BASE/gateway/config" "$BASE/gateway/qq" "$BASE/gateway/plugins"
install -d -o qqbot -g qqbot -m 700 "$BASE/gateway/qq/qqbot-sticker-transfer"
python3 - <<'PY'
import json, pathlib, secrets, os
base = pathlib.Path('/opt/qqbot')
cfg_path = base / 'app/config.json'
cfg = json.loads(cfg_path.read_text())
token = cfg['snowluma'].get('accessToken') or secrets.token_urlsafe(32)
cfg['snowluma']['accessToken'] = token
cfg['snowluma'].update(gateway='napcat', stickerTransferDir='/opt/qqbot/gateway/qq/qqbot-sticker-transfer', stickerGatewayDir='/app/.config/QQ/qqbot-sticker-transfer')
cfg['ownerQQ'] = os.environ['QQ_OWNER_ACCOUNT']
cfg['allow']['private'] = list(dict.fromkeys([*map(str, cfg['allow']['private']), os.environ['QQ_OWNER_ACCOUNT']]))
cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n')
network = {
    'network': {
        'httpServers': [{
            'enable': True, 'name': 'qqbot-http', 'host': '0.0.0.0', 'port': 3000,
            'enableCors': False, 'enableWebsocket': False, 'messagePostFormat': 'array',
            'token': token, 'debug': False,
        }],
        'httpSseServers': [], 'httpClients': [], 'websocketClients': [], 'plugins': [],
        'websocketServers': [{
            'enable': True, 'name': 'qqbot-ws', 'host': '0.0.0.0', 'port': 3001,
            'reportSelfMessage': False, 'enableForcePushEvent': True,
            'messagePostFormat': 'array', 'token': token, 'debug': False, 'heartInterval': 30000,
        }],
    },
    'musicSignUrl': '', 'enableLocalFile2Url': False, 'parseMultMsg': False,
}
for name in ['onebot11.json', f"onebot11_{os.environ['QQ_BOT_ACCOUNT']}.json"]:
    target = base / 'gateway/config' / name
    if not target.exists():
        target.write_text(json.dumps(network, ensure_ascii=False, indent=2) + '\n')
webui = base / 'gateway/config/webui.json'
if not webui.exists():
    webui.write_text(json.dumps({
        'host': '0.0.0.0', 'port': 6099, 'prefix': '',
        'token': secrets.token_urlsafe(32), 'loginRate': 3,
    }, indent=2) + '\n')
PY
chown qqbot:qqbot "$APP/config.json"
chown -R qqbot:qqbot "$BASE/gateway"
docker compose -f "$APP/deploy/compose.napcat.yml" config --quiet
# 网络异常或拉取停滞时明确退出，保留已有服务及数据。
timeout 300 docker compose -f "$APP/deploy/compose.napcat.yml" pull
docker compose -f "$APP/deploy/compose.napcat.yml" up -d
systemctl restart qqbot-bridge
echo 'NapCat 已提交启动；QQ 在线状态须扫码后确认。'
