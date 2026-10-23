'use strict';

/**
 * QQ 空间「已删除说说」回溯探针
 *
 * 背景：本机没有 QQ 客户端缓存、也没有 QQ-Zone-Restore-Archive 归档库，
 * 所以已删除说说的唯一线索是**互动中心的历史消息卡片**——
 * 被别人点赞评论过的说说，会在历史消息里留下一张卡片，
 * 卡片里带 `//user.qzone.qq.com/<uin>/mood/<cell_id>` 链接，
 * 而这个 cell_id 不在当前说说列表里 —— 那就是「已删除但仍有互动」的痕迹。
 *
 * 接口（来自 QQ-Zone-Restore-Archive 的逆向实现）：
 *   https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds2_html_pav_all
 *   ?uin=<QQ号>&begin_time=0&end_time=0&getappnotification=1&getnotifi=1
 *   &has_get_key=0&offset=<n>&set=0&count=30&useutf8=1&outputhtmlfeed=1&scope=1
 *   &format=jsonp&g_tk=<hash33(p_skey)>
 *
 * 硬要求（踩过的坑）：
 *   1. 必须用**系统 Chrome**（Playwright 自带的 chromium 本机往往没装），
 *      launchPersistentContext 要显式传 executablePath。
 *   2. 默认路径下必须等抓取脚本完全退出后再跑：同一个 user-data-dir 不能被两个 Chrome 同时打开。
 *   3. QQ 空间的 uin / p_skey 是**会话 cookie**，浏览器一关就没了，
 *      持久化 profile 里留不住 —— 默认路径下必须在本窗口里再登一次（用户扫码）。
 *      **用 --cdp 挂到常驻浏览器上就没有这个问题**：登录态是现成的，一次都不用再扫。
 *   4. 这个接口要**桌面端**会话：页面要先停在 user.qzone.qq.com，
 *      在页面里 fetch（同源）才不会被 CORS 掐掉。count 必须 ≤ 30，再大就返回空。
 *
 * 用法：
 *   node qzone_feed_recover.js --target-qq <QQ号> --shuoshuo <messages.json> --out <qzone_archive.json>
 *                                [--tool-dir <导出工具目录>] [--profile-dir <chrome-profile 目录>]
 *                                [--cdp <常驻浏览器的 CDP 端点>] [--work-dir <工作目录>]
 *                                [--login-timeout 900] [--max-pages 20]
 *
 * 依赖：playwright（用导出工具自己的 node_modules）+ 系统 Chrome。
 *   NODE_PATH=<导出工具目录>/node_modules node qzone_feed_recover.js ...
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TOOL_DIR_DEFAULT = '/tmp/qq-space-export-work/get-qzone-history';
const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_WIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const HISTORY_URL =
  'https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds2_html_pav_all';
const PAGE_SIZE = 30; // 接口在 count=100 时会返回空，30 是验证过能稳定返回的上限

function parseArgs(argv) {
  const args = {
    targetQq: '',
    shuoshuo: '',
    out: '',
    workDir: '/tmp/qq-space-export-work',
    loginTimeout: 900,
    maxPages: 40,
    // 导出工具目录 / 持久化 chrome-profile 目录。
    // 默认是 get-qzone-history 的标准布局，换工具时用命令行覆盖。
    toolDir: TOOL_DIR_DEFAULT,
    profileDir: '',
    // 常驻浏览器的 CDP 端点。给了就挂上去复用登录态，不需要再扫码。
    cdp: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === '--target-qq' && argv[i + 1]) args.targetQq = String(argv[++i]).trim();
    else if (v === '--shuoshuo' && argv[i + 1]) args.shuoshuo = argv[++i];
    else if (v === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (v === '--work-dir' && argv[i + 1]) args.workDir = argv[++i];
    else if (v === '--tool-dir' && argv[i + 1]) args.toolDir = argv[++i];
    else if (v === '--profile-dir' && argv[i + 1]) args.profileDir = argv[++i];
    else if (v === '--cdp' && argv[i + 1]) args.cdp = String(argv[++i]).trim();
    else if (v === '--login-timeout' && argv[i + 1]) args.loginTimeout = Number(argv[++i]);
    else if (v === '--max-pages' && argv[i + 1]) args.maxPages = Number(argv[++i]);
  }
  if (!args.profileDir) {
    args.profileDir = path.join(args.toolDir, 'resource', 'temp', 'chrome-profile');
  }
  return args;
}

function chromePath() {
  if (fs.existsSync(CHROME_MAC)) return CHROME_MAC;
  if (fs.existsSync(CHROME_WIN)) return CHROME_WIN;
  return undefined;
}

function hash33(value) {
  let result = 5381;
  for (const char of value) {
    result += (result << 5) + char.charCodeAt(0);
  }
  return result & 0x7fffffff;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

async function waitForLogin(context, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let announced = false;
  let lastHint = 0;
  while (Date.now() < deadline) {
    const cookies = await context.cookies([
      'https://user.qzone.qq.com',
      'https://mobile.qzone.qq.com',
      'https://h5.qzone.qq.com',
    ]);
    const uin = cookies.find((c) => c.name === 'uin' && String(c.value || '').length > 3);
    // 必须拿到**有效的 p_skey**。
    // 持久化 profile 里常留着 uin / skey 的残骸，光有它们不等于登录可用：
    // 历史消息接口靠 p_skey 算 g_tk，缺了它接口一律回 code:-3000 need login。
    // 之前版本把残留 uin 当成「登录态就绪」，直接跳过了扫码等待，
    // 结果空跑十分钟才发现根本没登上。
    const pSkey = cookies.find((c) => c.name === 'p_skey' && String(c.value || '').length > 10);
    if (uin && pSkey) {
      return {
        uin: String(uin.value || '').replace(/^o/, ''),
        pSkey: pSkey.value || '',
      };
    }
    if (!announced) {
      console.log('等待扫码登录（uin/p_skey 是会话 cookie，浏览器一关就没了，必须在这个窗口里再登一次）…');
      announced = true;
    }
    // 每 30 秒提醒一次：要扫码 **并且**在手机 QQ 上点「确认登录」，
    // 只扫码不确认的话，p_skey 不会下发，接口还是 need login。
    if (Date.now() - lastHint > 30000) {
      lastHint = Date.now();
      const haveUin = cookies.some((c) => c.name === 'uin' && String(c.value || '').length > 3);
      console.log('  还差 p_skey（%s）。请在弹出的浏览器窗口里扫码，'
        + '并在**手机 QQ 上点「确认登录」**——只扫码不确认，p_skey 不会下发。',
        haveUin ? '已有 uin' : '连 uin 都还没有');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('登录态未就绪（未取到有效的 uin / p_skey cookie）');
}

/**
 * 等**桌面端**登录完成。
 *
 * 历史消息接口挂在 user.qzone.qq.com 上，要的是桌面端的会话：
 * 桌面空间首页里有一份内联脚本写着 `window.g_qzonetoken=...`，它才是桌面会话的凭据。
 * 只在移动端扫码拿到 uin/p_skey 是不够的——桌面首页会把你踢回登录页。
 * 所以这里直接等桌面首页出现 g_qzonetoken，扫码就在这个窗口里完成。
 */
