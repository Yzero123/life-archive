// 输入校验与资源上限的回归测试（3.0.1）
//
// 审查建议里的一条：请求体只有 4 MiB 上限，JSON 解析和全库 prompt
// 仍可能造成内存峰值。这里把「一个畸形/超大的输入最多能造成多大代价」
// 变成能反复跑的断言。
//
// 覆盖三层：
//   1. limits.mjs —— 深度扫描、文本截断、数组截断
//   2. kb.mjs      —— 解析层的正文/评论/点赞/媒体上限、全库速览截断标注
//   3. server.mjs  —— HTTP 层：畸形请求要报错，而且**服务不能倒**
//
// 运行：node tests/limits.mjs

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_COMMENTS,
  MAX_CONTENT_CHARS,
  MAX_JSON_DEPTH,
  MAX_LIKE_USERS,
  MAX_MEDIA,
  MAX_RECORDS,
  capArray,
  capText,
  jsonDepthError,
} from '../miniapp/node/limits.mjs';

import {
  buildKbDigest,
  parseQzoneExport,
} from '../miniapp/node/kb.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name} — ${error.message}`);
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name} — ${error.message}`);
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 1. limits.mjs
// ---------------------------------------------------------------------------
console.log('\n[1] 深度扫描与截断');

check('正常 JSON 没有深度问题', () => {
  assert.equal(jsonDepthError('{"a":[1,2,{"b":"c"}]}'), null);
  assert.equal(jsonDepthError('[]'), null);
  assert.equal(jsonDepthError('"只是字符串"'), null);
});

check('字符串里的括号不计入嵌套深度', () => {
  assert.equal(jsonDepthError('{"a":"[[[[[[[[[["}'), null);
});

check('转义引号不会把字符串状态算错', () => {
  assert.equal(jsonDepthError('{"a":"他说\\"你好\\""}'), null);
  assert.equal(jsonDepthError('{"a":"\\"嵌套\\"里\\"还有\\"括号\\""}'), null);
});

check('超过深度上限会报出来', () => {
  const deep = '['.repeat(MAX_JSON_DEPTH + 5) + ']'.repeat(MAX_JSON_DEPTH + 5);
  const error = jsonDepthError(deep);
  assert.ok(error, '深层嵌套应该报错');
  assert.ok(error.includes(String(MAX_JSON_DEPTH)));
});

check('刚好到上限不报错', () => {
  const ok = '['.repeat(MAX_JSON_DEPTH) + ']'.repeat(MAX_JSON_DEPTH);
  assert.equal(jsonDepthError(ok), null);
});

check('截断会标注原长，不静默丢字', () => {
  const long = '啊'.repeat(100);
  const capped = capText(long, 10);
  assert.ok(capped.length < long.length);
  assert.ok(capped.includes('已截断'));
  assert.ok(capped.includes('100'));
  assert.equal(capText('短的', 10), '短的');
});

check('数组截断会报丢掉多少', () => {
  const result = capArray([1, 2, 3, 4, 5], 3);
  assert.deepEqual(result.items, [1, 2, 3]);
  assert.equal(result.dropped, 2);
});

// ---------------------------------------------------------------------------
// 2. 解析层上限
// ---------------------------------------------------------------------------
console.log('\n[2] 解析层的记录上限');

check('超长正文被截断并标注', () => {
  const payload = [{ tid: 't1', content: '字'.repeat(MAX_CONTENT_CHARS + 500) }];
  const records = parseQzoneExport(payload);
  assert.equal(records.length, 1);
  assert.ok(records[0].content.length < MAX_CONTENT_CHARS + 500);
  assert.ok(records[0].content.includes('已截断'));
});

check('正常长度的正文不受影响', () => {
  const records = parseQzoneExport([{ tid: 't1', content: '今天天气不错' }]);
  assert.equal(records[0].content, '今天天气不错');
});

check('评论数、点赞数、媒体数都有上限', () => {
  const comments = Array.from({ length: MAX_COMMENTS + 30 }, (_, i) => ({
    content: `评论 ${i}`,
    user: { nick: '某人' },
  }));
  const likes = Array.from({ length: MAX_LIKE_USERS + 30 }, (_, i) => ({
    fuin: `uin${i}`,
    nick: '某人',
  }));
  const pics = Array.from({ length: MAX_MEDIA + 20 }, (_, i) => ({ url: `https://example.com/${i}.jpg` }));
  const records = parseQzoneExport([{ tid: 't1', content: '正文', custom_comments: comments, likes, pic: pics }]);
  assert.equal(records[0].comments.length, MAX_COMMENTS);
  assert.equal(records[0].like_users.length, MAX_LIKE_USERS);
  assert.equal(records[0].images.length, MAX_MEDIA);
});

