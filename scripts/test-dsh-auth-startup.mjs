// 重现首次部署时的启动竞态：桥接先启动，DSH 稍后才生成签名密钥。
// 完全离线，仅使用临时 DSH_HOME；不读取真实凭据、不调用模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { NodeApiClient } from '../src/dsh-client.js';

test('首次缺少密钥后，凭据落盘即可恢复鉴权，无需重启桥接', async () => {
  const prefix = path.join(os.tmpdir(), 'qq-auth-startup-');
  const home = fs.mkdtempSync(prefix);
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const client = new NodeApiClient('http://127.0.0.1:13080', 1000, {});
    assert.equal(client.hasAuth(), false);
    await assert.rejects(client.ensureAuth(), /鉴权不可用/);
    fs.writeFileSync(path.join(home, '.credentials.yaml'), yaml.dump({
      version: 1,
      records: {
        'client-connection/browser-session': {
          kind: 'grant', payload: { version: 1, secret: randomBytes(32).toString('base64url') },
        },
      },
    }));
    assert.equal(client.hasAuth(), true, '不得永久缓存首次读不到凭据的结果');
    assert.match(await client.ensureAuth(), /^dsh-auth-/);
    assert.equal(client._strategy, 'minted');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    assert.ok(path.resolve(home).startsWith(path.resolve(prefix)));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
