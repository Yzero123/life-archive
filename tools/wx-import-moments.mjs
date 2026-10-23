// 朋友圈数据入库：无头把外部工具导出的 JSON 送进插件的真实 HTTP 路由。
//
// 用途
// ----
// 微信朋友圈取数工具导出的是「按联系人分文件」的 JSON，插件要在自己的面板里
// 手动选文件导入。这个脚本把中间那步自动化：起一个指向真实 dataDir 的临时实例，
// 走 **真实路由**（/api/wx/import → /api/wx/switch → /api/kb/build → /api/profile/build），
// 跑完打印验收结果，然后退出。插件运行时会从磁盘读到同一份数据。
//
// 用法
// ----
//   node tools/wx-import-moments.mjs --export <导出的 JSON 路径> \
//        [--data-dir <插件 dataDir>] [--plugin-root <包根>] [--skip-profile]
//
// 默认 dataDir / plugin-root 都能自动探测（macOS 默认安装位置）。
//
// 隐私
// ----
// 脚本不硬编码任何账号、wxid、正文；所有标识都从运行时传入的文件里读出来。
// 它只做「读文件 → 调接口 → 打印条数」，不打印正文。

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--export') args.export = process.argv[++i];
  if (process.argv[i] === '--data-dir') args.dataDir = process.argv[++i];
  if (process.argv[i] === '--plugin-root') args.pluginRoot = process.argv[++i];
  if (process.argv[i] === '--skip-profile') args.skipProfile = true;
}
if (!args.export) {
  console.error('用法：node tools/wx-import-moments.mjs --export <导出的 JSON 路径> [--data-dir <dataDir>]');
  process.exit(1);
}
const EXPORT_PATH = resolve(args.export);
if (!existsSync(EXPORT_PATH)) {
  console.error(`导出的 JSON 不存在：${EXPORT_PATH}`);
  process.exit(1);
}

const detect = (candidates) => candidates.find((c) => existsSync(join(c, 'miniapp', 'node', 'server.mjs'))) || candidates[0];
const PLUGIN_ROOT = args.pluginRoot
  ? resolve(args.pluginRoot)
  : detect([
    join(import.meta.dirname, '..', 'life-archive'),
    join(import.meta.dirname, '..'),
    join(homedir(), '.minimax', 'plugins', 'life-archive'),
  ]);
const DATA_DIR = args.dataDir
  ? resolve(args.dataDir)
  : join(homedir(), '.minimax', 'v2', 'plugin-data', 'liveboards', 'life-archive');

if (!existsSync(join(PLUGIN_ROOT, 'miniapp', 'node', 'server.mjs'))) {
  console.error(`找不到插件包根：${PLUGIN_ROOT}`);
  process.exit(1);
}
if (!existsSync(join(DATA_DIR, 'kb'))) {
  console.error(`找不到插件 dataDir：${DATA_DIR}`);
  process.exit(1);
}

const probe = createNetServer();
const port = await new Promise((resolvePort, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const p = probe.address().port;
    probe.close(() => resolvePort(p));
  });
});

const { start } = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'miniapp', 'node', 'server.mjs')).href);
const lifecycle = await start({
  pluginRoot: PLUGIN_ROOT,
  dataDir: DATA_DIR,
  listen: { host: '127.0.0.1', port },
  signal: new AbortController().signal,
  logger: { info() {}, error() {} },
  // 不挂 agent：画像回落到「统计底座」口径，和用户当前 profile.json 的形态一致。
  // 想让大模型润色，打开插件面板点「重建画像」。
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

try {
  console.log(`插件包根：${PLUGIN_ROOT}`);
  console.log(`dataDir ：${DATA_DIR}`);
  console.log(`待导入 ：${EXPORT_PATH}`);

  const imp = await call('/api/wx/import', { path: EXPORT_PATH });
  console.log(`\n导入   ：ok=${imp.ok} kept=${imp.count ?? '-'} notMine=${imp.notMine ?? '-'}`);
  if (!imp.ok) {
    console.error(`导入失败：${imp.message ?? ''}`);
    process.exitCode = 1;
  } else {
    const sw = await call('/api/wx/switch', { enabled: true });
    console.log(`启用   ：ok=${sw.ok} enabled=${sw.enabled}`);

    const built = await call('/api/kb/build', {});
    const builtStats = built.stats ?? {};
    console.log(`建库   ：ok=${built.ok} 合并后 ${builtStats.totalRecords ?? '?'} 条记录 / ${builtStats.chunkCount ?? '?'} 个知识块`);

    if (!args.skipProfile) {
      await call('/api/profile/build', {});
      // 画像是后台任务，轮询落盘的 profile.json
      for (let i = 0; i < 30; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        const state = await call('/api/state');
        if (state?.profileJob && state.profileJob.running === false) break;
      }
      const profile = await call('/api/profile');
      const facts = String(profile?.facts ?? '');
      console.log(`画像   ：source=${profile?.source ?? '-'}`);
      console.log('──── 画像事实（前 6 行）────');
      for (const line of facts.split('\n').slice(0, 6)) console.log('  ' + line);
    }

    const lines = (await readFile(join(DATA_DIR, 'kb', 'unified.jsonl'), 'utf8')).trim().split('\n').length;
    console.log(`知识库 ：unified.jsonl ${lines} 行`);
  }
} finally {
  await lifecycle.dispose?.();
  // 服务器关掉后事件循环可能还有残留句柄，显式退出，避免脚本挂着不退。
  process.exit(process.exitCode ?? 0);
}
