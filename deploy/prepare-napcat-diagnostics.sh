#!/usr/bin/env bash
# 从锁定镜像提取原版程序，再增加诊断；不停止运行中的QQ。
set -euo pipefail
umask 077
APP=/opt/qqbot/app
DIR=/usr/local/share/qqbot-gateway-runtime
IMAGE="$(awk '/^[[:space:]]*image:/{print $2;exit}' "$APP/deploy/compose.napcat.yml")"
[[ "$IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || { echo '网关镜像必须固定摘要。' >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null
[[ ! -L "$DIR" ]] || { echo '运行目录不能是符号链接。' >&2; exit 1; }
install -d -o root -g root -m 755 "$DIR"
TEMP_DIR="$(mktemp -d "$DIR/.prepare-XXXXXX")"
EXTRACT_ID=''
cleanup() {
  if [[ "$EXTRACT_ID" =~ ^[a-f0-9]{64}$ ]]; then docker rm -v "$EXTRACT_ID" >/dev/null 2>&1 || true; fi
  rm -f "$TEMP_DIR/napcat.mjs" "$TEMP_DIR/NapCat.Shell.zip"
  rmdir "$TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT
EXTRACT_ID="$(docker create --label qqbot.purpose=offline-diagnostics-extract "$IMAGE")"
docker cp "$EXTRACT_ID:/app/NapCat.Shell.zip" "$TEMP_DIR/NapCat.Shell.zip"
python3 - "$TEMP_DIR" <<'PY'
import sys,zipfile
from pathlib import Path
directory=Path(sys.argv[1])
with zipfile.ZipFile(directory/'NapCat.Shell.zip') as archive:
    entry=archive.getinfo('napcat.mjs')
    if entry.file_size>8*1024*1024:raise SystemExit('网关程序大小异常')
    (directory/'napcat.mjs').write_bytes(archive.read(entry))
PY
python3 "$APP/deploy/patch-napcat-offline-diagnostics.py" --file "$TEMP_DIR/napcat.mjs"
/opt/qqbot/runtime/node/bin/node --check "$TEMP_DIR/napcat.mjs"
if [[ -e "$DIR/napcat.mjs" ]] && cmp -s "$DIR/napcat.mjs" "$TEMP_DIR/napcat.mjs"; then
  chown root:root "$DIR/napcat.mjs"
  chmod 644 "$DIR/napcat.mjs"
  echo '离线原因记录程序已准备，无变更。'
else
  if [[ -e "$DIR/napcat.mjs" ]]; then cp -p "$DIR/napcat.mjs" "$DIR/napcat.before-$(date -u +%Y%m%dT%H%M%SZ).mjs"; fi
  install -o root -g root -m 644 "$TEMP_DIR/napcat.mjs" "$DIR/.napcat.mjs.new"
  mv "$DIR/.napcat.mjs.new" "$DIR/napcat.mjs"
  touch "$DIR/.needs-container-recreate"
  echo '已准备离线原因记录；等待受控重建加载，现有QQ尚未停止。'
fi
if ! cmp -s "$APP/deploy/napcat-diagnostics-entrypoint.sh" "$DIR/entrypoint.sh"; then
  install -o root -g root -m 644 "$APP/deploy/napcat-diagnostics-entrypoint.sh" "$DIR/.entrypoint.sh.new"
  mv "$DIR/.entrypoint.sh.new" "$DIR/entrypoint.sh"
  touch "$DIR/.needs-container-recreate"
fi
chown root:root "$DIR/entrypoint.sh"
chmod 644 "$DIR/entrypoint.sh"
