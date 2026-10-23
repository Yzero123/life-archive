// 「一次扫码」改造的回归测试
//
// 目标：把「登录态全程保留、只扫一次码」这件事变成能反复跑的断言，
// 免得以后改代码又退回「导出开一个浏览器、回溯再开一个浏览器」的老路。
//
// 覆盖四层：
//   1. tools/qzone_session.js   —— 常驻浏览器会话管理器的命令行契约
//   2. tools/qzone_feed_recover.js —— 探针必须复用常驻浏览器（--cdp）
//   3. miniapp/node/export-runner.py —— 编排器：后台化 + 失败也保留会话
//   4. miniapp/node/server.mjs + client —— 后端接线与页面提示
//
// 运行：node tests/export-session.mjs
// 环境变量：
//   QQSPACE_KB_TEST_TOOL_DIR  导出工具目录（默认 /tmp/qq-space-export-work/get-qzone-history）
//                              里面有 node_modules/playwright 才会跑真实浏览器用例

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

let passed = 0;
let failed = 0;
let skipped = 0;
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

function skip(name, why) {
  skipped += 1;
  console.log(`  ⏭️  ${name}（跳过：${why}）`);
}

/** 跑一个 node 脚本，把 stdout 里的 JSON 解析出来。 */
async function runJson(cmd, args, options = {}) {
  const { stdout } = await execFileAsync(cmd, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120000,
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 8 * 1024 * 1024,
  });
  const text = String(stdout || '').trim();
  const firstBrace = text.indexOf('{');
  if (firstBrace < 0) throw new Error(`没有 JSON 输出：${text.slice(0, 200)}`);
  return JSON.parse(text.slice(firstBrace));
}

