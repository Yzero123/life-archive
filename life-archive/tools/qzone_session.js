'use strict';

/**
 * QQ 空间常驻浏览器会话管理器
 *
 * 为什么需要它
 * ------------
 * QQ 空间的 `uin` / `p_skey` 是**会话 cookie**——只活在浏览器进程内存里，
 * 浏览器一关就没了，持久化 profile 也留不住。
 * 原来的流程是「导出工具开一个浏览器 → 抓完关掉 → 回溯探针再开一个浏览器」，
 * 于是**每一步都要重新扫码**，而且两个工具登录的还不是同一个页面，
 * 用户看到的是「同一个 QQ 空间要反复登录」。
 *
 * 这个脚本把浏览器从「工具的附属品」变成**独立的长驻进程**：
 *   1. 我们自己起 Chrome，带 `--remote-debugging-port` 和持久化 profile；
 *   2. Chrome 独立进程组运行，**导出和回溯都不再关它**；
 *   3. 导出工具和回溯探针都通过 `--connect-cdp` 挂到这个浏览器上，
 *      复用同一份登录态 —— **全程只需要扫一次码**。
 *
 * 为什么挂在同一个浏览器上就够
 * ----------------------------
 * 实测（Playwright 1.64 + Chrome 155）：用 `chromium.connectOverCDP()` 连上后
 * 调用 `browser.close()`，**只断开 Playwright 客户端，Chrome 进程和 CDP 端口都活着**。
 * 所以导出工具跑完（它内部会 `browser.close()`）不会把我们的常驻浏览器带走。
 *
 * 用法：
 *   node qzone_session.js start  --profile-dir <目录> [--port 0] [--state <session.json>]
 *   node qzone_session.js status --state <session.json>
 *   node qzone_session.js stop   --state <session.json>
 *
 * 依赖：playwright（用导出工具自己的 node_modules）+ 系统 Chrome。
 *   NODE_PATH=<导出工具目录>/node_modules node qzone_session.js ...
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_WIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TOOL_DIR_DEFAULT = '/tmp/qq-space-export-work/get-qzone-history';

// 登录入口页。桌面版空间首页：在这里扫码一次，
// 后面导出（桌面 iframe）与回溯（桌面会话 + g_qzonetoken）都能复用。
const LOGIN_URL = 'https://user.qzone.qq.com/';

function parseArgs(argv) {
  const args = {
    command: argv[0] || 'status',
    profileDir: '',
    state: '',
    port: 0,
    toolDir: TOOL_DIR_DEFAULT,
    timeoutSeconds: 900,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === '--profile-dir' && argv[i + 1]) args.profileDir = String(argv[++i]);
    else if (v === '--state' && argv[i + 1]) args.state = String(argv[++i]);
    else if (v === '--port' && argv[i + 1]) args.port = Number(argv[++i]) || 0;
    else if (v === '--tool-dir' && argv[i + 1]) args.toolDir = String(argv[++i]);
    else if (v === '--timeout' && argv[i + 1]) args.timeoutSeconds = Number(argv[++i]) || 900;
  }
  if (!args.profileDir) {
    args.profileDir = path.join(args.toolDir, 'resource', 'temp', 'chrome-profile-session');
  }
  if (!args.state) {
    args.state = path.join(path.dirname(args.profileDir), 'qzone-session.json');
  }
  return args;
}

function chromePath() {
  if (fs.existsSync(CHROME_MAC)) return CHROME_MAC;
  if (fs.existsSync(CHROME_WIN)) return CHROME_WIN;
  const found = require('child_process').execSync('command -v google-chrome || command -v chromium || true', {
    encoding: 'utf8',
  }).trim();
  return found || CHROME_MAC;
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(statePath, payload) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, statePath);
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 读 Chrome 实际占用的调试端口。
 * 端口传 0 时 Chrome 会自己挑一个空闲端口，并写进 <profile>/DevToolsActivePort。
 */
function readDevToolsPort(profileDir) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) return 0;
  const lines = fs.readFileSync(portFile, 'utf8').split('\n');
  const port = Number(String(lines[0] || '').trim());
  return Number.isFinite(port) && port > 0 ? port : 0;
}