check('总记录数上限存在（不是无限收）', () => {
  assert.ok(MAX_RECORDS > 0 && MAX_RECORDS <= 1000000);
});

// ---------------------------------------------------------------------------
// 3. 全库速览截断必须说清楚
// ---------------------------------------------------------------------------
console.log('\n[3] 全库速览的截断标注');

check('超出上限时写明截了多少', () => {
  const records = Array.from({ length: 50 }, (_, i) => ({
    kind: 'shuoshuo',
    published_at: 1500000000 + i * 86400,
    content: `第 ${i} 条记录的内容`,
    recovered: false,
  }));
  const digest = buildKbDigest(records, { maxTotalChars: 200 });
  assert.ok(digest.includes('字上限截断'), '应说明被截断');
  assert.ok(digest.includes('条更早的记录没有出现在这段资料里'), '应说明丢的是哪些');
});

check('没超上限时不加多余说明', () => {
  const records = [{
    kind: 'shuoshuo',
    published_at: 1500000000,
    content: '一条普通的记录',
    recovered: false,
  }];
  const digest = buildKbDigest(records, { maxTotalChars: 60000 });
  assert.ok(!digest.includes('已按'));
  assert.ok(digest.includes('一条普通的记录'));
});

// ---------------------------------------------------------------------------
// 4. HTTP 层：畸形请求要报错，服务不能倒
// ---------------------------------------------------------------------------
console.log('\n[4] HTTP 层');

const dataDir = await mkdtemp(join(tmpdir(), 'life-archive-limits-'));
await mkdir(join(dataDir, 'raw'), { recursive: true });
await mkdir(join(dataDir, 'kb'), { recursive: true });
await writeFile(
  join(dataDir, 'raw', 'qzoneexport_messages.json'),
  JSON.stringify([{ tid: 't1', content: '一条记录', created_time: '2020-01-01 00:00:00' }]),
  'utf8',
);

const { start } = await import('../miniapp/node/server.mjs');

const probe = createNetServer();
const port = await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const assigned = probe.address().port;
    probe.close(() => resolve(assigned));
  });
});

const context = {
  pluginRoot: join(import.meta.dirname, '..'),
  dataDir,
  listen: { host: '127.0.0.1', port },
  signal: new AbortController().signal,
  logger: { info() {}, error() {} },
  agent: {
    async run() { return { sessionId: 'mock', status: 'finished', text: '好的' }; },
    async reply() {},
  },
};

const lifecycle = await start(context);
const base = `http://127.0.0.1:${port}`;

async function call(path, options) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  return { status: res.status, body: await res.json() };
}

try {
  await checkAsync('嵌套过深的请求体被拒绝', async () => {
    const deep = `${'['.repeat(MAX_JSON_DEPTH + 20)}${']'.repeat(MAX_JSON_DEPTH + 20)}`;
    const res = await call('/api/chat', { method: 'POST', body: deep });
    assert.ok(res.status >= 400, `应报错，实际 ${res.status}`);
    assert.ok(String(res.body.message || '').includes('嵌套'), `应说清是嵌套问题：${res.body.message}`);
  });

  await checkAsync('服务没被畸形请求打倒', async () => {
    const res = await call('/api/state');
    assert.equal(res.status, 200);
    assert.equal(res.body.phase !== undefined, true);
  });

  await checkAsync('正常请求依然能建库', async () => {
    const res = await call('/api/kb/build', {
      method: 'POST',
      body: JSON.stringify({ ownerUin: '12345678' }),
    });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.stats.totalRecords, 1);
  });

  await checkAsync('超大的请求体被挡掉', async () => {
    const huge = JSON.stringify({ message: 'x'.repeat(5 * 1024 * 1024) });
    let rejected = false;
    try {
      const res = await call('/api/chat', { method: 'POST', body: huge });
      rejected = res.status >= 400;
    } catch {
      // 服务直接掐断连接也是「拒收」——超大请求体不进解析器。
      rejected = true;
    }
    assert.equal(rejected, true);
  });

  await checkAsync('挡掉超大请求后服务还在', async () => {
    const res = await call('/api/state');
    assert.equal(res.status, 200);
  });
} finally {
  await lifecycle.dispose();
  await rm(dataDir, { recursive: true, force: true });
}

console.log('\n========================================================');
if (failed) {
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  for (const item of failures) console.log(`  · ${item}`);
  process.exit(1);
}
console.log(`通过 ${passed} 项，失败 0 项`);
console.log('✅ 全部通过');
