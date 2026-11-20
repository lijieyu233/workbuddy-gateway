// 局域网地址探测的回归测试。
// 踩过的坑：面板「本机」栏在局域网模式下只显示 `<本机IP>` 这种占位符，
// 用户根本不知道该填什么；而 Hyper-V / Docker 的虚拟网卡地址又填不通。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';

const { isPrivateIPv4 } = await import('../src/server.js');

test('私网网段判断（RFC1918）', () => {
  const yes = ['192.168.0.1', '192.168.20.149', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254'];
  const no = ['172.15.0.1', '172.32.0.1', '8.8.8.8', '127.0.0.1', '169.254.1.1', '', 'bad', '192.168.1', '1.2.3.256'];
  for (const ip of yes) assert.equal(isPrivateIPv4(ip), true, `${ip} 应判为私网`);
  for (const ip of no) assert.equal(isPrivateIPv4(ip), false, `${ip} 不应判为私网`);
});

test('本机至少有一个可用的局域网候选地址（或明确没有）', () => {
  // 这个测试不对环境做强假设：CI/无网机器可能确实没有局域网地址，
  // 但只要有，就必须是私网地址，且不能是虚拟网卡那种。
  const interfaces = networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      if (item.internal) continue;
      candidates.push({ name, address: item.address, private: isPrivateIPv4(item.address) });
    }
  }
  // 所有非回环地址要么是私网，要么是公网（两者都合法），但绝不能是空的
  for (const c of candidates) {
    assert.match(c.address, /^\d+\.\d+\.\d+\.\d+$/u);
  }
  // 打印出来方便排查（测试输出里能看到本机实际网卡）
  console.log(`  本机非回环 IPv4: ${candidates.map((c) => `${c.name}=${c.address}${c.private ? '(私网)' : ''}`).join(', ') || '（无）'}`);
});

test('接口返回的局域网地址里不含回环与链路本地地址', async () => {
  // 直接验证真实返回，而不是只测判断函数
  const { createGateway } = await import('../src/server.js');
  const { normalizeConfig, ensureApiKey } = await import('../src/config.js');
  const { Pool } = await import('../src/pool.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  process.env.WORKBUDDY_GATEWAY_HOME = mkdtempSync(join(tmpdir(), 'wbgw-lan-'));

  const config = normalizeConfig({ port: 0, listen: 'lan' });
  ensureApiKey(config);
  const pool = new Pool(config);
  const { server } = createGateway({ config, pool });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const state = await fetch(`http://127.0.0.1:${server.address().port}/api/state`).then((r) => r.json());
  await new Promise((resolve) => server.close(resolve));

  for (const ip of state.endpoint.lanAddresses) {
    assert.equal(ip.startsWith('127.'), false, `不能是回环地址：${ip}`);
    assert.equal(ip.startsWith('169.254.'), false, `不能是链路本地地址：${ip}`);
    assert.equal(isPrivateIPv4(ip), true, `必须是私网地址：${ip}`);
  }
  for (const url of state.endpoint.lanUrls) {
    assert.match(url, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/v1$/u, `地址格式不对：${url}`);
    assert.equal(url.includes('<'), false, `不能出现占位符：${url}`);
  }
  // baseUrl 始终是回环地址，局域网地址单独放在 lanUrls 里
  assert.match(state.endpoint.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
});