function cdpUrl(port) {
  return `http://127.0.0.1:${port}`;
}

async function waitForCdp(port, timeoutMs, profileDir) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const actual = readDevToolsPort(profileDir) || port;
    if (actual) {
      try {
        const res = await fetch(cdpUrl(actual), { signal: AbortSignal.timeout(2000) });
        if (res.ok) return actual;
      } catch {
        // 还没起来，继续等
      }
    }
    await sleep(300);
  }
  return 0;
}

/**
 * 读浏览器里的 QQ 空间 cookie，判断登录态到了哪一步。
 *
 * - `uin` 有值 = 至少认得出是哪个号
 * - `p_skey` 有值 = 桌面会话可用（历史消息接口要拿它算 g_tk）
 * - `skey`  有值 = 弱一些的登录态
 */
async function readLoginState(port) {
  const { chromium } = require('playwright');
  let browser = null;
  try {
    browser = await chromium.connectOverCDP(cdpUrl(port));
    const context = browser.contexts()[0];
    if (!context) return { uin: '', hasPSkey: false, hasSkey: false, pages: 0 };
    const cookies = await context.cookies([
      'https://user.qzone.qq.com',
      'https://mobile.qzone.qq.com',
      'https://h5.qzone.qq.com',
      'https://qzone.qq.com',
    ]);
    const uin = cookies.find((c) => c.name === 'uin' && String(c.value || '').length > 3);
    const pSkey = cookies.find((c) => c.name === 'p_skey' && String(c.value || '').length > 10);
    const skey = cookies.find((c) => c.name === 'skey' && String(c.value || '').length > 10);
    return {
      uin: uin ? String(uin.value || '').replace(/^o/, '') : '',
      hasPSkey: Boolean(pSkey),
      hasSkey: Boolean(skey),
      pages: context.pages().length,
    };
  } catch (error) {
    return { uin: '', hasPSkey: false, hasSkey: false, pages: 0, error: String(error && error.message) };
  } finally {
    // CDP 下 close() 只断开客户端，Chrome 进程不受影响（已实测）。
    if (browser) await browser.close().catch(() => {});
  }
}

