// 真实实例链路演练：在**真实插件 dataDir** 上跑一遍
//   导入 → 启用 → 重建 → 双源画像 → 清空 → 重建 → 回到纯 1.0
// 全程用合成朋友圈数据（不含任何真实信息），最后把 dataDir 还原成演练前的状态。
//
// 用途：把「第一次用的人」的完整验收路径在真实环境预演一遍，
// 而不是只在测试目录里跑单元测试。
//
// 用法：
//   node tools/real-instance-drill.mjs --data-dir <dataDir> [--plugin-root <包根>]
//
// 退出码：0 = 全程通过且已还原；1 = 有环节失败（dataDir 已尽力还原）

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--data-dir') args.dataDir = process.argv[++i];
  if (process.argv[i] === '--plugin-root') args.pluginRoot = process.argv[++i];
}
if (!args.dataDir) {
  console.error('用法：node tools/real-instance-drill.mjs --data-dir <dataDir> [--plugin-root <包根>]');
  process.exit(1);
}
const DATA_DIR = args.dataDir;
// 包根自动探测：仓库里是 qq-space-kb/ 子目录，脱离仓库时是上一级。
const detectPluginRoot = () => {
  const candidates = [join(import.meta.dirname, '..'), join(import.meta.dirname, '..', 'qq-space-kb')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'miniapp', 'node', 'server.mjs'))) return candidate;
  }
  return candidates[0];
};
const PLUGIN_ROOT = args.pluginRoot || detectPluginRoot();

const steps = [];
const record = (name, ok, detail = '') => {
  steps.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
};

const mockAgent = {
  async run() { return { sessionId: 'drill', status: 'finished', text: '合成画像' }; },
  async reply() {},
};

// ── 0. 备份真实 dataDir ────────────────────────────────────────────────
const backupDir = await mkdtemp(join(tmpdir(), 'drill-backup-'));
console.log('【0】备份真实 dataDir');
for (const item of ['state.json', 'kb', 'raw']) {
  try {
    await cp(join(DATA_DIR, item), join(backupDir, item), { recursive: true });
    record(`备份 ${item}`, true);
  } catch (error) {
    record(`备份 ${item}`, false, String(error?.code ?? error));
  }
}

// ── 1. 记录演练前的基线 ────────────────────────────────────────────────
console.log('\n【1】记录基线');
const readProfile = async () => {
  try {
    return JSON.parse(await readFile(join(DATA_DIR, 'kb', 'profile.json'), 'utf8'));
  } catch {
    return null;
  }
};
const baselineProfile = await readProfile();
const baselineLines = (await readFile(join(DATA_DIR, 'kb', 'unified.jsonl'), 'utf8')).trim().split('\n').length;
record('读到演练前画像', Boolean(baselineProfile), `unified ${baselineLines} 行`);
const baselineFacts = String(baselineProfile?.facts ?? baselineProfile?.text ?? '');
record('基线是纯 1.0 口径', /条说说/.test(baselineFacts) && !/微信朋友圈/.test(baselineFacts),
  baselineFacts.slice(0, 60).replace(/\s+/g, ' '));

