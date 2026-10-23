// MCP 服务器本地冒烟测试：真启动、真发 JSON-RPC、真调工具。
// 用法：node tests/mcp-smoke.mjs [dataDir]
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = process.argv[2]
  || `${process.env.HOME}/.minimax/v2/plugin-data/liveboards/qq-space-kb`;

/**
 * 期望的数字**从知识库里现算**，不写死。
 *
 * 写死过一次（91 / 46 / 2012-2026），结果知识库一重建测试就挂——
 * 那是测试的锅，不是代码的锅。数字应该由数据自己说了算。
 * 这里只读文件，不夹带任何用户数据进测试源码。
 */
async function readExpected() {
  let text = '';
  try {
    text = await readFile(join(dataDir, 'kb', 'unified.jsonl'), 'utf8');
  } catch {
    return null;
  }
  const rows = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const years = rows
    .map((row) => Number(row.published_at ?? 0))
    .filter((ts) => Number.isFinite(ts) && ts > 0)
    .map((ts) => String(new Date(ts * 1000).getUTCFullYear()))
    .sort();
  return {
    total: rows.length,
    recovered: rows.filter((row) => row.recovered).length,
    bodyMissing: rows.filter((row) => row.body_missing).length,
    yearFrom: years[0] ?? '',
    yearTo: years[years.length - 1] ?? '',
  };
}

const expected = await readExpected();