async function waitForDesktopLogin(page, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let announced = false;
  while (Date.now() < deadline) {
    const info = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const compact = html.replace(/\s+/g, '');
      const match = /window\.g_qzonetoken=\(function\(\)\{.*?return["']([A-Za-z0-9_-]+)["'];/.exec(compact);
      return {
        url: location.href,
        title: document.title,
        token: match ? match[1] : '',
        hasToken: Boolean(match),
        loginWall: /请先登录|扫码登录|ptlogin2/.test(html.slice(0, 30000)),
      };
    }).catch(() => null);
    if (info && info.hasToken) {
      return info;
    }
    if (!announced) {
      console.log('请在这个 Chrome 窗口里用手机 QQ 扫码登录 QQ 空间（桌面版）…');
      console.log('  当前页面：%s', info ? info.url : '(读取失败)');
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('桌面端登录未完成（页面上没出现 g_qzonetoken）');
}

/** 页面内同源 fetch：必须让页面停在 user.qzone.qq.com，否则跨域被浏览器掐掉。 */
async function fetchInPage(page, url) {
  return page.evaluate(async (target) => {
    try {
      const response = await fetch(target, {
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*' },
      });
      return { ok: response.ok, status: response.status, text: await response.text() };
    } catch (error) {
      return { ok: false, status: 0, text: String(error) };
    }
  }, url);
}

/**
 * 桌面端 cookie 头。
 * 照 QQ-Zone-Restore-Archive 的做法：uin / skey / p_uin / pt4_token / p_skey 拼一串，
 * 缺哪个就少哪个，不编。
 */
function desktopCookieHeader(cookies) {
  // 同名 cookie 可能有多个（不同 domain），后写进 Map 的会把有值的那个覆盖成空值。
  // 所以只保留第一个**非空**的值。
  const map = new Map();
  for (const c of cookies) {
    if (!map.has(c.name) || (!map.get(c.name) && c.value)) map.set(c.name, c.value || '');
  }
  const pUin = map.get('p_uin') || map.get('uin') || '';
  const parts = [
    ['uin', pUin],
    ['skey', map.get('skey') || ''],
    ['p_uin', pUin],
    ['pt4_token', map.get('pt4_token') || ''],
    ['p_skey', map.get('p_skey') || ''],
  ];
  return parts
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/** QQ 的「没登录」响应：code=-3000 / message=need login。 */
function looksLikeNeedLogin(text) {
  const head = String(text || '').slice(0, 400);
  return /need login|\"code\":\s*-3000|请先登录|ptlogin2/.test(head);
}

/** 直接用请求上下文发：它自动带上浏览器上下文里该域的 cookie。 */
async function fetchInherited(context, url) {
  try {
    const response = await context.request.get(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        referer: 'https://user.qzone.qq.com/',
        'user-agent': DESKTOP_UA,
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
      },
      timeout: 30000,
    });
    return { ok: response.ok(), status: response.status(), text: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, text: String(error) };
  }
}

const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/128.0.0.0 Safari/537.36';

/** 桌面端请求：显式带上 cookie 头、桌面 Referer 和桌面 UA。 */
async function fetchDesktop(context, url, cookieHeader, ownerUin) {
  try {
    const response = await context.request.get(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.6',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        referer: `https://user.qzone.qq.com/${ownerUin}/main`,
        'user-agent': DESKTOP_UA,
        cookie: cookieHeader,
        'sec-ch-ua': '"Not A(Brand";v="99", "Chromium";v="128"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'upgrade-insecure-requests': '1',
      },
      timeout: 30000,
    });
    return { ok: response.ok(), status: response.status(), text: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, text: String(error) };
  }
}

