// 只读网关状态；不发送消息，不打印令牌或聊天内容。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
async function call(action) {
  const response = await fetch(`${cfg.snowluma.httpUrl.replace(/\/$/, '')}/${action}`, {
    method: 'POST', headers: { authorization: `Bearer ${cfg.snowluma.accessToken}`, 'content-type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.retcode !== 0) throw new Error(`${action}: HTTP ${response.status}, retcode=${result.retcode}`);
  return result.data;
}
try {
  const [login, status, groups, friends] = await Promise.all([
    call('get_login_info'), call('get_status'), call('get_group_list'), call('get_friend_list'),
  ]);
  const expected = process.argv[2];
  const targetGroup = process.argv[3];
  console.log(JSON.stringify({
    userId: String(login.user_id), nickname: login.nickname,
    expectedAccountMatches: expected ? String(login.user_id) === expected : null,
    online: status.online, good: status.good,
    adminIsFriend: friends.some((friend) => String(friend.user_id) === String(cfg.ownerQQ)),
    groupCount: groups.length,
    targetGroupJoined: targetGroup ? groups.some((group) => String(group.group_id) === targetGroup) : null,
    groups: groups.filter((group) => !targetGroup || String(group.group_id) === targetGroup)
      .map((group) => ({ groupId: String(group.group_id), name: group.group_name, memberCount: group.member_count })),
  }, null, 2));
  if (expected && String(login.user_id) !== expected) process.exitCode = 1;
} catch (error) {
  console.error(String(error?.message ?? error).replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏]'));
  process.exitCode = 1;
}
