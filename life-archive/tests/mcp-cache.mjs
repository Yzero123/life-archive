// MCP 缓存失效回归测试。
//
// 用法：node tests/mcp-cache.mjs
//
// 背景（实测踩到的坑）
// ----------------------
// MCP 服务器是**常驻进程**。早期版本把知识库一次性读进内存就再也不管了，
// 于是：用户导入新数据 → 面板上「重新构建知识库」→ 问 bot，
// 拿到的还是**重建之前**的旧画像。
// 本机实测：重建后 `kb_profile` 仍返回旧的 `updatedAt`，
// 「最常回复的人」还停在我自己（修 bug 之前的那份）。
//
// 这个测试要锁住的行为：**文件变了就得重读**，不能拿旧数据回答。
//
// 做法：起一个临时 dataDir（不碰真实知识库），往里写一份可辨认的画像，
// 调一次 kb_profile；然后把画像改掉，再调一次——必须返回**改过之后**的内容。
//
// 所有数据都是合成的，不含任何真实身份信息。

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const serverPath = resolve(pluginRoot, 'mcp', 'kb-mcp.mjs');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label} ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// 临时知识库
// ---------------------------------------------------------------------------
const dataDir = await mkdtemp(join(tmpdir(), 'life-archive-cache-'));
const kbDir = join(dataDir, 'kb');
await mkdir(kbDir, { recursive: true });

const RECORD = {
  id: 'wx-demo-1',
  ids: ['wx-demo-1'],
  sources: ['wechat-sns'],
  kind: 'moments',
  content: '这是一条用于缓存测试的合成记录',
  user_voice: '这是一条用于缓存测试的合成记录',
  published_at: 1600000000,
  recovered: false,
  body_missing: false,
  comments: [],
  like_users: [],
  images: [],
  videos: [],
  location: '',
};

const CHUNK = {
  id: 'wx-demo-1',
  text: '这是一条用于缓存测试的合成记录',
  year: '2020',
  sources: ['wechat-sns'],
};

async function writeProfile(marker) {
  await writeFile(join(kbDir, 'profile.json'), JSON.stringify({
    source: 'facts',
    narrative: '',
    facts: `[跨度] ${marker}`,
    updatedAt: 1700000000000,
  }));
}

await writeFile(join(kbDir, 'unified.jsonl'), `${JSON.stringify(RECORD)}\n`);
await writeFile(join(kbDir, 'chunks.jsonl'), `${JSON.stringify(CHUNK)}\n`);
await writeFile(join(kbDir, 'summaries.jsonl'), '');
await writeProfile('第一版画像');

// ---------------------------------------------------------------------------
// 起 MCP 服务器
// ---------------------------------------------------------------------------
const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, QQ_SPACE_KB_DATA_DIR: dataDir },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const pending = new Map();
let seq = 0;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
    index = buffer.indexOf('\n');
  }
});

function call(method, params) {
  seq += 1;
  const id = seq;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${method} 超时`)), 15000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) rejectPromise(new Error(`${method}: ${message.error.message}`));
      else resolvePromise(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function parseTool(result) {
  const text = result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

try {
  console.log('== initialize ==');
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cache-test', version: '1' },
  });
  notify('notifications/initialized', {});

  console.log('\n== 第一次读 ==');
  const first = parseTool(await call('tools/call', { name: 'kb_profile', arguments: {} }));
  check('读到第一版画像', first.facts === '[跨度] 第一版画像', JSON.stringify(first.facts));

  console.log('\n== 文件改了之后 ==');
  // 换内容 + 换长度：指纹靠「mtime + 大小」判断，内容变了就一定会被认出来。
  await writeProfile('第二版画像——更长的内容以确保大小也变了');
  const second = parseTool(await call('tools/call', { name: 'kb_profile', arguments: {} }));
  check('读到改过之后的画像', second.facts?.includes('第二版画像'), JSON.stringify(second.facts));
  check('不再返回旧画像', !second.facts?.includes('第一版画像'), JSON.stringify(second.facts));

  console.log('\n== 知识块也跟着更新 ==');
  await writeFile(join(kbDir, 'chunks.jsonl'), `${JSON.stringify({
    ...CHUNK,
    id: 'wx-demo-2',
    text: '这是重建之后才写进去的第二条合成记录',
  })}\n`);
  const stats = parseTool(await call('tools/call', { name: 'kb_stats', arguments: {} }));
  check('重建后的条数立刻生效', stats.totalRecords === 1, `${stats.totalRecords}`);
  const search = parseTool(await call('tools/call', {
    name: 'kb_search',
    arguments: { query: '重建之后才写进去' },
  }));
  check('检索也用上了新知识块', search.hits?.length > 0, JSON.stringify(search).slice(0, 200));

  console.log('\n== 同大小覆盖（内容变了、长度没变）==');
  // 「mtime + 大小」这种指纹在这种情况下可能看不出来（同一秒内覆盖）。
  // v3.0.1 起指纹是**内容哈希**，所以必须能发现。
  const before = await readFile(join(kbDir, 'profile.json'));
  const same = Buffer.from(before.toString('utf8').replace('第二版画像', '第三版画像'), 'utf8');
  if (same.length !== before.length) {
    failures += 1;
    console.log('  ❌ 这条用例要求替换前后长度相同');
  }
  await writeFile(join(kbDir, 'profile.json'), same);
  const third = parseTool(await call('tools/call', { name: 'kb_profile', arguments: {} }));
  check('同大小覆盖也被发现（靠内容哈希，不是 mtime+size）', third.facts?.includes('第三版画像'), JSON.stringify(third.facts));
} catch (error) {
  failures += 1;
  console.log(`  ❌ 测试过程抛错：${error.message}`);
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(56));
if (failures) {
  console.log(`❌ 失败 ${failures} 项`);
  process.exit(1);
}
console.log('✅ 全部通过');