/** JSONP 里的 html 字段带 \x3C 这样的转义，解出来才是真 HTML。 */
function decodeJsonpHtml(text) {
  // 必须用**贪婪**匹配：卡片很多，html 字段一直到最后一个 ',opuin 才结束。
  // 用非贪婪只会截到第一张卡片。
  const match = /html\s*:\s*'([\s\S]*)',\s*opuin/.exec(text);
  if (!match) return '';
  return match[1]
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\'/g, "'")
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

function plainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从说说 ID 里读出**作者**的 QQ 号（前 8 位十六进制 = 小端 u32）。
 *
 * 互动卡片里混着「我评论过的别人的动态」——这类内容本来就不在「我的说说列表」里，
 * 所以「历史消息有、说说列表没有」这个差集并不能直接当成「我已删除的说说」。
 * 靠这个函数把两者分开：作者是我，才算真的回溯到了我自己的东西。
 */
function cellOwnerUin(cellId) {
  const id = String(cellId || '');
  if (id.length < 16 || !/^[0-9a-fA-F]{16}/.test(id)) return 0;
  return Buffer.from(id.slice(0, 16), 'hex').readUInt32LE(0);
}

/**
 * 抽卡片正文。
 *
 * 已删除的说说，互动卡片里往往只剩时间戳和 cell_id，正文预览挂在哪个标签
 * 上并不固定，所以多试几个来源。抽不到正文**不代表这条记录没用**：
 * 只要有 cell_id，发布时间就能反解出来，这条说说依然进得了知识库。
 */
function extractCardContent(body) {
  const patterns = [
    /<span class="txt-box-title"[^>]*>([\s\S]*?)<\/span>/i,
    /<div class="txt-box-title"[^>]*>([\s\S]*?)<\/div>/i,
    /<p class="f-txt"[^>]*>([\s\S]*?)<\/p>/i,
    /<p class="txt-box"[^>]*>([\s\S]*?)<\/p>/i,
    /<div class="text"[^>]*>([\s\S]*?)<\/div>/i,
    /data-text="([^"]*)"/i,
    /title="([^"]{4,})"/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (!match) continue;
    const text = plainText(match[1]);
    if (text) return text;
  }
  return '';
}