const child = spawn(process.execPath, [resolve(pluginRoot, 'mcp', 'kb-mcp.mjs')], {
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

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label} ${detail}`);
  }
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
  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1' },
  });
  check('返回 protocolVersion', Boolean(init.protocolVersion), JSON.stringify(init));
  check('声明 tools 能力', Boolean(init.capabilities?.tools));
  check('serverInfo.name', init.serverInfo?.name === 'qq-space-kb');
  notify('notifications/initialized', {});

  console.log('\n== tools/list ==');
  const list = await call('tools/list', {});
  const names = (list.tools ?? []).map((tool) => tool.name).sort();
  check('5 个工具', names.length === 5, names.join(','));
  check('工具名正确', JSON.stringify(names) === JSON.stringify([
    'kb_ground_check', 'kb_profile', 'kb_records', 'kb_search', 'kb_stats',
  ]), names.join(','));
  for (const tool of list.tools ?? []) {
    check(`${tool.name} 有 description`, Boolean(tool.description));
    check(`${tool.name} 有 inputSchema`, tool.inputSchema?.type === 'object');
  }

  console.log('\n== kb_stats ==');
  const stats = parseTool(await call('tools/call', { name: 'kb_stats', arguments: {} }));
  check('知识库非空', stats.knowledgeBaseExists === true);
  check('能读到知识库内容用于对账', expected !== null && expected.total > 0);
  check('总数与知识库一致', stats.totalRecords === expected.total, `${stats.totalRecords} vs ${expected.total}`);
  check('恢复数与知识库一致', stats.recoveredRecords === expected.recovered, `${stats.recoveredRecords} vs ${expected.recovered}`);
  check('正文缺失数与知识库一致', stats.recoveredBodyMissing === expected.bodyMissing, `${stats.recoveredBodyMissing} vs ${expected.bodyMissing}`);
  check('年份跨度与知识库一致', stats.yearFrom === expected.yearFrom && stats.yearTo === expected.yearTo, `${stats.yearFrom}-${stats.yearTo} vs ${expected.yearFrom}-${expected.yearTo}`);
  check('有年份分布明细', Array.isArray(stats.yearDistribution) && stats.yearDistribution.length > 0);
  const dist = stats.yearDistribution ?? [];
  check('分布按年份升序', dist.every((row, i) => i === 0 || row.year > dist[i - 1].year));
  check('分布条数合计等于总数',
    dist.reduce((sum, row) => sum + row.count, 0) === stats.totalRecords,
    `${dist.reduce((s, r) => s + r.count, 0)} vs ${stats.totalRecords}`);
  check('分布回溯数合计等于回溯总数',
    dist.reduce((sum, row) => sum + row.recovered, 0) === stats.recoveredRecords);
  check('分布正文缺失数合计相等',
    dist.reduce((sum, row) => sum + row.bodyMissing, 0) === stats.recoveredBodyMissing);
  check('每行 withBody 自洽', dist.every((row) => row.withBody === row.count - row.bodyMissing));
  check('有画像', stats.hasProfile === true);
  check('有固定话术', stats.fallbackAnswer === '当时的我还不知道这是什么意思');

  console.log('\n== kb_search（库内问）==');
  const hit = parseTool(await call('tools/call', {
    name: 'kb_search',
    arguments: { query: '2015 年我在忙什么' },
  }));
  check('置信', hit.confident === true, JSON.stringify(hit).slice(0, 200));
  check('有命中', hit.hits.length > 0);
  check('命中带原文', Boolean(hit.hits[0]?.text));
  check('命中带年份', Boolean(hit.hits[0]?.year));

  console.log('\n== kb_search（越界问）==');
  const miss = parseTool(await call('tools/call', {
    name: 'kb_search',
    arguments: { query: '2019 年我买过特斯拉吗' },
  }));
  check('不置信', miss.confident === false);

  console.log('\n== kb_search（泛化问，走画像）==');
  const self = parseTool(await call('tools/call', {
    name: 'kb_search',
    arguments: { query: '我是个什么样的人' },
  }));
  check('识别为自指问题', self.selfCharacterQuestion === true);
  check('有画像文本', Boolean(self.profileText));
  check('建议走画像', self.shouldUseProfile === true);

  console.log('\n== kb_records ==');
  const rec = parseTool(await call('tools/call', {
    name: 'kb_records',
    arguments: { year: '2012', limit: 5 },
  }));
  check('有结果', rec.records.length > 0, JSON.stringify(rec).slice(0, 200));
  check('年份匹配', rec.records.every((row) => row.year === '2012'));

  console.log('\n== kb_profile ==');
  const profile = parseTool(await call('tools/call', { name: 'kb_profile', arguments: {} }));
  check('有画像', profile.hasProfile === true);
  check('有年度小结', Array.isArray(profile.yearlySummaries) && profile.yearlySummaries.length > 0);

  console.log('\n== kb_ground_check ==');
  const bad = parseTool(await call('tools/call', {
    name: 'kb_ground_check',
    arguments: { answer: '我在 2019 年买了一辆特斯拉 Model 3，售价 35 万。' },
  }));
  check('编造的车型/金额被拦', bad.ok === false, JSON.stringify(bad));
  check('给出原因', bad.reason === 'ungrounded_factual_claim', bad.reason);

  // 「照原话放行」这一项用知识库里真实存在的一条记录来验，
  // 但**不把原文写死在测试里**——测试文件是要分发的，不能夹带用户数据。
  // 这里从检索结果里现取一条，它的正文自然落在全库上下文里。
  const quoteHit = parseTool(await call('tools/call', {
    name: 'kb_search',
    arguments: { query: '2012', topK: 3 },
  }));
  const quoted = quoteHit.hits?.[0]?.text ?? '';
  check('取到一条可用原文', quoted.length > 0);
  const good = parseTool(await call('tools/call', {
    name: 'kb_ground_check',
    arguments: { answer: quoted.replace(/^\[[^\]]+\]\s*/gm, '').trim() },
  }));
  check('照原话放行', good.ok === true, JSON.stringify(good));

  console.log('\n== 未知工具 ==');
  const unknown = await call('tools/call', { name: 'kb_nope', arguments: {} });
  check('返回 isError', unknown.isError === true);

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`);
} catch (error) {
  console.error('冒烟测试异常：', error);
  failures += 1;
} finally {
  child.stdin.end();
  child.kill();
}

process.exit(failures === 0 ? 0 : 1);
