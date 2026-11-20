// 端到端：客户端发裸 base64 图片（会触发 11133），网关应自动补前缀后成功。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'wbgw-img-'));
process.env.WORKBUDDY_GATEWAY_HOME = workdir;

const { normalizeConfig, ensureApiKey } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');
const { createGateway } = await import('../src/server.js');
const { scanDesktopAccounts, mergeScanned } = await import('../src/accounts.js');

const config = normalizeConfig({ port: 0 });
ensureApiKey(config);
const pool = new Pool(config);
const scanned = scanDesktopAccounts();
if (scanned.length === 0) { console.log('本机没有登录态，跳过'); process.exit(0); }
pool.store = mergeScanned(pool.store, scanned).store;
pool.reindex();
pool.persist();

const { server } = createGateway({ config, pool });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const key = config.apiKeys[0].key;
const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
await fetch(`${base}/api/catalog/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function ask(label, imageUrl) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: false,
      max_tokens: 40,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图是什么颜色？一句话。' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    }),
  });
  const body = await res.json();
  const text = body.choices?.[0]?.message?.content;
  console.log(`${label.padEnd(28)} -> ${res.status} ${res.status === 200 ? JSON.stringify(String(text).slice(0, 40)) : (body.error?.message || '').slice(0, 120)}`);
  return res.status;
}

console.log('=== 裸 base64（曾触发 11133）===');
const bare = await ask('裸 base64', PNG);
console.log('=== 正确 data URL（对照组）===');
const good = await ask('data URL', `data:image/png;base64,${PNG}`);

console.log(bare === 200 && good === 200 ? '\n✔ 裸 base64 已被自动修复' : '\n✘ 仍有问题');

server.close();
process.exit(0);