/**
 * 解析历史消息卡片。
 * 卡片形如：
 *   <li class="f-single f-s-s" data-key="fct_<uin>_<family>_<subtype>_<time>_...">
 *     ...<a href="//user.qzone.qq.com/<owner>/mood/<cell_id>">查看说说</a>
 *     ...<div class="info-detail" data-time="1574686344">...</div>
 *     ...<p class="txt-box-title">正文</p>
 *   </li>
 * family：217=赞，311=评论，334=留言板。
 */
function parseHistoryCards(html, ownerUin) {
  const cards = [];
  const cardPattern = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  let match = cardPattern.exec(html);
  while (match) {
    const attrs = match[1];
    const body = match[2];
    match = cardPattern.exec(html);
    if (!/\bf-single\b/.test(attrs) || !/\bf-s-s\b/.test(attrs)) continue;

    const keyMatch = /data-key="([^"]+)"/.exec(attrs) || /\bid="([^"]+)"/.exec(attrs);
    const key = keyMatch ? keyMatch[1] : '';
    const keyParts = /^fct_(\d+)_(\d+)_(\d+)_(\d+)/.exec(key);

    const cellMatch = new RegExp(`/mood/([0-9a-zA-Z]+)`).exec(body);
    const cellId = cellMatch ? cellMatch[1] : '';
    const timeMatch = /data-time="(\d+)"/.exec(body);
    const contentMatch = /<p class="txt-box-title"[^>]*>([\s\S]*?)<\/p>/.exec(body);
    const content = contentMatch ? plainText(contentMatch[1]) : extractCardContent(body);

    cards.push({
      key,
      actor_uin: keyParts ? keyParts[1] : '',
      family: keyParts ? Number(keyParts[2]) : 0,
      subtype: keyParts ? Number(keyParts[3]) : 0,
      event_time: timeMatch ? Number(timeMatch[1]) : keyParts ? Number(keyParts[4]) : 0,
      cell_id: cellId,
      content,
      cell_owner: cellOwnerUin(cellId),
      is_owner: cellMatch ? body.indexOf(`/mood/${cellId}`) >= 0 : false,
      owner_uin: ownerUin,
    });
  }
  return cards;
}

/**
 * 组装归档结果。
 *
 * ⚠️ dynamics 里**不能**按「有没有正文」过滤。
 * 已删除的说说在互动卡片里常常抽不到正文预览，但只要有 cell_id，
 * 发布时间就能反解出来——「发过、什么时候发、被谁互动过」本身就是真实知识。
 * 把没正文的条目直接丢掉，recovered 会永远是 0，看起来像功能没做。
 */
