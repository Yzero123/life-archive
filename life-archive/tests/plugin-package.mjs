// 插件包结构校验
//
// 目标：把「这个包能不能被宿主正确加载」变成能反复跑的断言。
// 覆盖 V1 清单契约、路径规则、包体积限制、能力文件 frontmatter、软链与越界。
//
// 用法：node tests/plugin-package.mjs [插件根目录]

import { readFile, readdir, stat, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(process.argv[2] ?? resolve(fileURLToPath(new URL('..', import.meta.url))));
const manifestPath = join(pluginRoot, '.minimax-plugin', 'plugin.json');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label} ${detail}`);
  }
}

console.log(`== 插件根：${pluginRoot} ==\n`);

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

console.log('== 清单必填字段 ==');
for (const field of ['schemaVersion', 'name', 'version', 'description', 'author', 'icon', 'category', 'exampleQueries', 'apps', 'mcpServers', 'skills']) {
  check(`有 ${field}`, field in manifest);
}
check('schemaVersion 为 1', manifest.schemaVersion === 1, String(manifest.schemaVersion));
check('版本是 SemVer', /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(manifest.version ?? ''), String(manifest.version));
check('name 合法', /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(manifest.name ?? ''), String(manifest.name));
check('apps 为空数组', Array.isArray(manifest.apps) && manifest.apps.length === 0);
check('category 合法', [
  'Office', 'Studio', 'Design & Sites', 'Code', 'Business', 'Sales',
  'Productivity', 'Science & Healthcare', 'Education', 'Other',
].includes(manifest.category), String(manifest.category));
check('exampleQueries 全部非空', (manifest.exampleQueries ?? []).every((q) => String(q).trim().length > 0));
check('至少一个有效能力', (manifest.mcpServers?.length ?? 0) + (manifest.skills?.length ?? 0)
  + (manifest.agents?.length ?? 0) + (manifest.hooks?.length ?? 0) > 0);

console.log('\n== 路径规则 ==');
const segmentPattern = /^[A-Za-z0-9._-]+$/;
async function checkPath(rel) {
  const abs = join(pluginRoot, rel);
  const ok = existsSync(abs);
  const segmentsOk = rel.split('/').every((s) => segmentPattern.test(s) && s !== '.' && s !== '..' && !s.endsWith('.'));
  const portable = !rel.includes('\\') && !rel.startsWith('/') && !rel.includes('..');
  check(`引用 ${rel}`, ok && segmentsOk && portable, ok ? '路径规则不合规' : '文件缺失');
}
for (const rel of [manifest.icon, manifest.darkIcon].filter(Boolean)) await checkPath(rel);
for (const list of ['mcpServers', 'skills', 'agents', 'hooks']) {
  for (const rel of manifest[list] ?? []) await checkPath(rel);
}

console.log('\n== 技能 frontmatter ==');
for (const rel of manifest.skills ?? []) {
  const text = await readFile(join(pluginRoot, rel), 'utf8');
  const fm = text.split('---')[1] ?? '';
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const dirName = rel.split('/').slice(-2, -1)[0];
  check(`${dirName} name 等于目录名`, name === dirName, `${name} vs ${dirName}`);
  check(`${dirName} description 非空`, desc.length > 0);
}

console.log('\n== MCP 服务 ==');
for (const rel of manifest.mcpServers ?? []) {
  const doc = JSON.parse(await readFile(join(pluginRoot, rel), 'utf8'));
  check(`${rel} 有 mcpServers`, typeof doc.mcpServers === 'object' && Object.keys(doc.mcpServers).length > 0);
  for (const [name, spec] of Object.entries(doc.mcpServers ?? {})) {
    check(`${name} 传输合法`, ['stdio', 'streamable-http', 'sse'].includes(spec.type), spec.type);
    check(`${name} name 合法`, /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(name), name);
    if (spec.type === 'stdio') {
      check(`${name} command 无斜杠`, !/[\\/]/.test(spec.command ?? ''), spec.command);
      check(`${name} args 是相对路径`, (spec.args ?? []).every((a) => !a.startsWith('/')));
    }
    const banned = ['auth', 'oauth', 'refreshToken', 'http'];
    check(`${name} 没有未支持字段`, !banned.some((k) => k in spec), Object.keys(spec).join(','));
  }
}

console.log('\n== 子代理 ==');
for (const rel of manifest.agents ?? []) {
  const file = rel.split('/').pop();
  const stem = file.replace(/\.md$/, '');
  const text = await readFile(join(pluginRoot, rel), 'utf8');
  const fm = text.split('---')[1] ?? '';
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  check(`${stem} 文件名合法`, /^[a-z][a-z0-9_-]*\.md$/.test(file), file);
  check(`${stem} name 等于文件名`, name === stem, `${name} vs ${stem}`);
  check(`${stem} description 非空`, desc.length > 0);
  check(`${stem} 没有不支持的字段`,
    !/^(hooks|permissionMode):/m.test(fm) && !/x-mavis\.(avatar|defaultWorkspaceDir)/.test(fm));
  check(`${stem} 没有列 task`, !/^\s*-\s*task\s*$/m.test(fm));
  const scoped = `${manifest.name}:${stem}`;
  check(`委派名 ${scoped} ≤ 64 字符`, scoped.length <= 64, String(scoped.length));
}

console.log('\n== 包体积与文件系统 ==');
let entries = 0;
let files = 0;
let bytes = 0;
const problems = [];
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, item.name);
    entries += 1;
    const info = await lstat(abs);
    if (info.isSymbolicLink()) {
      problems.push(`软链 ${relative(pluginRoot, abs)}`);
      continue;
    }
    if (item.isDirectory()) {
      await walk(abs);
      continue;
    }
    files += 1;
    bytes += info.size;
    if (info.size > 16 * 1024 * 1024) problems.push(`单文件超 16 MiB：${relative(pluginRoot, abs)}`);
    const real = await realpathSafe(abs);
    if (!real.startsWith(resolve(pluginRoot))) problems.push(`越界 ${relative(pluginRoot, abs)}`);
    const rel = relative(pluginRoot, abs);
    if (rel.split(sep).length > 16) problems.push(`路径段过多 ${rel}`);
    for (const seg of rel.split(sep)) {
      if (Buffer.byteLength(seg, 'utf8') > 128) problems.push(`路径段过长 ${rel}`);
    }
  }
}
async function realpathSafe(p) {
  try {
    const { realpath } = await import('node:fs/promises');
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}
await walk(pluginRoot);
check(`条目数 ${entries} ≤ 2048`, entries <= 2048);
check(`文件数 ${files} ≤ 1024`, files <= 1024);
check(`总大小 ${(bytes / 1024 / 1024).toFixed(2)} MiB ≤ 64 MiB`, bytes <= 64 * 1024 * 1024);
check('没有软链或越界文件', problems.length === 0, problems.join('; '));

console.log('\n== 凭证扫描 ==');
const secretPatterns = [
  [/(ghp_|github_pat_|gho_)[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/sk-[A-Za-z0-9]{20,}/, 'OpenAI 风格密钥'],
  [/AKIA[0-9A-Z]{16}/, 'AWS Access Key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
];
const secretHits = [];
for (const rel of await readdir(pluginRoot, { recursive: true })) {
  const abs = join(pluginRoot, rel);
  if (typeof rel !== 'string' || !rel.includes('.')) continue;
  let info;
  try { info = await stat(abs); } catch { continue; }
  if (!info.isFile()) continue;
  const text = await readFile(abs, 'utf8').catch(() => '');
  for (const [pattern, label] of secretPatterns) {
    if (pattern.test(text)) secretHits.push(`${rel}: ${label}`);
  }
}
check('包内无凭证', secretHits.length === 0, secretHits.join('; '));

console.log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`);
process.exit(failures === 0 ? 0 : 1);
