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
    if (records.length) return { dir, records, dirs };
  }
  return null;
}

/**
 * 找本机的**真实朋友圈原始数据**（2.0）。
 *
 * 朋友圈侧的指纹从真实导出里现算，脚本里同样不写死任何个人信息。
 * 本机还没导入过朋友圈数据时返回 null——那不是失败，是没有可比对的东西。
 */
async function findRealWxRaw(dirs) {
  for (const dir of dirs) {
    const path = join(dir, 'raw/wechat_sns.json');
    if (!existsSync(path)) continue;
    try {
      const payload = JSON.parse(await readFile(path, 'utf8'));
      if (payload && typeof payload === 'object') return { path, payload };
    } catch {
      // 文件在但读不出来，忽略
    }
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

/**
 * 这条记录是不是**我们自己的模板**拼出来的（2.1 的留言 / 点赞）。
 *
 * 判据只能看来源标记——不能看正文形状：正文形状会随文案改动而漂移。
 */
const WX_GENERATED_SOURCES = new Set(['wechat-sns-comment', 'wechat-sns-like']);

function isGeneratedWxRecord(record) {
  const sources = Array.isArray(record?.sources) ? record.sources : [];
  return sources.some((source) => WX_GENERATED_SOURCES.has(source));
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
    addText(record.location);
    addLiteral(record.location);
    // 2.1：留言 / 点赞这两类记录的正文是**我们自己的模板**拼出来的
    // （「【留言】在…下留言」「【点赞】给…点了赞」）。
    //
    // 拿它当指纹，等于把我们自己的话当成了「真实内容」——
    // 于是回扫器扫包时会撞上包里的同一段模板，自己告自己（自撞误报）。
    // 2.1 实测：模板里的「我自己的朋友」「的朋友圈点了」三段全被误判成泄漏。
    //
    // 正确的指纹来源是**原文**：
    //   - `user_voice`   = 我的原话（真的我说过的话）
    //   - `reply_snippet` = 好友原文的截断片段（真的好友写的话）
    // 两者都进指纹，覆盖度不减；少掉的只有我们自己写的模板文案——
    // 那本来就不是身份信息。
    if (isGeneratedWxRecord(record)) {
      addText(record.user_voice);
      addText(record.raw?.reply_snippet);
    } else {
      addText(record.content);
    }
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

  // 文本滑窗：**6 字中文**片段，命中即代表真实内容。
  // 只取中文——否则 URL 里的 "http"、"qzon" 之类会切出一堆假阳性。
  //
  // 为什么是 6 而不是 4：4 字中文窗口在语料一大就会和通用汉语撞车。
  // 2026-10-23 导入了朋友圈正文后，真实语料里出现了「什么样的」「实在不行」
  // 这类**到处都有的普通短语**，4 字窗口把文档里同名的普通表达全判成泄漏——
  // 那是误报，不是泄漏。6 字窗口仍能命中任何成句的真实内容，
  // 而通用短语不再误伤。
  const WINDOW_SIZE = 6;
  const windows = new Set();
  for (const text of texts) {
    const runs = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]{4,}/g) ?? [];
    for (const run of runs) {
      for (let i = 0; i + WINDOW_SIZE <= run.length; i += 1) {
        windows.add(run.slice(i, i + WINDOW_SIZE));
      }
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
// 2b. 微信朋友圈侧的指纹（2.0）
// ---------------------------------------------------------------------------

/**
 * 朋友圈侧的裸标识符。
 *
 * 和 QQ 侧同一套原则：**从真实数据现算，不写死**。
 * 要扫的是：
 *   - 本人 wxid（基名 + 带设备后缀的目录名两种写法）
 *   - 好友 wxid（点赞/评论里的人）
 *   - 动态 snsId（完整 ID）
 *
 * 这些都是「裸标识符」——不带任何上下文关键词。
 * 之前 v1.3.0 的泄漏就是因为扫的是 `mood/<前缀>` 这种带上下文的写法，
 * 包里的裸 ID 反而全漏了。
 */
function buildWxFingerprints(payload) {
  const wxids = new Set();
  const snsIds = new Set();

  const addWxid = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return;
    // 退化值不是标识符：外部工具偶尔把字段名当成值写出来（例如字面量 "wxid"），
    // 或者写空。把它当指纹会把文档里所有正常的 "wxid" 字样全判成泄漏。
    if (text.length < 6) return;
    if (!/[0-9_]/.test(text)) return;
    wxids.add(text);
    // 目录名常带设备后缀（wxid_xxx_4160），基名也要单独收。
    // 但要防一手：像 wxid_<一串数字> 这种「整串都是数字」的账号，
    // 去掉尾缀后只剩 "wxid" 这个字段名——那不是标识符，
    // 收进去会把文档里所有正常的 "wxid" 字样全判成泄漏。
    const base = text.replace(/_\d+$/, '');
    if (base && base !== text && base.length >= 6 && /[0-9_]/.test(base)) wxids.add(base);
  };

  const meta = payload?.meta ?? {};
  addWxid(meta.account);
  addWxid(payload?.owner_wxid);

  const posts = Array.isArray(payload?.posts) ? payload.posts
    : Array.isArray(payload?.moments) ? payload.moments : [];
  for (const post of posts) {
    if (!post || typeof post !== 'object') continue;
    addWxid(post.author ?? post.username ?? post.user_name);
    const id = String(post.id ?? post.tid ?? '').trim();
    if (id) snsIds.add(id);
    for (const like of post.likes ?? []) {
      addWxid(typeof like === 'string' ? like : like?.username);
    }
    for (const comment of post.comments ?? []) {
      addWxid(typeof comment === 'string' ? comment : comment?.username);
    }
  }

  return {
    wxids: [...wxids].filter(Boolean).sort((a, b) => b.length - a.length),
    snsIds: [...snsIds].filter(Boolean).sort((a, b) => b.length - a.length),
  };
}

/**
 * 结构性规则：包内**不允许**出现 wxid 字面量。
 *
 * 这条比「和本机数据比对」更严也更通用——插件永远不该硬编码任何人的账号标识符，
 * 哪怕是「示例里顺手写了一个自己的 wxid」。所以只要包内出现 `wxid_xxxxxxxx`
 * 这种形状的字面量就判失败，除非它明显是占位/合成值。
 */
const WXID_LITERAL = /wxid_[A-Za-z0-9]{6,}/g;
const SYNTHETIC_WXID = /wxid_[A-Za-z0-9]*(demo|example|test|sample|placeholder|your|xxx)/i;

function scanWxLiterals(text) {
  const hits = [];
  for (const match of text.match(WXID_LITERAL) ?? []) {
    if (SYNTHETIC_WXID.test(match)) continue;
    hits.push({ kind: 'wxid 字面量（包内不该硬编码账号标识符）', needle: match });
  }
  return hits;
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
function scanText(text, fp, wxfp) {
  const hits = [];
  const push = (kind, needle) => { if (text.includes(needle)) hits.push({ kind, needle }); };

  for (const qq of fp.qqAll) push('QQ 号', qq);
  for (const id of fp.cellIds) push('说说 ID', id);
  for (const hex of fp.ownerHex) push('cell_id owner 前缀（可反解 QQ 号）', hex);
  for (const hex of fp.cellPrefix16) push('cell_id 16 位前缀（owner + 时间戳）', hex);
  for (const url of fp.urls) push('说说链接', url);
  for (const nick of fp.nicknames) push('昵称 / 地点', nick);
  for (const w of fp.windows) push('真实文本片段', w);

  // 2.0：微信侧的裸标识符
  for (const wxid of wxfp?.wxids ?? []) push('wxid（微信账号标识符）', wxid);
  for (const id of wxfp?.snsIds ?? []) push('朋友圈动态 ID', id);

  // 聚合数字：非身份信息，只提示不拦
  for (const n of fp.numbers) {
    if (!text.includes(n)) continue;
    // 排除命中在 hex 串内部造成的子串假阳性
    const re = new RegExp(`(?<![0-9a-fA-F])${n}(?![0-9a-fA-F])`);
    if (re.test(text)) warnings.push({ kind: '聚合数字（提示级）', needle: n });
  }
  return hits;
}

async function scanTarget(target, label, fp, wxfp) {
  const hits = [];
  if (existsSync(target) && (await stat(target)).isDirectory()) {
    for (const file of await walk(target)) {
      if (!TEXT_EXT.has(extname(file))) continue;
      const text = await readFile(file, 'utf8').catch(() => '');
      if (!text) continue;
      for (const hit of scanText(text, fp, wxfp)) {
        hits.push({ ...hit, where: relative(PKG_ROOT, file) });
      }
      // 结构性规则：包内不许出现 wxid 字面量（和本机数据无关，永远生效）
      for (const hit of scanWxLiterals(text)) {
        hits.push({ ...hit, where: relative(PKG_ROOT, file) });
      }
    }
  } else {
    const text = await readFile(target, 'utf8').catch(() => '');
    hits.push(...scanText(text, fp, wxfp).map((h) => ({ ...h, where: label })));
    hits.push(...scanWxLiterals(text).map((h) => ({ ...h, where: label })));
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
const wxRaw = await findRealWxRaw(real.dirs ?? CANDIDATE_DIRS);
const wxfp = wxRaw ? buildWxFingerprints(wxRaw.payload) : null;
console.log(`  真实知识库：${real.dir}`);
console.log(`  指纹规模：QQ 号 ${fp.qqAll.length} 种写法 / 说说 ID ${fp.cellIds.length} / owner 前缀 ${fp.ownerHex.length} / 文本片段 ${fp.windows.length} / 聚合数字 ${fp.numbers.length}`);
if (wxfp) {
  console.log(`  朋友圈指纹：wxid ${wxfp.wxids.length} 个 / 动态 ID ${wxfp.snsIds.length} 个`);
} else {
  console.log('  ℹ️ 本机没有导入过朋友圈数据，wxid / 动态 ID 的回扫跳过；'
    + '「包内不许出现 wxid 字面量」的结构性规则照常生效。');
}
console.log('');

// ---------------------------------------------------------------------------
// 1b. 回扫器自检：正样本 + 反样本
// ---------------------------------------------------------------------------
// 回扫器自己也要被验，否则改坏了也没人知道。
//   正样本：拿真实指纹去撞，**必须抓得住**——抓不住，这个门形同虚设。
//   反样本：我们自己拼的模板文案**不该被抓**——2.1 之前这里会自撞误报。
console.log('\n[自检] 回扫器正/反样本');

const SELFCHECK_RECORD = {
  id: 'wx-c-selfcheck-0',
  ids: ['wx-c-selfcheck-0'],
  sources: ['wechat-sns-comment'],
  content: '【留言】在我自己的朋友圈下留言\n原文：「好友写的原文」\n留言：「我自己的原话」',
  user_voice: '我自己的原话',
  raw: { reply_snippet: '好友写的原文' },
  location: '',
  comments: [],
  like_users: [],
  published_at: 1700000000,
  like_count: 0,
  comment_count: 0,
  forward_count: 0,
};
const selfFp = buildFingerprints([SELFCHECK_RECORD]);

ok('反样本：我们自己拼的模板文案不进指纹集（2.1 自撞回归）', () => {
  assert(!selfFp.windows.includes('我自己的朋友'), '模板文案进了指纹集');
  assert(!selfFp.windows.includes('的朋友圈下了'), '模板文案进了指纹集');
});
ok('正样本：我的原话与好友原文仍然进指纹集（覆盖度不能减）', () => {
  assert(selfFp.windows.includes('我自己的原话'), '我的原话没进指纹集');
  assert(selfFp.windows.includes('好友写的原文'), '好友原文没进指纹集');
});
if (fp.windows.length) {
  const sample = fp.windows[0];
  ok('正样本：真实文本片段能被回扫器抓住', () => {
    const hits = scanText(`这里有一句引用：${sample}`, fp, wxfp);
    assert(hits.some((h) => h.kind === '真实文本片段' && h.needle === sample), '没抓到');
  });
}
if (fp.nicknames.length) {
  const sample = fp.nicknames[0];
  ok('正样本：真实昵称能被回扫器抓住', () => {
    const hits = scanText(`示例昵称 ${sample}`, fp, wxfp);
    assert(hits.some((h) => h.kind === '昵称 / 地点' && h.needle === sample), '没抓到');
  });
}

console.log('');

const targets = [{ path: PKG_ROOT, label: '包目录' }];
const releasesDir = join(REPO_ROOT, 'releases');
if (existsSync(releasesDir)) {
  for (const name of await readdir(releasesDir)) {
    if (name.endsWith('.zip')) targets.push({ path: join(releasesDir, name), label: name });
  }
}

// 仓库根目录的说明文档也要扫。
// 2.0 的方案文档里曾经写着本机真实 wxid——那和 v1.3.0 文档示例里的真实 cell_id
// 是同一类事故：写文档时「顺手」把真实标识符贴了进去。
const docDirs = new Set([REPO_ROOT, resolve(PKG_ROOT, '..', '..', 'repo-qq-space-kb')]);
for (const dir of docDirs) {
  if (!existsSync(dir)) continue;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    targets.push({ path: join(dir, entry.name), label: `文档 ${entry.name}` });
  }
}
// 同一个目录可能既是 REPO_ROOT 又是工作区里的兄弟目录，去重免得扫两遍。
const seenTargets = new Set();
for (const target of targets) {
  if (seenTargets.has(target.path)) continue;
  seenTargets.add(target.path);
  const hits = await scanTarget(target.path, target.label, fp, wxfp);
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
