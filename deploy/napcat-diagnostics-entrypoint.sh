#!/usr/bin/env bash
# 镜像在启动时才解压程序；先补齐其他文件，避开只读诊断模块和持久配置。
set -euo pipefail
cd /app
if [[ ! -f /app/napcat/.qqbot-bundle-ready ]]; then
  unzip -qo /app/NapCat.Shell.zip -x 'napcat.mjs' 'config/*' 'plugins/*' -d /app/napcat
  touch /app/napcat/.qqbot-bundle-ready
fi
exec bash /app/entrypoint.sh
