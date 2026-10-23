#!/usr/bin/env node
// 隐私回扫：把本机真实知识库展开成指纹，回扫包内文件与发布 zip。
//
// 为什么要有这个脚本：手写扫描漏过一次。
// v1.3.0 ~ v1.6.2 的文档注释里写着一条**真实说说 ID** 当示例，
// 而说说 ID 的前 8 位十六进制
// 就是空间主人 QQ 号的小端编码——照抄一个 cell_id，等于把 QQ 号写进了包。
// 当时的扫描用的是「带上下文」的关键词（`mood/<前缀>`），
// 而包里的裸 ID 没有 `mood/` 前缀，于是**整个漏掉了**。
//
// 所以这里的指纹一律取**裸标识符**：完整 cell_id、8 位 owner 前缀、
// 16 位前缀、十进制 QQ 号、各种进制的 QQ 号。
//
// 指纹全部**从真实数据现算**，脚本里不写死任何个人信息。
// 本机没有真实知识库时自动跳过（CI / 别人的机器都跑得动）。

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..');

const failures = [];
const warnings = [];
let checks = 0;

function ok(name, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(`${name}：${error.message}`);
    console.log(`  ❌ ${name}：${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// 1. 找到本机真实知识库
// ---------------------------------------------------------------------------

const CANDIDATE_DIRS = [
  process.env.QQSPACE_KB_DATA_DIR,
  join(homedir(), '.minimax/v2/plugin-data/liveboards/qq-space-kb'),
].filter(Boolean);

async function findRealKb() {
  // 先试直给的目录，再扫 liveboards 下的所有插件数据目录
  const dirs = [...CANDIDATE_DIRS];
  const liveboards = join(homedir(), '.minimax/v2/plugin-data/liveboards');
  if (existsSync(liveboards)) {
    for (const name of await readdir(liveboards)) {
      dirs.push(join(liveboards, name));
    }
  }
  for (const dir of dirs) {
    const unified = join(dir, 'kb/unified.jsonl');
    if (!existsSync(unified)) continue;
    const raw = await readFile(unified, 'utf8');
    const records = raw.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    if (records.length) return { dir, records };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. 从真实数据推导指纹
// ---------------------------------------------------------------------------

/** cell_id 前 8 位十六进制 = 空间主人 QQ 号（小端 u32）。 */
function ownerFromCellId(cellId) {
  const hex = String(cellId ?? '').trim();
  if (!/^[0-9a-fA-F]{8,}/.test(hex)) return null;
  const value = Buffer.from(hex.slice(0, 8), 'hex').readUInt32LE(0);
  return value > 0 ? String(value) : null;
}

function buildFingerprints(records) {
  const qqNumbers = new Set();
  const cellIds = new Set();
  const ownerHex = new Set();       // 8 位：能反解出 QQ 号的那一段（**这次漏的就是它**）
  const cellPrefix16 = new Set();  // 16 位：owner + 精确时间戳
  const nicknames = new Set();
  const texts = new Set();          // 正文 / 评论 / 地点
  const urls = new Set();
  const numbers = new Set();

  const addText = (value) => {
    const text = String(value ?? '').trim();
    if (text.length >= 2) texts.add(text);
  };
  /** 昵称 / 地点这类短标识符：单独硬查，不靠滑窗（可能是 ASCII）。
   *  长度下限 3：「匿名」这类通用词不算身份信息，否则满地假阳性。 */
  const addLiteral = (value) => {
    const text = String(value ?? '').trim();
    if (text.length >= 3 && text.length <= 24) nicknames.add(text);
  };
  const addNumber = (value) => {
    const n = Number(value);
    if (Number.isFinite(n) && Math.abs(n) >= 1000) numbers.add(String(Math.trunc(n)));
  };

  for (const record of records) {
    for (const id of [record.id, ...(record.ids ?? [])]) {
      const hex = String(id ?? '').trim();
      if (!hex) continue;
      cellIds.add(hex);
      if (/^[0-9a-fA-F]{8}$/.test(hex)) ownerHex.add(hex);
      if (/^[0-9a-fA-F]{16}$/.test(hex)) cellPrefix16.add(hex);
      if (/^[0-9a-fA-F]{24}$/.test(hex)) {
        ownerHex.add(hex.slice(0, 8));
        cellPrefix16.add(hex.slice(0, 16));
      }
      const owner = ownerFromCellId(hex);
      if (owner) qqNumbers.add(owner);
    }
    if (record.post_url) {
      urls.add(String(record.post_url));
      const m = String(record.post_url).match(/user\.qzone\.qq\.com\/(\d+)/);
      if (m) qqNumbers.add(m[1]);
    }
    addText(record.content);
    addText(record.location);
    addLiteral(record.location);
    for (const user of record.like_users ?? []) {
      if (typeof user === 'string') { addText(user); addLiteral(user); }
      else if (user) {
        const nick = user.nick ?? user.name ?? user.nickname;
        addText(nick); addLiteral(nick);
      }
    }
    for (const comment of record.comments ?? []) {
      if (typeof comment === 'string') { addText(comment); addLiteral(comment); }
      else if (comment) {
        const nick = comment.nick ?? comment.nickname ?? comment.author;
        addText(nick); addLiteral(nick);
        addText(comment.content ?? comment.text);
      }
    }
    for (const key of ['like_count', 'comment_count', 'forward_count', 'published_at', 'first_interaction_at']) {
      addNumber(record[key]);
    }
  }

  // QQ 号的各种进制写法
  const qqAll = new Set();
  for (const qq of qqNumbers) {
    qqAll.add(qq);
    const n = Number(qq);
    if (!Number.isFinite(n) || n <= 0) continue;
    // 注意：Buffer.from(Uint32Array) 会把元素**截断成一个字节**（只留低 8 位），
    // 算出来的 hex 是错的。必须显式 writeUInt32LE/BE。
    const le = Buffer.alloc(4);
    le.writeUInt32LE(n, 0);
    const be = Buffer.alloc(4);
    be.writeUInt32BE(n, 0);
    qqAll.add(le.toString('hex'));
    qqAll.add(be.toString('hex'));
    qqAll.add(le.toString('hex').toUpperCase());
  }

  // 文本滑窗：4 字**中文**片段，命中即代表真实内容。
  // 只取中文——否则 URL 里的 "http"、"qzon" 之类会切出一堆假阳性。
  const windows = new Set();
  for (const text of texts) {
    const runs = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]{4,}/g) ?? [];
    for (const run of runs) {
      for (let i = 0; i + 4 <= run.length; i += 1) windows.add(run.slice(i, i + 4));
    }
  }

  return {
    qqAll: [...qqAll].filter(Boolean).sort((a, b) => b.length - a.length),
    cellIds: [...cellIds].sort((a, b) => b.length - a.length),
    ownerHex: [...ownerHex].sort((a, b) => b.length - a.length),
    cellPrefix16: [...cellPrefix16].sort((a, b) => b.length - a.length),
    nicknames: [...nicknames].sort((a, b) => b.length - a.length),
    urls: [...urls],
    windows: [...windows].sort((a, b) => b.length - a.length),
    numbers: [...numbers].sort((a, b) => b.length - a.length),
  };
}

// ---------------------------------------------------------------------------
// 3. 回扫
// ---------------------------------------------------------------------------

const TEXT_EXT = new Set(['.mjs', '.js', '.ts', '.py', '.md', '.html', '.css', '.json', '.txt', '.yml', '.yaml', '']);
const SKIP_DIR = new Set(['.git', 'node_modules']);

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 在一段文本里找命中。返回 { kind, needle } 列表。 */
function scanText(text, fp) {
  const hits = [];
  const push = (kind, needle) => { if (text.includes(needle)) hits.push({ kind, needle }); };

  for (const qq of fp.qqAll) push('QQ 号', qq);
  for (const id of fp.cellIds) push('说说 ID', id);
  for (const hex of fp.ownerHex) push('cell_id owner 前缀（可反解 QQ 号）', hex);
  for (const hex of fp.cellPrefix16) push('cell_id 16 位前缀（owner + 时间戳）', hex);
  for (const url of fp.urls) push('说说链接', url);
  for (const nick of fp.nicknames) push('昵称 / 地点', nick);
  for (const w of fp.windows) push('真实文本片段', w);

  // 聚合数字：非身份信息，只提示不拦
  for (const n of fp.numbers) {
    if (!text.includes(n)) continue;
    // 排除命中在 hex 串内部造成的子串假阳性
    const re = new RegExp(`(?<![0-9a-fA-F])${n}(?![0-9a-fA-F])`);
    if (re.test(text)) warnings.push({ kind: '聚合数字（提示级）', needle: n });
  }
  return hits;
}

async function scanTarget(target, label, fp) {
  const hits = [];
  if (existsSync(target) && (await stat(target)).isDirectory()) {
    for (const file of await walk(target)) {
      if (!TEXT_EXT.has(extname(file))) continue;
      const text = await readFile(file, 'utf8').catch(() => '');
      if (!text) continue;
      for (const hit of scanText(text, fp)) {
        hits.push({ ...hit, where: relative(PKG_ROOT, file) });
      }
    }
  } else {
    hits.push(...scanText(await readFile(target, 'utf8').catch(() => ''), fp).map((h) => ({ ...h, where: label })));
  }
  return hits;
}

console.log('\n[隐私回扫] 用本机真实数据展开指纹，回扫包内文件与发布 zip\n');

const real = await findRealKb();
if (!real) {
  console.log('  ℹ️ 本机没有找到真实知识库（liveboards/*/kb/unified.jsonl），跳过回扫。');
  console.log('     CI / 别人的机器上这是正常行为。');
  console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项`);
  process.exit(failures.length ? 1 : 0);
}