function buildArchive(report, extra) {
  return {
    dynamics: extra
      .filter((item) => item.cell_id)
      .map((item) => ({
        cell_id: item.cell_id,
        published_at: item.event_time,
        // 卡片上的时间是「互动时间」，不是发布时间。
        // 真正的发布时间由 cell_id 反解（kb.mjs 里的 mood_cell_id_published_at），
        // 反解不了时至少要如实标成「互动时间近似」，不能当成精确时间。
        published_from: 'interaction',
        content: item.content || '',
        author_uin: item.cell_owner || item.owner_uin,
        author_name: '',
        category: String(item.family),
        pictures_json: '[]',
        video_json: '[]',
        is_history_residue: true,
        source: 'history_message',
      })),
    feeds: report.cards.map((card) => ({
      feed_key: card.key,
      cell_id: card.cell_id,
      event_type: String(card.family),
      event_time: card.event_time,
      actor_uin: card.actor_uin,
      actor_name: '',
      comments_json: '[]',
      event_summary: card.content || '',
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const PROFILE_DIR = args.profileDir;
  if (!args.targetQq) {
    console.error('缺少 --target-qq');
    return 2;
  }
  // CDP 模式下浏览器是外部起的（常驻会话），本地 profile 由那边管，这里不检查。
  if (!args.cdp && !fs.existsSync(PROFILE_DIR)) {
    console.error('找不到 chrome-profile：%s', PROFILE_DIR);
    return 3;
  }

  // 说说列表 tid 集合（用于求差集）
  const shuoshuoTids = new Set();
  if (args.shuoshuo && fs.existsSync(args.shuoshuo)) {
    const raw = JSON.parse(fs.readFileSync(args.shuoshuo, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.messages || raw.posts || raw.data || [];
    for (const item of list) {
      if (item && item.tid) shuoshuoTids.add(String(item.tid));
    }
  }
  console.log('说说列表 tid 数量：%d', shuoshuoTids.size);

  // 浏览器有两种拿法：
  //  - --cdp：挂到**常驻会话**的浏览器上，复用它已经登录好的会话（全程只扫一次码）。
  //    实测 Playwright 在 CDP 连接下调用 browser.close() 只断开客户端，Chrome 进程不受影响。
  //  - 默认：自己开一个持久化 profile（老路径，需要在这个窗口里再登一次）。
  let browser = null;
  let context = null;
  if (args.cdp) {
    console.log('挂到常驻浏览器：%s（复用已有登录态，不需要再扫码）', args.cdp);
    try {
      browser = await chromium.connectOverCDP(args.cdp);
    } catch (error) {
      // 常驻浏览器被关掉了，或端口没开。
      // 这里必须说清楚：**不能默默退回自己开浏览器**——那会变成「又要重新扫码」，
      // 正是这次改造要消灭的行为。
      console.error(
        '连不上常驻浏览器（CDP 端点 %s）：%s\n' +
        '常驻浏览器多半已经被关掉了，登录态随之失效。\n' +
        '要继续的话：点一次「开始导出」重新拉起浏览器，扫码一次即可（全程仍然只需一次）。',
        args.cdp,
        String(error && error.message ? error.message : error),
      );
      return 4;
    }
    context = browser.contexts()[0];
    if (!context) {
      console.error('CDP 连上了但没找到浏览器上下文：%s', args.cdp);
      return 5;
    }
  } else {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      executablePath: chromePath(),
      viewport: { width: 1440, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check'],
    });
  }
  const page = context.pages()[0] || (await context.newPage());

  const report = { probes: [], cards: [], errors: [], extra: [] };

  try {
    // 桌面端空间首页：这里扫码就同时拿到桌面会话
    await page.goto('https://user.qzone.qq.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const login = await waitForLogin(context, args.loginTimeout);
    console.log('登录态就绪，QQ=%s', login.uin);

    // ⚠️ cookie 必须在登录后**立刻**取。
    // 之后一旦导航到 user.qzone.qq.com/<uin>/main（它会跳 i.qq.com 登录中转页），
    // 服务端会把这几个 QZone cookie 重新下发成空值，cookie 名还在但值没了。

    // 建立桌面端会话。
    //
    // 两个坑：
    // 1) 扫码后 user.qzone.qq.com 会被甩到 i.qq.com 登录中转页，桌面会话还没建好。
    //    手机上确认登录后页面会自己跳回来，所以这里持续等，而不是重试导航。
    // 2) **页面一旦停在 i.qq.com 上，服务端会把 QZone 会话 cookie 重新下发成空值**
    //    （cookie 名还在，值没了）。所以要全程保留「值最全」的那次快照，
    //    并且只有在真正跳回 user.qzone.qq.com 之后才去请求历史消息接口。
    let bestHeader = '';
    const bestCookies = [];
    const snapshot = async () => {
      const now = await context.cookies();
      const header = desktopCookieHeader(now);
      if (header.split('; ').length > bestHeader.split('; ').length) {
        bestHeader = header;
        bestCookies.length = 0;
        bestCookies.push(...now);
      }
      return header;
    };
    await snapshot();

    const deadline = Date.now() + 10 * 60 * 1000;
    let onDesktop = false;
    while (Date.now() < deadline) {
      await page.goto(`https://user.qzone.qq.com/${login.uin}/main`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      }).catch(() => {});
      await page.waitForTimeout(4000);
      const header = await snapshot();
      onDesktop = page.url().startsWith('https://user.qzone.qq.com');
      console.log('空间页：%s | cookie 字段：%s', page.url(),
        header ? header.split('; ').map((p) => p.split('=')[0]).join(', ') : '(空)');
      if (onDesktop && bestHeader.split('; ').length >= 5) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!onDesktop) {
      console.log('⚠️ 页面没能停在 user.qzone.qq.com 上（可能手机上还没确认登录），继续用现有 cookie 试');
    }
    // i.qq.com 会把空间页装进 iframe，所以所有 frame 都扫一遍
    let pageInfo = { url: page.url(), title: '', token: '', frames: [] };
    for (const frame of page.frames()) {
      const info = await frame.evaluate(() => {
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        const compact = html.replace(/\s+/g, '');
        const match = /window\.g_qzonetoken=\(function\(\)\{.*?return["']([A-Za-z0-9_-]+)["'];/.exec(compact);
        return { url: location.href, title: document.title, token: match ? match[1] : '', len: html.length };
      }).catch(() => null);
      if (!info) continue;
      pageInfo.frames.push(info);
      if (!pageInfo.token && info.token) pageInfo.token = info.token;
      if (!pageInfo.title && info.title) pageInfo.title = info.title;
    }
    console.log('当前页面：%s | 标题：%s | g_qzonetoken：%s | frame 数：%d',
      pageInfo.url, pageInfo.title, pageInfo.token ? '已取到' : '没取到', pageInfo.frames.length);
    report.pageInfo = pageInfo;

    const cookieHeader = bestHeader;
    console.log('最终桌面 cookie 头字段：%s',
      cookieHeader ? cookieHeader.split('; ').map((p) => p.split('=')[0]).join(', ') : '(空)');
    console.log('关键 cookie 的值长度：%s',
      bestCookies
        .filter((c) => ['uin', 'skey', 'p_skey', 'p_uin', 'pt4_token'].includes(c.name))
        .map((c) => `${c.name}(${c.domain})=${(c.value || '').length}`)
        .join(' '));
    report.cookieNames = [...new Set(bestCookies.map((c) => `${c.domain}:${c.name}`))];

    const gTk = String(hash33(login.pSkey));

    // QQ 号可能带前导 0（cookie 里常见 'o0123456789' 这种形式），比数字时统一去掉
    const ownerNum = Number(login.uin);

    // 落盘抽成函数，每翻一页就落一次：
    // 中途被 WAF 拦掉时，已经拿到的卡片不会跟着一起丢。
    const dumpPath = path.join(args.workDir, 'feed-raw-dump.json');
    const flush = (label) => {
      // 求差集：卡片里有、说说列表里没有的 cell_id
      const seen = new Set();
      const extra = [];
      for (const card of report.cards) {
        if (!card.cell_id) continue;
        if (shuoshuoTids.has(card.cell_id)) continue;
        // 只收「内容是我发的」。别人的动态本来就不在「我的说说列表」里，
        // 差集里混着它们；收进来等于让 bot 声称自己发过没发过的内容。
        if (card.cell_owner && card.cell_owner !== ownerNum) continue;
        if (seen.has(card.cell_id)) continue;
        seen.add(card.cell_id);
        extra.push(card);
      }
      report.extra = extra;
      writeJson(dumpPath, report);
      if (args.out) {
        const archive = buildArchive(report, extra);
        writeJson(args.out, archive);
        console.log('已落盘（%s）：归档结果 %s（dynamics=%d, feeds=%d）',
          label, args.out, archive.dynamics.length, archive.feeds.length);
      }
      console.log('已落盘（%s）：差集 %d 条', label, extra.length);
      return extra;
    };

    // 翻历史消息
    let totalCards = 0;
    for (let pageIndex = 0; pageIndex < args.maxPages; pageIndex += 1) {
      const offset = pageIndex * PAGE_SIZE;
      const params = new URLSearchParams({
        uin: login.uin,
        begin_time: '0',
        end_time: '0',
        getappnotification: '1',
        getnotifi: '1',
        has_get_key: '0',
        offset: String(offset),
        set: '0',
        count: String(PAGE_SIZE),
        useutf8: '1',
        outputhtmlfeed: '1',
        scope: '1',
        format: 'jsonp',
        g_tk: gTk,
      });
      const url = `${HISTORY_URL}?${params.toString()}`;

      // 三条通道依次尝试：
      //   1) context.request 不带 cookie 头 —— 它自动继承浏览器上下文里该域的 cookie
      //   2) 显式带桌面 cookie 头（照归档工具的拼法）
      //   3) 页面内同源 fetch
      // 两种限流都要退避重试：
      //   - network busy / code -10001：接口自己的限流
      //   - HTTP 501 + waf.tencent.com：腾讯 WAF 拦了，等更久
      let busyRetries = 0;
      while (busyRetries < 5) {
        const probe = await fetchDesktop(context, url, cookieHeader, login.uin);
        const head = String(probe.text || '').slice(0, 300);
        const waf = probe.status === 501 || /waf\.tencent\.com/.test(head);
        const busy = /network busy|-10001/.test(head);
        if (!waf && !busy) break;
        busyRetries += 1;
        const waitMs = waf ? 30000 : 5000;
        console.log('  被限流了（%s），等 %d 秒后重试 %d/5', waf ? 'WAF 501' : 'network busy', waitMs / 1000, busyRetries);
        await new Promise((r) => setTimeout(r, waitMs));
      }

      // 通道**按需**试：desktop-cookie 拿到内容就直接用，别把三条通道都打一遍。
      // 每页多打两个请求，很容易把接口打到腾讯 WAF 限流（HTTP 501）。
      const channels = [
        ['desktop-cookie', () => fetchDesktop(context, url, cookieHeader, login.uin)],
        ['inherited-cookie', () => fetchInherited(context, url)],
        ['in-page', () => fetchInPage(page, url)],
      ];
      let res = null;
      let via = 'none';
      for (const [name, run] of channels) {
        const attempt = await run();
        console.log('  通道 %s -> status=%s 头部=%s', name, attempt.status,
          String(attempt.text || '').slice(0, 120).replace(/\s+/g, ' '));
        // 只认「真的拿到内容」或「服务端明确说没登录」的响应，传输层错误直接跳过
        if (attempt.status === 0) continue;
        if (!res) { res = attempt; via = name; }
        if (!looksLikeNeedLogin(attempt.text)) { res = attempt; via = name; break; }
      }
      if (!res) { res = { status: 0, text: '', ok: false }; via = 'none'; }
      const html = decodeJsonpHtml(res.text);
      const cards = html ? parseHistoryCards(html, login.uin) : [];
      report.probes.push({
        offset,
        via,
        ok: res.ok,
        status: res.status,
        htmlLength: html.length,
        cardCount: cards.length,
        rawHead: String(res.text || '').slice(0, 200),
      });
      console.log(
        '历史消息 offset=%d [%s] -> status=%s html=%d 字，卡片 %d 张',
        offset, via, res.status, html.length, cards.length,
      );
      if (!res.ok || !html) {
        report.errors.push({ endpoint: 'history_messages', offset, via, status: res.status, text: String(res.text || '').slice(0, 300) });
        break;
      }
      if (!cards.length) break;
      report.cards.push(...cards);
      totalCards += cards.length;
      // 增量落盘：这一页拿到的东西先存住，后面被限流也不丢
      flush(`第 ${pageIndex + 1} 页`);
      // 翻页放慢，别把接口打到限流
      await new Promise((r) => setTimeout(r, 5000));
    }

    console.log('历史消息卡片总数：%d', totalCards);

    const extra = flush('全部完成');
    console.log('差集条数（历史消息有、说说列表没有）：%d', extra.length);
    for (const item of extra) {
      console.log('  差集 cell_id=%s family=%s time=%s 正文=%s',
        item.cell_id, item.family, item.event_time, item.content ? item.content.slice(0, 60) : '(无)');
    }
  } catch (error) {
    report.errors.push({ stage: 'fatal', message: String(error) });
    writeJson(path.join(args.workDir, 'feed-raw-dump.json'), report);
    console.error('回溯探针出错：%s', String(error));
  } finally {
    if (browser) {
      // CDP 模式：只断开 Playwright 客户端，常驻浏览器继续活着，登录态不丢。
      await browser.close().catch(() => {});
    } else {
      await context.close().catch(() => {});
    }
  }
  return 0;
}

main().then((code) => process.exit(code));