// ── 2. 起一个指向真实 dataDir 的临时实例 ──────────────────────────────
console.log('\n【2】起临时实例（真实 dataDir）');
const probe = createNetServer();
const port = await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const p = probe.address().port;
    probe.close(() => resolve(p));
  });
});
const { start } = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'miniapp', 'node', 'server.mjs')).href);
const lifecycle = await start({
  pluginRoot: PLUGIN_ROOT,
  dataDir: DATA_DIR,
  listen: { host: '127.0.0.1', port },
  signal: new AbortController().signal,
  logger: { info() {}, error() {} },
  agent: mockAgent,
});
const base = `http://127.0.0.1:${port}`;
const call = async (p, body) => {
  const res = await fetch(`${base}${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res.json();
};

// ── 3. 造一份合法的合成 payload ───────────────────────────────────────
console.log('\n【3】生成合成朋友圈 payload');
const seedDir = await mkdtemp(join(tmpdir(), 'drill-seed-'));
await execFileAsync('node', [join(PLUGIN_ROOT, 'tests', 'fixtures', 'seed-wx-demo.mjs'), '--data-dir', seedDir]);
const payload = JSON.parse(await readFile(join(seedDir, 'raw', 'wechat_sns.json'), 'utf8'));
record('合成 payload 就绪', Array.isArray(payload.posts), `${payload.posts?.length ?? 0} 条`);

// ── 4. 走真实 HTTP 路由：导入 → 启用 → 重建 → 画像 ─────────────────────
console.log('\n【4】导入 → 启用 → 重建 → 画像');
const imp = await call('/api/wx/import', { payload });
record('POST /api/wx/import 成功', imp.ok === true, `kept=${imp.count} notMine=${imp.notMine} owner=${imp.owner}`);
const sw = await call('/api/wx/switch', { enabled: true });
record('POST /api/wx/switch 成功', sw.ok === true && sw.enabled === true);
const built = await call('/api/kb/build', {});
record('POST /api/kb/build 成功', built.ok === true, `合并后 ${built.merged ?? built.count ?? '?'} 条`);
await call('/api/profile/build', {});
await new Promise((r) => setTimeout(r, 1200));
const dualProfile = await call('/api/profile');
const dualFacts = String(dualProfile?.facts ?? '');
record('画像变成双源口径', /微信朋友圈/.test(dualFacts) && !/条说说/.test(dualFacts), dualFacts.slice(0, 70).replace(/\s+/g, ' '));
record('画像含朋友圈专属维度', /发圈节奏|发布时段|媒体偏好|朋友圈/.test(dualFacts), '');
const dualLines = (await readFile(join(DATA_DIR, 'kb', 'unified.jsonl'), 'utf8')).trim().split('\n').length;
record('unified.jsonl 变长', dualLines > baselineLines, `${baselineLines} → ${dualLines}`);

// ── 5. 关掉 → 重建 → 必须回到纯 1.0 ───────────────────────────────────
console.log('\n【5】关掉朋友圈 → 重建 → 必须回到纯 1.0');
await call('/api/wx/switch', { enabled: false });
const rebuilt = await call('/api/kb/build', {});
record('POST /api/kb/build 成功', rebuilt.ok === true);
await call('/api/profile/build', {});
await new Promise((r) => setTimeout(r, 1200));
const backProfile = await call('/api/profile');
const backFacts = String(backProfile?.facts ?? '');
record('画像回到纯 1.0 口径', /条说说/.test(backFacts) && !/微信朋友圈/.test(backFacts), backFacts.slice(0, 70).replace(/\s+/g, ' '));
const backLines = (await readFile(join(DATA_DIR, 'kb', 'unified.jsonl'), 'utf8')).trim().split('\n').length;
record('unified.jsonl 行数回到基线', backLines === baselineLines, `${dualLines} → ${backLines}`);

// ── 6. 清空朋友圈原始数据 ─────────────────────────────────────────────
console.log('\n【6】清空朋友圈原始数据');
const cleared = await call('/api/wx/clear', {});
record('POST /api/wx/clear 成功', cleared.ok === true);
const status = await call('/api/wx/status');
record('状态回到「未导入 / 已关闭」', status.imported === false && status.enabled === false, JSON.stringify(status).slice(0, 120));

await lifecycle.dispose();

// ── 7. 还原 dataDir（无论成败都还原） ─────────────────────────────────
console.log('\n【7】还原 dataDir');
let restored = true;
try {
  for (const item of ['state.json', 'kb', 'raw']) {
    await rm(join(DATA_DIR, item), { recursive: true, force: true });
    await cp(join(backupDir, item), join(DATA_DIR, item), { recursive: true });
  }
  record('dataDir 已还原为演练前状态', true);
} catch (error) {
  restored = false;
  record('dataDir 还原失败', false, String(error?.message ?? error));
}
await rm(backupDir, { recursive: true, force: true });
await rm(seedDir, { recursive: true, force: true });

const failed = steps.filter((s) => !s.ok);
console.log('\n' + '='.repeat(56));
console.log(`通过 ${steps.length - failed.length} 步，失败 ${failed.length} 步`);
if (failed.length) {
  console.log('\n失败明细：');
  for (const item of failed) console.log(`  ❌ ${item.name} ${item.detail}`);
}
console.log(restored ? '✅ dataDir 已还原' : '⚠️ dataDir 还原失败，需要手动检查');
process.exit(failed.length ? 1 : 0);