/** 跑一个 python3 片段，拿 stdout 的 JSON。 */
async function runPython(code, options = {}) {
  const { stdout } = await execFileAsync('python3', ['-c', code], {
    encoding: 'utf8',
    timeout: options.timeout ?? 60000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(String(stdout || '').trim());
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 常驻浏览器的登记与清理
//
// 这套测试会真的拉起系统 Chrome。每一处起浏览器的用例都要登记它的
// session 状态文件，结束时统一 stop —— 测试不能给用户留一堆后台 Chrome。
// ---------------------------------------------------------------------------
const sessionStateFiles = [];

/** 登记一个 session 状态文件，等它出现后 stop 掉对应的常驻浏览器。 */
function trackSession(statePath) {
  if (statePath) sessionStateFiles.push(statePath);
}

/** 等状态文件出现（最多等 timeoutMs），出现后关掉浏览器。 */
async function stopTrackedSession(statePath, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      await execFileAsync('node', [sessionScript, 'stop', '--state', statePath], {
        encoding: 'utf8', timeout: 30000, env: { ...process.env, ...nodeEnv },
      }).catch(() => {});
      if (existsSync(statePath)) {
        try {
          const state = JSON.parse(await readFile(statePath, 'utf8'));
          if (!isPidAlive(state.pid)) return;
        } catch {
          return;
        }
      } else {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---------------------------------------------------------------------------
// 0. 准备
// ---------------------------------------------------------------------------
const tmpRoot = await mkdtemp(join(tmpdir(), 'qqz-test-'));
const sessionScript = join(pluginRoot, 'tools', 'qzone_session.js');
const probeScript = join(pluginRoot, 'tools', 'qzone_feed_recover.js');
const runnerScript = join(pluginRoot, 'miniapp', 'node', 'export-runner.py');

const TOOL_DIR = process.env.QQSPACE_KB_TEST_TOOL_DIR
  || '/tmp/qq-space-export-work/get-qzone-history';
const NODE_MODULES = join(TOOL_DIR, 'node_modules');
const hasPlaywright = (() => {
  try {
    require.resolve('playwright', { paths: [NODE_MODULES] });
    return true;
  } catch {
    return false;
  }
})();
const hasChrome = existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  || existsSync('/usr/bin/google-chrome')
  || existsSync('/usr/bin/chromium');
const nodeEnv = hasPlaywright ? { NODE_PATH: NODE_MODULES } : {};

console.log('== 1. 常驻浏览器会话管理器（tools/qzone_session.js）==\n');

const noSessionState = join(tmpRoot, 'no-session.json');
for (const command of ['status', 'revisit']) {
  const out = await runJson('node', [sessionScript, command, '--state', noSessionState]);
  check(`${command}：没有会话文件时如实报告 no_session`, () => {
    assert.equal(out.ok, false);
    assert.equal(out.alive, false);
    assert.equal(out.reason, 'no_session');
  });
}
{
  const out = await runJson('node', [sessionScript, 'stop', '--state', noSessionState]);
  check('stop：没有会话文件时不报错、也不误杀', () => {
    assert.equal(out.ok, true);
    assert.equal(out.stopped, false);
    assert.equal(out.reason, 'no_session');
  });
}
{
  // 状态文件在、进程早没了
  const deadState = join(tmpRoot, 'dead.json');
  await execFileAsync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(deadState)}, JSON.stringify({pid:999999,port:1,cdpUrl:'http://127.0.0.1:1'}))`]);
  const out = await runJson('node', [sessionScript, 'status', '--state', deadState]);
  check('status：进程已死时报告 alive=false', () => {
    assert.equal(out.alive, false);
    assert.equal(out.pid, 999999);
  });
}
{
  const source = await readFile(sessionScript, 'utf8');
  check('start：Chrome 以 detached 方式独立进程组启动（脚本退出不会带走它）', () => {
    assert.ok(/detached:\s*true/.test(source), '缺少 detached: true');
    assert.ok(/child\.unref\(\)/.test(source), '缺少 unref()');
  });
  check('登录就绪判据要求 uin + p_skey（与探针一致）', () => {
    assert.ok(/loginReady\s*=\s*Boolean\(login\.uin\s*&&\s*login\.hasPSkey\)/.test(source),
      'loginReady 判据不是 uin && hasPSkey');
    assert.ok(/c\.name\s*===\s*'p_skey'\s*&&\s*String\(c\.value\s*\|\|\s*''\)\.length\s*>\s*10/.test(source),
      'p_skey 长度判据缺失');
  });
  check('revisit：靠 SSO 补 cookie，不要求重新扫码', () => {
    assert.ok(/async function revisit/.test(source));
    assert.ok(/goto\(LOGIN_URL/.test(source), 'revisit 没有回到空间首页');
  });
  check('常驻浏览器只有一个来源：状态文件里的同一个 pid', () => {
    assert.ok(/readState\(args\.state\)/.test(source));
    assert.ok(/isAlive\(existing\.pid\)/.test(source), '复用逻辑没有校验进程是否还活着');
  });
}

console.log('\n== 2. 回溯探针必须复用常驻浏览器（--cdp）==\n');
{
  const source = await readFile(probeScript, 'utf8');
  check('带 --cdp 时跳过本地 profile 检查', () => {
    assert.ok(/if \(!args\.cdp\s*&&\s*!fs\.existsSync\(PROFILE_DIR\)\)/.test(source),
      'CDP 模式仍然强制要求本地 profile 目录');
  });
  check('CDP 连不上时报错退出，而不是悄悄退回自己开浏览器', () => {
    assert.ok(/return 4;/.test(source), 'CDP 连接失败没有单独的退出码');
    assert.ok(/连不上常驻浏览器/.test(source), 'CDP 连接失败没有明确文案');
  });
  check('CDP 模式下的收尾只断开客户端，不关浏览器', () => {
    assert.ok(/if \(browser\)[\s\S]{0,200}browser\.close\(\)/.test(source),
      'CDP 模式没有走 browser.close()（只断开客户端）');
  });
}
{
  // 老路径保持原样：缺 profile 目录就明确报错，不去下载 chromium
  const out = await execFileAsync('node', [
    probeScript,
    '--target-qq', '10000',
    '--profile-dir', join(tmpRoot, 'no-such-profile'),
    '--out', join(tmpRoot, 'archive.json'),
    '--work-dir', tmpRoot,
  ], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...nodeEnv } }).catch((e) => e);
  const code = out.code ?? 1;
  const stderr = String(out.stderr || '');
  check('不传 --cdp 且没有 profile 目录时明确退出（老路径行为不变）', () => {
    assert.equal(code, 3, `期望退出码 3，实际 ${code}；stderr=${stderr.slice(0, 200)}`);
    assert.ok(/chrome-profile/.test(stderr), '错误信息没有说清缺的是 chrome-profile');
  });
}

console.log('\n== 3. 导出编排器（miniapp/node/export-runner.py）==\n');
{
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("runner", ${JSON.stringify(runnerScript)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
class A: pass
a = A()
a.start_page, a.end_page, a.page_wait_ms = 1, 200, 20000
a.segment_pages, a.segment_pause_ms, a.owner = 10, 180000, "10000"
cmd = mod.build_export_cmd(a, "/tmp/tool", "http://127.0.0.1:5599")
print(json.dumps({"cmd": cmd, "joined": " ".join(cmd)}))
`;
  const out = await runPython(code);
  check('抓取命令一定带 --connect-cdp（复用常驻浏览器的登录态）', () => {
    assert.ok(out.cmd.includes('--connect-cdp'), '命令里没有 --connect-cdp');
    assert.equal(out.cmd[out.cmd.indexOf('--connect-cdp') + 1], 'http://127.0.0.1:5599');
  });
  check('抓取命令不再自己 launch 浏览器（没有 profile 参数）', () => {
    assert.ok(!out.joined.includes('--profile-dir'), '命令里出现了本地 profile 参数');
  });
}
{
  const source = await readFile(runnerScript, 'utf8');
  check('抓取进程用独立进程组挂后台（工具调用超时不会带走它）', () => {
    assert.ok(/start_new_session=True/.test(source), '没有 start_new_session=True');
  });
  check('前台调用只负责拉起 worker，自己立刻返回', () => {
    assert.ok(/--worker/.test(source) && /Popen\(/.test(source));
  });
  check('登录超时的报错明确说「浏览器还开着，不用重启」', () => {
    assert.ok(/不用重启任何东西/.test(source), '失败文案没有保住会话的提示');
  });
  check('状态文件里带 cdpUrl / browserPid（回溯要靠它复用）', () => {
    assert.ok(/"cdpUrl"/.test(source) && /"browserPid"/.test(source));
  });
}
{
  // 前台调用必须立刻返回（实测 0.1 秒量级），不能等扫码
  const workDir = join(tmpRoot, 'work');
  const statusPath = join(tmpRoot, 'status.json');
  await mkdir(join(workDir, 'get-qzone-history', 'node_modules'), { recursive: true });
  // 编排器的 worker 会自己起一个常驻浏览器，登记它，结束时统一关掉
  trackSession(join(workDir, 'qzone-session.json'));
  const started = Date.now();
  const out = await execFileAsync('python3', [
    runnerScript,
    '--status', statusPath,
    '--plugin-root', pluginRoot,
    '--work-dir', workDir,
    '--login-wait', '10',
  ], { encoding: 'utf8', timeout: 30000 });
  const elapsed = Date.now() - started;
  const stdout = String(out.stdout || '');
  check('前台调用立刻返回（不挂在 HTTP 请求上等扫码）', () => {
    assert.ok(elapsed < 5000, `耗时 ${elapsed}ms，太慢`);
    assert.ok(/后台启动/.test(stdout), '没有提示后台启动');
  });
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  check('状态文件先落 state=scheduled', () => {
    assert.equal(status.state, 'scheduled');
    assert.ok(typeof status.message === 'string' && status.message.length > 0);
  });
  check('状态文件带 updatedAt（Agent 用它判断是否卡住）', () => {
    assert.ok(typeof status.updatedAt === 'number');
  });
}

console.log('\n== 4. 后端接线（miniapp/node/server.mjs）==\n');
const serverSource = await readFile(join(pluginRoot, 'miniapp', 'node', 'server.mjs'), 'utf8');
{
  const instruction = serverSource.slice(
    serverSource.indexOf('const EXPORT_INSTRUCTION'),
    serverSource.indexOf('const CHAT_SYSTEM'),
  );
  check('导出指令要求复用常驻浏览器（回溯必须带 --cdp）', () => {
    assert.ok(instruction.includes('--cdp'), '指令里没有提 --cdp');
    assert.ok(/别那样用|不要自己开浏览器/.test(instruction), '指令没有禁止退回老路径');
  });
  check('导出指令不再要求「回溯时再登一次」', () => {
    assert.ok(!/回溯探针必须在自己的浏览器窗口里\*\*再登一次\*\*/.test(instruction));
    assert.ok(!/别指望复用上一次的登录态/.test(instruction), '指令里还留着「登录态复用不了」的老结论');
  });
  check('导出指令把「只扫一次」讲清楚', () => {
    assert.ok(/只扫码一次|只需要扫一次|全程只/.test(instruction), '指令没有说明只扫一次');
  });
  check('导出指令用 <PLUGIN_ROOT> / <WORK_DIR> 占位符', () => {
    assert.ok(instruction.includes('<PLUGIN_ROOT>'));
    assert.ok(instruction.includes('<WORK_DIR>'));
  });
  check('startExport 注入全部占位符', () => {
    for (const key of ['<RAW_DIR>', '<RUNNER_PATH>', '<STATUS_PATH>', '<PLUGIN_ROOT>', '<WORK_DIR>']) {
      assert.ok(serverSource.includes(`replaceAll('${key}'`), `没有替换 ${key}`);
    }
  });
  check('运行器被告知插件根目录（要找 tools/ 下的会话管理器）', () => {
    assert.ok(serverSource.includes('--plugin-root'), '没有传 --plugin-root');
  });
  check('snapshot 暴露导出会话状态（页面要显示浏览器是否还活着）', () => {
    assert.ok(/exportSession/.test(serverSource));
    assert.ok(/browserAlive/.test(serverSource), '没有 browserAlive 字段');
    assert.ok(/loginReady/.test(serverSource), '没有 loginReady 字段');
  });
  check('重复点击「开始导出」会被拦住（两个抓取进程会抢同一个浏览器）', () => {
    assert.ok(/后台抓取还在运行/.test(serverSource));
  });
  check('停止导出不会关掉浏览器（登录态要留着）', () => {
    assert.ok(!/stopExport[\s\S]{0,400}kill|stopExport[\s\S]{0,400}mavis-trash/.test(serverSource),
      'stopExport 里出现了杀进程的动作');
  });
  check('会话状态不泄露完整 CDP 地址以外的敏感信息', () => {
    assert.ok(/cdpEndpoint/.test(serverSource));
  });
  check('旧版状态文件（没有 browserPid）不当成会话', () => {
    assert.ok(
      /if \(!\('browserPid' in status\)\) return null;/.test(serverSource),
      '缺少旧格式判别，页面会误报「浏览器已关闭」',
    );
  });
}

console.log('\n== 5. 页面提示（miniapp/client/index.html）==\n');
{
  const html = await readFile(join(pluginRoot, 'miniapp', 'client', 'index.html'), 'utf8');
  check('页面有登录会话状态块', () => {
    assert.ok(html.includes('id="session-box"'));
    assert.ok(html.includes('function renderSession'));
    assert.ok(html.includes('renderSession(state.exportSession)'));
  });
  check('页面明确说「只需要扫码一次」', () => {
    assert.ok(/只需要扫码一次|只需要扫一次/.test(html), '页面没有一次扫码的提示');
  });
  check('页面提示不要关掉浏览器窗口', () => {
    assert.ok(/不要关掉/.test(html));
  });
  check('会话块只用 --mcode-* 变量（浅/深色都跟着主题）', () => {
    const block = html.slice(html.indexOf('.session {'), html.indexOf('.session[data-state=\'off\'] .session-dot'));
    const vars = block.match(/var\(--[a-z-]+\)/g) ?? [];
    const bad = vars.filter((v) => !v.startsWith('var(--mcode-'));
    assert.equal(bad.length, 0, `出现了非主题变量：${bad.join(', ')}`);
  });
  check('会话块没有硬编码颜色', () => {
    const block = html.slice(html.indexOf('.session {'), html.indexOf('.session[data-state=\'off\'] .session-dot'));
    assert.ok(!/#[0-9a-fA-F]{3,8}/.test(block), '会话块里出现了硬编码色值');
  });

  check('「构建知识库」按钮在「导出与建库」面板里，不在页头', () => {
    const headerEnd = html.indexOf('</header>');
    const header = html.slice(0, headerEnd);
    assert.ok(!header.includes('id="btn-build"'), '按钮还在页头里，用户容易看不见');
    const panelStart = html.indexOf('id="setup-title"');
    const panel = html.slice(panelStart);
    assert.ok(panel.includes('id="btn-build"'), '面板里没有「构建知识库」按钮');
    assert.ok(panel.indexOf('id="btn-export"') < panel.indexOf('id="btn-build"'),
      '「构建知识库」应该排在「开始导出」后面');
  });

  check('顶部状态栏按 kbReady 派生（phase 回到 idle 也要显示「知识库就绪」）', () => {
    assert.ok(/kbReady/.test(html), '页面没有用 kbReady');
    assert.ok(/displayPhase/.test(html), '没有派生显示用的阶段');
    assert.ok(/setStep\('ready',\s*state\.kbReady\s*\?\s*'done'\s*:\s*'idle'\)/.test(html),
      '第 3 步没有按 kbReady 判断');
  });

  check('页面提示知识库数据是否过期（kbStale）', () => {
    assert.ok(/kbStale/.test(html));
    assert.ok(html.includes('id="stale-note"'), '没有过期提示的占位');
    assert.ok(/重新构建知识库/.test(html), '没有告诉用户怎么刷新');
  });

  check('「构建知识库」按钮在没有原始数据时不可点', () => {
    assert.ok(/state\.hasMessages\s*\|\|\s*state\.hasArchive/.test(html));
  });
}

console.log('\n== 6. 真实浏览器会话（需要系统 Chrome + playwright）==\n');
if (!hasChrome) {
  skip('常驻浏览器存活性用例', '本机没有系统 Chrome');
} else if (!hasPlaywright) {
  skip('常驻浏览器存活性用例', `没有可用的 playwright（${TOOL_DIR}/node_modules）`);
} else {
  const profileDir = join(tmpRoot, 'profile');
  const statePath = join(tmpRoot, 'session.json');
  trackSession(statePath);
  let started = null;
  try {
    started = await runJson('node', [
      sessionScript, 'start', '--profile-dir', profileDir, '--state', statePath,
    ], { env: nodeEnv, timeout: 60000 });
    check('start：拉起常驻浏览器并回报 CDP 端点', () => {
      assert.equal(started.ok, true);
      assert.ok(started.pid, '没有 pid');
      assert.ok(started.port > 0, '没有调试端口');
      assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(started.cdpUrl), `CDP 地址不对：${started.cdpUrl}`);
    });
    check('脚本退出后浏览器仍然活着（detached + unref 生效）', () => {
      assert.ok(isPidAlive(started.pid), '浏览器进程已经没了');
    });
    const status = await runJson('node', [
      sessionScript, 'status', '--profile-dir', profileDir, '--state', statePath,
    ], { env: nodeEnv, timeout: 60000 });
    check('status：能连上并报告存活与登录态', () => {
      assert.equal(status.alive, true);
      assert.equal(status.loginReady, false, '没扫码却报登录就绪');
      assert.ok(status.login && 'uin' in status.login, '没有回 uin 字段');
    });
    const again = await runJson('node', [
      sessionScript, 'start', '--profile-dir', profileDir, '--state', statePath,
    ], { env: nodeEnv, timeout: 60000 });
    check('再次 start：复用同一个浏览器，不会再弹一个窗口', () => {
      assert.equal(again.reused, true);
      assert.equal(again.pid, started.pid);
      assert.equal(again.port, started.port);
    });
  } finally {
    if (started?.pid) {
      await execFileAsync('node', [sessionScript, 'stop', '--state', statePath], {
        encoding: 'utf8', timeout: 30000, env: nodeEnv,
      }).catch(() => {});
    }
  }
}

console.log('\n== 7. 编排器失败也保留会话（需要系统 Chrome + playwright）==\n');
if (!hasChrome) {
  skip('失败保留会话用例', '本机没有系统 Chrome');
} else if (!hasPlaywright) {
  skip('失败保留会话用例', `没有可用的 playwright（${TOOL_DIR}/node_modules）`);
} else {
  const workDir = join(tmpRoot, 'work2');
  const statusPath = join(tmpRoot, 'status2.json');
  await mkdir(join(workDir, 'get-qzone-history', 'node_modules'), { recursive: true });
  trackSession(join(workDir, 'qzone-session.json'));
  await execFileAsync('python3', [
    runnerScript,
    '--status', statusPath,
    '--plugin-root', pluginRoot,
    '--work-dir', workDir,
    '--login-wait', '10',
  ], { encoding: 'utf8', timeout: 30000 });

  // 等 worker 跑完登录等待（最短 10 秒）
  let status = null;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      status = JSON.parse(await readFile(statusPath, 'utf8'));
    } catch {
      continue;
    }
    if (status.state === 'failed' || status.state === 'exporting') break;
  }
  try {
    check('登录等待超时后状态是 failed 且给出可操作提示', () => {
      assert.equal(status.state, 'failed', `状态是 ${status?.state}`);
      assert.ok(/确认登录/.test(status.error || ''), '错误文案没提「确认登录」');
      assert.ok(/不用重启任何东西/.test(status.error || ''), '错误文案没提「不用重启任何东西」');
    });
    check('失败后状态里仍带着常驻浏览器的 pid 与 CDP 端点', () => {
      assert.ok(status.browserPid, '状态里没有 browserPid');
      assert.ok(status.cdpUrl, '状态里没有 cdpUrl');
    });
    check('失败之后浏览器还活着（登录机会保住，可以直接补扫）', () => {
      assert.ok(isPidAlive(status.browserPid), '浏览器进程已经没了');
    });
  } finally {
    if (status?.browserPid) {
      const sessionState = join(workDir, 'qzone-session.json');
      await execFileAsync('node', [sessionScript, 'stop', '--state', sessionState], {
        encoding: 'utf8', timeout: 30000, env: { ...process.env, ...nodeEnv },
      }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// 8. 收尾：关掉所有常驻浏览器
// ---------------------------------------------------------------------------
for (const statePath of sessionStateFiles) {
  await stopTrackedSession(statePath, 20000);
}

// 清理临时目录。Chrome 可能刚被 kill、还在收尾写 profile，
// 目录删不掉是正常的——不能让清理失败把整轮测试带崩。
try {
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch {
  // 忽略
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exitCode = failed === 0 ? 0 : 1;
