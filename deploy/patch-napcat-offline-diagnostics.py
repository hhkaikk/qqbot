#!/usr/bin/env python3
"""仅匹配已验证固定版本的离线入口；不放开插件白名单、不改变登录逻辑。"""
import argparse
import os
from pathlib import Path
import stat
import tempfile

MARKER='// QQBOT_OFFLINE_DIAGNOSTICS_V1'
ANCHOR='      onOffline: (i) => {\n        pe.setQQLoginStatus'
CALL='        qqbotRecordOffline({fs:fe,path:xe,directory:this.context.pathWrapper.configPath,accountId:this.core.selfInfo.uin,reason:i});\n'
def patch_text(source,helper):
    if MARKER in source:
        if source.count(MARKER)!=1 or source.count(CALL)!=1:raise ValueError('诊断补丁不完整，拒绝继续改写')
        return source
    if source.count(ANCHOR)!=1:raise ValueError('网关版本或离线入口不匹配，未修改')
    definition='export function recordOffline('
    if helper.count(definition)!=1 or 'import ' in helper:raise ValueError('诊断函数格式无效')
    helper=helper.replace(definition,'function qqbotRecordOffline(',1)
    body=source.replace(ANCHOR,'      onOffline: (i) => {\n'+CALL+'        pe.setQQLoginStatus',1)
    return MARKER+'\n'+helper+'\n'+body

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--file',required=True);args=parser.parse_args()
    target=Path(args.file)
    if target.is_symlink() or not target.is_file() or target.stat().st_size>8*1024*1024:raise ValueError('目标文件无效')
    source=target.read_text(encoding='utf8');helper=Path(__file__).with_name('napcat-offline-diagnostics.mjs').read_text(encoding='utf8')
    result=patch_text(source,helper)
    if result==source:print('诊断补丁已存在，未重复修改');return
    original=target.stat();fd,temp=tempfile.mkstemp(prefix='.napcat-diagnostics-',dir=target.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf8',newline='\n') as file:file.write(result);file.flush();os.fsync(file.fileno())
        os.chmod(temp,stat.S_IMODE(original.st_mode))
        if hasattr(os,'geteuid') and os.geteuid()==0:os.chown(temp,original.st_uid,original.st_gid)
        os.replace(temp,target)
    finally:
        if os.path.exists(temp):os.unlink(temp)
    print('已添加有界离线原因记录，原有登录/插件校验逻辑保留')
if __name__=='__main__':
    try:main()
    except (ValueError,OSError) as error:raise SystemExit(str(error))
