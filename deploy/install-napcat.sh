#!/usr/bin/env bash
# 使用独立 NapCat Docker 网关；先在 config.json 配置机器人账号和管理员。
set -euo pipefail
umask 077
BASE=/opt/qqbot
APP="$BASE/app"
export NAPCAT_UID="$(id -u qqbot)"
export NAPCAT_GID="$(id -g qqbot)"
install -d -o qqbot -g qqbot -m 700 "$BASE/gateway" "$BASE/gateway/config" "$BASE/gateway/qq" "$BASE/gateway/plugins"
install -d -o qqbot -g qqbot -m 700 "$BASE/gateway/qq/qqbot-sticker-transfer"
python3 - <<'PY'
import json, pathlib, secrets
base = pathlib.Path('/opt/qqbot')
cfg_path = base / 'app/config.json'
cfg = json.loads(cfg_path.read_text())
account = str(cfg.get('snowluma', {}).get('accountId', '')).strip()
if not account.isascii() or not account.isdigit() or not 5 <= len(account) <= 12 or int(account) <= 0:
    raise SystemExit('请先在 config.json 的 snowluma.accountId 填写当前机器人 QQ 号')
token = cfg['snowluma'].get('accessToken') or secrets.token_urlsafe(32)
cfg['snowluma']['accessToken'] = token
cfg['snowluma'].update(gateway='napcat', stickerTransferDir='/opt/qqbot/gateway/qq/qqbot-sticker-transfer', stickerGatewayDir='/app/.config/QQ/qqbot-sticker-transfer')
owner = str(cfg.get('ownerQQ') or '').strip()
if not owner.isascii() or not owner.isdigit() or not 5 <= len(owner) <= 12 or int(owner) <= 0:
    raise SystemExit('请先在 config.json 的 ownerQQ 填写管理员 QQ 号')
cfg['ownerQQ'] = owner
cfg['allow']['private'] = list(dict.fromkeys([*map(str, cfg['allow']['private']), owner]))
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
for name in ['onebot11.json', f'onebot11_{account}.json']:
    target = base / 'gateway/config' / name
    if not target.exists():
        target.write_text(json.dumps(network, ensure_ascii=False, indent=2) + '\n')
webui = base / 'gateway/config/webui.json'
if not webui.exists():
    webui.write_text(json.dumps({
        'host': '0.0.0.0', 'port': 6099, 'prefix': '',
        'token': secrets.token_urlsafe(32), 'loginRate': 3, 'autoLoginAccount': account,
    }, indent=2) + '\n')
else:
    settings = json.loads(webui.read_text())
    if str(settings.get('autoLoginAccount', '')) != account:
        import shutil, time
        backup = webui.with_name(f'webui.before-account-sync-{time.time_ns()}.json')
        shutil.copy2(webui, backup)
        backup.chmod(0o600)
        settings['autoLoginAccount'] = account
        temporary = webui.with_suffix('.json.account-new')
        temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + '\n')
        temporary.chmod(0o600)
        temporary.replace(webui)
PY
chown qqbot:qqbot "$APP/config.json"
chown -R qqbot:qqbot "$BASE/gateway"
export QQBOT_ACCOUNT="$(python3 -c 'import json; print(json.load(open("/opt/qqbot/app/config.json"))["snowluma"]["accountId"])')"
docker compose -f "$APP/deploy/compose.napcat.yml" config --quiet
# 网络异常或拉取停滞时明确退出，保留已有服务及数据。
timeout 300 docker compose -f "$APP/deploy/compose.napcat.yml" pull
bash "$APP/deploy/prepare-napcat-diagnostics.sh"
if [[ -e /usr/local/share/qqbot-gateway-runtime/.needs-container-recreate ]]; then
    docker compose -f "$APP/deploy/compose.napcat.yml" up -d --force-recreate
    rm -f /usr/local/share/qqbot-gateway-runtime/.needs-container-recreate
else
    docker compose -f "$APP/deploy/compose.napcat.yml" up -d
fi
systemctl restart qqbot-bridge
echo 'NapCat 已提交启动；QQ 在线状态须扫码后确认。'
