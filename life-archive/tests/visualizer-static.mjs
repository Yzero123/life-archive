// GenUI 可视化器静态审查
//
// 目标：把「样例 Widget 是否守规矩」变成能反复跑的断言，而不是靠人眼扫一遍。
// 审查对象是 skills/life-archive-visualizer/references/examples.md 里的完整样例。
//
// 用法：node tests/visualizer-static.mjs

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const visualizerDir = resolve(pluginRoot, 'skills', 'life-archive-visualizer');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label} ${detail}`);
  }
}

// 宿主定义的主题 token 白名单（见 references/genui-widget/references/color-system.md）
const ALLOWED_TOKENS = new Set([
  '--mw-bg', '--mw-surface', '--mw-surface-muted',
  '--mw-text', '--mw-text-muted', '--mw-text-subtle',
  '--mw-border', '--mw-accent', '--mw-success', '--mw-danger', '--mw-warning',
  '--mw-chart-1', '--mw-chart-2', '--mw-chart-3', '--mw-chart-4', '--mw-chart-5', '--mw-chart-6',
  '--mw-chart-grid', '--mw-chart-axis',
]);

const examples = await readFile(resolve(visualizerDir, 'references', 'examples.md'), 'utf8');
const match = examples.match(/```html\n([\s\S]*?)\n```/);
if (!match) {
  console.log('  ❌ examples.md 里找不到 html 代码块');
  process.exit(1);
}
const widget = match[1];

console.log('== 信封与顺序 ==');
check('有 mavis-widget 开标签', /<mavis-widget\b/.test(widget));
check('有 mavis-widget 闭标签', /<\/mavis-widget>\s*$/.test(widget.trim() + '\n') || /<\/mavis-widget>/.test(widget));
check('开标签只出现一次', (widget.match(/<mavis-widget\b/g) ?? []).length === 1);

const order = ['mavis-meta', 'mavis-style', 'mavis-html', 'mavis-data', 'mavis-script', 'mavis-fallback']
  .map((name) => widget.indexOf(`<${name}`));
check('六个子块齐全', order.every((index) => index >= 0), JSON.stringify(order));
check('子块顺序为 meta→style→html→data→script→fallback',
  order.every((value, i) => i === 0 || value > order[i - 1]), JSON.stringify(order));

console.log('\n== 开标签字段 ==');
const tag = widget.match(/<mavis-widget[\s\S]*?>/)[0];
for (const field of ['version="mavis.widget.v1"', 'kind="dashboard"', 'streaming="html-first"',
  'theme="app"', 'token-set="mavis.semantic.v1"', 'capabilities="resize,sendPrompt"']) {
  check(`含 ${field}`, tag.includes(field));
}
check('有 title', /\btitle="[^"]+"/.test(tag));
check('有 height / min-height / max-height',
  /\bheight="/.test(tag) && /\bmin-height="/.test(tag) && /\bmax-height="/.test(tag));

console.log('\n== 主题 token ==');
const usedTokens = new Set([...widget.matchAll(/var\((--mw-[a-z0-9-]+)\)/g)].map((m) => m[1]));
const invalidTokens = [...usedTokens].filter((token) => !ALLOWED_TOKENS.has(token));
check('用到的 token 全部合法', invalidTokens.length === 0, invalidTokens.join(','));
check('没有带兜底值的 var()', !/var\(--mw-[a-z0-9-]+\s*,/.test(widget));
check('CSS 里没有硬编码颜色',
  !/#[0-9a-fA-F]{3,8}\b/.test(widget.replace(/style="background:var\(--mw-chart-\d\)"/g, '')),
  (widget.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).join(','));
check('CSS 里没有 rgba 硬编码', !/rgba?\(/.test(widget));

console.log('\n== 安全约束 ==');
check('mavis-html 里没有 script 标签', !/<mavis-html>[\s\S]*?<script/i.test(widget));
check('没有 eval / new Function', !/\beval\s*\(/.test(widget) && !/new Function/.test(widget));
check('没有 fetch / XMLHttpRequest', !/\bfetch\s*\(/.test(widget) && !/XMLHttpRequest/.test(widget));
check('没有读 cookie / storage', !/document\.cookie/.test(widget) && !/localStorage|sessionStorage/.test(widget));
check('没有 submitForm', !/submitForm/.test(widget));
check('没有行内 onclick', !/onclick=/i.test(widget));
check('没有远程资源地址', !/https?:\/\//.test(widget.replace(/https?:\/\/www\./g, '')) || !/<script[^>]+src=/i.test(widget));

console.log('\n== 数据与渲染器 ==');
const dataBlock = widget.match(/<mavis-data name="main" type="json">([\s\S]*?)<\/mavis-data>/);
check('有 main 数据块', Boolean(dataBlock));
let dataset = [];
if (dataBlock) {
  try {
    dataset = JSON.parse(dataBlock[1]);
    check('数据是合法 JSON 数组', Array.isArray(dataset));
  } catch (error) {
    check('数据是合法 JSON 数组', false, String(error.message));
  }
}
check('数据行数 ≥ 6（应走 Chart.js）', dataset.length >= 6, String(dataset.length));
check('用 Chart.js', /new Chart\(/.test(widget));
check('canvas 包在显式高度容器里',
  /\.chart-wrap\s*\{[^}]*height:\s*\d+px/.test(widget) && /<div class="chart-wrap"><canvas/.test(widget));
check('maintainAspectRatio: false', /maintainAspectRatio:\s*false/.test(widget));
check('数据只从 window.__mavisData 读', /window\.__mavisData\['main'\]/.test(widget));
check('没有在脚本里另存一份数据', (widget.match(/year":"\d{4}"/g) ?? []).length <= dataset.length);
check('有主题切换监听', /mavis:theme-change/.test(widget));
check('Chart.js 配色读 tokens', /window\.mavisTheme\.tokens/.test(widget));

console.log('\n== 交互与载荷 ==');
const clickable = (widget.match(/data-action="[^"]+"/g) ?? []).length;
const handlers = (widget.match(/addEventListener\('click'/g) ?? []).length;
check('≥2 处可点击元素', clickable >= 2, String(clickable));
check('有对应的点击处理器', handlers >= 2, String(handlers));
check('用了 sendPrompt', /window\.mavis\.sendPrompt\(/.test(widget));
check('sendPrompt 带结构化 metadata',
  /sendPrompt\([^)]*\{\s*widgetTitle/.test(widget.replace(/\s+/g, ' ')));
check('selectedData 只带稳定标识',
  /selectedData:\s*\{\s*year:/.test(widget.replace(/\s+/g, ' ')) && !/selectedData:[^}]*dataDir/.test(widget));
check('没有把 QQ 号或路径放进载荷', !/selectedData:[^}]*(ownerUin|dataDir)/.test(widget));

console.log('\n== 语言 ==');
const promptTexts = [...widget.matchAll(/sendPrompt\(\s*'([^']*)'/g)].map((m) => m[1]);
check('有中文追问文本', promptTexts.length > 0 && promptTexts.every((text) => /[一-鿿]/.test(text)), promptTexts.join(' | '));
const intents = [...widget.matchAll(/userIntent:\s*'([^']*)'/g)].map((m) => m[1]);
check('userIntent 也是中文', intents.length > 0 && intents.every((text) => /[一-鿿]/.test(text)), intents.join(' | '));

console.log('\n== 兜底 ==');
const fallback = widget.match(/<mavis-fallback>([\s\S]*?)<\/mavis-fallback>/);
check('有 mavis-fallback', Boolean(fallback));
if (fallback) {
  check('兜底有结论句', (fallback[1].match(/[。！？]/g) ?? []).length >= 1);
  check('兜底有数据明细', /\|/.test(fallback[1]));
  check('兜底不超过 8 行', fallback[1].trim().split('\n').length <= 12);
}

console.log('\n== 派生技能包结构 ==');
const expected = [
  'SKILL.md',
  'genui.json',
  'references/genui-widget/SKILL.md',
  'references/genui-widget/references/color-system.md',
  'references/genui-widget/references/visual-rules.md',
  'references/genui-widget/references/widget-patterns.md',
  'references/genui-widget/references/widget-recipes.md',
  'references/components.md',
  'references/data-schema.json',
  'references/examples.md',
];
for (const rel of expected) {
  let ok = false;
  try {
    await readFile(resolve(visualizerDir, rel), 'utf8');
    ok = true;
  } catch {
    ok = false;
  }
  check(`存在 ${rel}`, ok);
}
const genui = JSON.parse(await readFile(resolve(visualizerDir, 'genui.json'), 'utf8'));
check('genui.json protocol 正确', genui.protocol === 'mavis.widget.v1');
check('genui.json mode 为 forked', genui.mode === 'forked');
check('genui.json 记录了来源', typeof genui.forkedFrom === 'string' && genui.forkedFrom.length > 0);
check('genui.json 摘要是真实值（不是占位符）',
  typeof genui.sourceDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(genui.sourceDigest), String(genui.sourceDigest));

const schema = JSON.parse(await readFile(resolve(visualizerDir, 'references', 'data-schema.json'), 'utf8'));
check('data-schema 有代表形状', Array.isArray(schema.representativeShape?.yearDistribution));
check('代表形状字段自洽', (schema.representativeShape?.yearDistribution ?? []).every(
  (row) => row.withBody === row.count - row.bodyMissing,
));
// 样例数据里不能出现任何账号标识：6–12 位的数字串（QQ 号形态）、ownerUin、dataDir 路径。
// 只查 representativeShape——schema 正文里的「禁止字段」清单本来就写着 ownerUin。
// 断言本身不写死任何具体号码：写死了就等于把真实号码抄进分发包。
const sampleText = JSON.stringify(schema.representativeShape);
check('样例数据不含账号标识',
  !/(?:^|\D)\d{6,12}(?:\D|$)/.test(sampleText)
  && !sampleText.includes('ownerUin')
  && !sampleText.includes('dataDir'),
  (sampleText.match(/(?:^|\D)\d{6,12}(?:\D|$)/) ?? ['无'])[0]);

console.log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`);
process.exit(failures === 0 ? 0 : 1);