/** 启动常驻 Chrome。detached + unref 让它在本脚本退出后继续活着。 */
async function start(args) {
  const existing = readState(args.state);
  if (existing && isAlive(existing.pid) && existing.port) {
    const login = await readLoginState(existing.port);
    // reused 要放在 existing 之后展开，否则会被 existing.reused 覆盖掉。
    console.log(JSON.stringify({ ...existing, ok: true, reused: true, login }, null, 2));
    return 0;
  }

  fs.mkdirSync(args.profileDir, { recursive: true });
  // profile 里存着 QQ 空间登录态（cookie / Local Storage），只给当前用户读写。
  // 目录默认是 umask 决定的 755，同机其他账号能进来翻——这里收紧到 700。
  try {
    fs.chmodSync(args.profileDir, 0o700);
  } catch {
    // Windows 上没有 POSIX 权限位，忽略。
  }
  const bin = chromePath();
  if (!fs.existsSync(bin)) {
    console.error(JSON.stringify({ ok: false, error: '找不到系统 Chrome：%s' % bin }));
    return 2;
  }

  const chromeArgs = [
    `--remote-debugging-port=${args.port}`,
    `--user-data-dir=${args.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    LOGIN_URL,
  ];
  const child = spawn(bin, chromeArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const port = await waitForCdp(args.port, 30000, args.profileDir);
  if (!port) {
    console.error(JSON.stringify({ ok: false, error: 'Chrome 起来了但调试端口没就绪', pid: child.pid }));
    return 3;
  }

  const payload = {
    ok: true,
    reused: false,
    pid: child.pid,
    port,
    cdpUrl: cdpUrl(port),
    profileDir: args.profileDir,
    loginUrl: LOGIN_URL,
    startedAt: new Date().toISOString(),
  };
  writeState(args.state, payload);
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

async function status(args) {
  const state = readState(args.state);
  if (!state || !state.port) {
    console.log(JSON.stringify({ ok: false, alive: false, reason: 'no_session' }));
    return 0;
  }
  const alive = isAlive(state.pid);
  if (!alive) {
    console.log(JSON.stringify({ ok: false, alive: false, pid: state.pid, cdpUrl: state.cdpUrl }));
    return 0;
  }
  const login = await readLoginState(state.port);
  // loginReady 的判据跟回溯探针保持一致：必须有 uin 且有 p_skey。
  // 只有 skey 的话导出能跑，但历史消息接口算不出 g_tk，回溯会失败。
  const loginReady = Boolean(login.uin && login.hasPSkey);
  console.log(JSON.stringify({
    ok: true,
    alive: true,
    pid: state.pid,
    port: state.port,
    cdpUrl: state.cdpUrl,
    profileDir: state.profileDir,
    startedAt: state.startedAt,
    login,
    loginReady,
  }, null, 2));
  return 0;
}

async function stop(args) {
  const state = readState(args.state);
  if (!state || !state.pid) {
    console.log(JSON.stringify({ ok: true, stopped: false, reason: 'no_session' }));
    return 0;
  }
  if (isAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // 已经没了
    }
    await sleep(1200);
    if (isAlive(state.pid)) {
      try {
        process.kill(state.pid, 'SIGKILL');
      } catch {
        // 忽略
      }
    }
  }
  console.log(JSON.stringify({ ok: true, stopped: true, pid: state.pid }));
  return 0;
}

/**
 * 把会话「拉回来」，不重新扫码。
 *
 * 为什么需要：QQ 空间在某些跳转之后会把域内的 `uin`/`p_skey` 重新下发成空值
 * （cookie 名还在、值没了）。但**登录本身没丢**——i.qq.com 的 SSO 还在，
 * 重新访问一次空间首页，服务端会凭 SSO 把 QZone 的会话 cookie 补回来。
 *
 * 所以「cookie 空了」不等于「要重新扫码」。先用这一招，真的补不回来才算需要扫码。
 */
async function revisit(args) {
  const state = readState(args.state);
  if (!state || !state.port || !isAlive(state.pid)) {
    console.log(JSON.stringify({ ok: false, alive: false, reason: 'no_session' }));
    return 0;
  }
  const { chromium } = require('playwright');
  let browser = null;
  try {
    browser = await chromium.connectOverCDP(state.cdpUrl);
    const context = browser.contexts()[0];
    if (!context) {
      console.log(JSON.stringify({ ok: false, alive: true, reason: 'no_context' }));
      return 0;
    }
    const page = context.pages()[0] || (await context.newPage());
    const deadline = Date.now() + args.timeoutSeconds * 1000;
    let login = { uin: '', hasPSkey: false, hasSkey: false };
    let navigated = false;
    while (Date.now() < deadline) {
      if (!navigated) {
        navigated = true;
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
          .catch(() => {});
      }
      const cookies = await context.cookies([
        'https://user.qzone.qq.com',
        'https://mobile.qzone.qq.com',
        'https://h5.qzone.qq.com',
        'https://qzone.qq.com',
      ]);
      const uin = cookies.find((c) => c.name === 'uin' && String(c.value || '').length > 3);
      const pSkey = cookies.find((c) => c.name === 'p_skey' && String(c.value || '').length > 10);
      const skey = cookies.find((c) => c.name === 'skey' && String(c.value || '').length > 10);
      login = {
        uin: uin ? String(uin.value || '').replace(/^o/, '') : '',
        hasPSkey: Boolean(pSkey),
        hasSkey: Boolean(skey),
      };
      if (login.uin && (login.hasPSkey || login.hasSkey)) break;
      await sleep(1500);
    }
    console.log(JSON.stringify({
      ok: true,
      alive: true,
      cdpUrl: state.cdpUrl,
      login,
      loginReady: Boolean(login.uin && login.hasPSkey),
      restored: Boolean(login.uin && (login.hasPSkey || login.hasSkey)),
    }, null, 2));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, alive: true, error: String(error && error.message) }));
    return 0;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'start') return start(args);
  if (args.command === 'stop') return stop(args);
  if (args.command === 'revisit') return revisit(args);
  return status(args);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error && error.message) }));
    process.exitCode = 1;
  });