const fp = buildFingerprints(real.records);
console.log(`  真实知识库：${real.dir}`);
console.log(`  指纹规模：QQ 号 ${fp.qqAll.length} 种写法 / 说说 ID ${fp.cellIds.length} / owner 前缀 ${fp.ownerHex.length} / 文本片段 ${fp.windows.length} / 聚合数字 ${fp.numbers.length}\n`);

const targets = [{ path: PKG_ROOT, label: '包目录' }];
const releasesDir = join(REPO_ROOT, 'releases');
if (existsSync(releasesDir)) {
  for (const name of await readdir(releasesDir)) {
    if (name.endsWith('.zip')) targets.push({ path: join(releasesDir, name), label: name });
  }
}

for (const target of targets) {
  const hits = await scanTarget(target.path, target.label, fp);
  ok(`${target.label} 无真实身份信息`, () => {
    assert(hits.length === 0, hits.slice(0, 5).map((h) => `${h.where} ← ${h.kind} ${JSON.stringify(h.needle)}`).join('；'));
  });
}

console.log('\n' + '='.repeat(56));
console.log(`通过 ${checks} 项，失败 ${failures.length} 项`);
if (warnings.length) {
  const unique = [...new Set(warnings.map((w) => w.needle))];
  console.log(`提示级命中 ${unique.length} 个聚合数字（不是身份信息，不拦）：${unique.slice(0, 8).join('、')}${unique.length > 8 ? ' …' : ''}`);
}
if (failures.length) {
  console.log('\n失败明细：');
  for (const item of failures) console.log(`  ❌ ${item}`);
  process.exit(1);
}
console.log('✅ 全部通过');
