// QQ 空间说说知识库 · Node 服务
//
// 职责：
//   1. 对外提供窄业务路由（页面只管展示）
//   2. 驱动 Agent 完成 QQ 登录与全量导出
//   3. 合并两路数据源、切知识块、建检索索引
//   4. 对话：先检索，检索不到直接回固定话术；检索到才让 Agent 基于资料作答，并做接地校验

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

import {
  PHASE,
  Store,
} from './store.mjs';

import {
  buildChunks,
  buildIndex,
  buildProfile,
  buildYearSummaries,
  FALLBACK_ANSWER,
  factualTokensGrounded,
  groundingRatio,
  isConfident,
  isSelfCharacterQuestion,
  mergeRecords,
  moodCellIdPublishedAt,
  parseQzoneArchive,
  parseQzoneExport,
  sanitizeNarrative,
  search,
  TIME_SOURCE,
} from './kb.mjs';

const CHAT_TOP_K = 6;
const CHAT_CONTEXT_LIMIT = 12;
// 措辞重合度的下限。中文口语回答里虚词二元组（「那帮人」「倒是没少」）天然不重合，
// 阈值定太高会把**有据可依**的回答误杀成固定话术——那看起来像「知识库里没有」，
// 其实是有。实测：纯真转述 0.73，有据口语转述 0.33，边界样本 0.28，
// 纯编造 0.04，掺假经历 0.17。
// 真正的硬红线是 factsOk（数字 / 日期 / 外文专名 / 引介人名不许编），
// 措辞阈值只兜住「整段都在编」的情况，所以放在 0.27。
const GROUNDING_RATIO_MIN = 0.27;

const EXPORT_INSTRUCTION = `请帮用户完成一次 QQ 空间历史说说的全量导出，并把结果写到指定路径。

## 目标产物（必须真实产出，不能用样例数据代替）
1. \`<RAW_DIR>/qzoneexport_messages.json\` —— QZoneExport 的 messages.json，数组格式，每条至少含 tid / content / created_time 三个字段。
2. \`<RAW_DIR>/qzone_archive.json\` —— 已删除说说的回溯结果，格式为 {"dynamics": [...], "feeds": [...]}。
   **即使一条都没捞到也要写这个文件**（空数组），这样界面能区分「没捞到」和「根本没试」。

## 铁律（这几条是踩过坑换来的，务必遵守）
1. **只启动一次抓取，不要写任何自动重跑循环。** 不要写 supervisor、守护进程、while 循环去反复重启抓取脚本。
   反复重开浏览器会把用户逼疯，而且每次都要重新扫码登录。
2. **抓取脚本必须完全挂到后台**（独立进程组 / setsid），绝不能挂在一次前台工具调用里。
   前台调用一旦到达时限就会把进程连同浏览器一起杀掉，用户看到的就是「页面还没加载完就自动关闭」。
3. **浏览器被关闭 = 用户主动中止，立刻停下来报告，不要自动重开浏览器。**
   断点会保留在 result 目录里，用户自己会再点一次「开始导出」续跑。
4. 不要删除 \`resource/temp/chrome-profile\`（那是登录态），不要换浏览器 profile。

## 步骤

0. 用下面的运行器启动导出。它负责 clone 工具、装依赖、把抓取脚本挂到后台，并写状态文件：
   \`\`\`
   python3 "<RUNNER_PATH>" --status "<STATUS_PATH>" --work-dir /tmp/qq-space-export-work --owner <QQ号>
   \`\`\`
   它会立刻返回，并打印 PID 与状态文件路径。

1. 告诉用户：「导出已经在后台开始，浏览器窗口会弹出，请用手机 QQ 扫码登录 QQ 空间。」
   然后**不要**盯着长命令，用短命令轮询状态文件：
   \`\`\`
   cat "<STATUS_PATH>"
   tail -20 /tmp/qq-space-export-work/export-run.log
   \`\`\`
   状态还是 running 就隔一会儿再报一次进度（已抓页数、累计条数），**绝不要重新启动**。

2. 落盘：抓取结束后，把 \`get-qzone-history/resource/result/\` 里的 messages JSON 转成
   \`<RAW_DIR>/qzoneexport_messages.json\`（数组格式）。**这一步不能直接复制**——工具的原始输出
   和下面的字段对不上，直接复制会丢掉图片、点赞数也会被转发数顶替。

   目标字段（Mini App 的解析器只认这些）：

   | 目标字段 | 取自 | 说明 |
   |---|---|---|
   | \`tid\` | \`tid\` | 说说 ID，原样 |
   | \`content\` | \`content\` | 正文 |
   | \`custom_content\` | 同 \`content\` | 解析器优先读这个 |
   | \`created_time\` | **从 DOM 里取** | **必须是 unix 秒级时间戳**。工具输出的 \`created_time\` 是「2021年5月6日 赞评论转发更多 编辑 收藏 详情 删除」这种显示字符串，直接用会让整条时间轴失效 |
   | \`custom_create_time\` | \`2021-05-06 15:13\` 形式 | 备用时间，写标准 \`YYYY-MM-DD HH:mm\` |
   | \`likeTotal\` | DOM 里的**赞**数 | ⚠️ 工具的 \`like_count\` 抓到的是**转发**数（「评论(20)转发(490)」里 490 是转发），必须从 DOM 重新取赞数 |
   | \`commentlist\` | DOM 里的评论条目 | 每条含 \`content\` / \`nick\` / \`createTime\` / \`replys\` |
   | \`cmtnum\` / \`fwdnum\` | DOM 里的评论数 / 转发数 | |
   | \`lbs\` | \`{"name":..,"address":..,"idname":..}\` | 定位，从 DOM 的定位文案取 |
   | \`pic\` | 图片数组 | 每项放 \`{"hd_url":..,"b_url":..}\`，用 \`image_urls\` 里已下载的本地文件路径 |
   | \`video\` | 视频数组 | 每项放 \`{"play_url":..}\` |
   | \`post_url\` | \`https://user.qzone.qq.com/<QQ号>/mood/<tid>\` | |
   | \`uin\` | 你的 QQ 号 | |
   | \`source_name\` | 你的昵称 | |

   时间和赞数如果从工具的 JSON 拿不准，就从页面 DOM 里取（之前就是这么做的，能拿到 45 条精确到秒的时间和 6408 个赞）。

3. **回溯已删除说说**（这一步最容易被跳过，跳过了用户会以为功能坏了）：
   a. 先找本机归档库（QQ-Zone-Restore-Archive 的 SQLite），依次检查：
      - macOS: \`~/Library/Application Support/top.ehre.qzonearchive/qzone-archive.sqlite3\`
      - Windows: \`%APPDATA%\\top.ehre.qzonearchive\\qzone-archive.sqlite3\`
      - 都没找到就搜一遍：\`find ~ -maxdepth 6 -iname "qzone-archive*.sqlite3" 2>/dev/null\`
      找到了就按第 4 步的方式转成 JSON。**找不到就跳过，绝不编造**。
   b. 本机没有归档库，就走**互动中心的历史消息**这条路：已删除但仍被人点赞评论的说说，
      会在**历史消息卡片**里留下痕迹——卡片带 \`//user.qzone.qq.com/<QQ号>/mood/<cell_id>\` 链接，
      而这个 cell_id 不在当前说说列表里。

      接口（QQ-Zone-Restore-Archive 逆向出来的，公开可查）：
      \`\`\`
      https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds2_html_pav_all
      ?uin=<QQ号>&begin_time=0&end_time=0&getappnotification=1&getnotifi=1
      &has_get_key=0&offset=<n>&set=0&count=30&useutf8=1&outputhtmlfeed=1&scope=1
      &format=jsonp&g_tk=<hash33(p_skey)>
      \`\`\`
      - 返回 JSONP，html 字段是转义过的卡片 HTML（\`\\x3C\` → \`<\`），解出来再解析。
      - 卡片形如 \`<li class="f-single f-s-s" data-key="fct_<uin>_<family>_<subtype>_<time>">\`，
        正文通常在 \`<p class="txt-box-title">\`，时间在 \`data-time\`。
        正文不一定挂在这个标签上（也可能被 span/div 包裹，或在 data-text / title 属性里），
        多试几个来源再放弃。
        family：217=赞，311=评论，334=留言板。
      - \`count\` 必须 ≤ 30（100 会返回空），\`offset\` 按 30 递增翻页。
      - 把差集里的 cell_id 挑出来，按同样格式写进 qzone_archive.json：
        dynamics 每条含 cell_id / published_at / content / author_uin / is_history_residue:true。
      - ⚠️ **只收「内容是本人发的」那些**。互动卡片里混着「我评论过的别人的动态」，
        这类内容本来就不在「我的说说列表」里，所以差集里必然混着它们。
        说说 ID 的**前 8 位十六进制（小端 u32）就是作者 QQ 号**，用它过滤：
        作者不是本人就丢掉。收进来的话，bot 会声称自己发过根本没发过的内容——
        这比漏回溯一条严重得多。
      - ⚠️ **差集里没抽到正文的条目也要写进去**（\`content\` 留空字符串，**不要丢**）。
        已删除的说说在互动卡片里常常只剩时间戳和 cell_id，正文预览未必还在；
        但只要有 cell_id，发布时间就能由 ID 反解出来，
        「发过、什么时候发、被谁互动过」本身就是真实知识。
        把没正文的条目过滤掉，回溯条数会永远是 0，看起来像功能没做。
      - 卡片上的 \`data-time\` 是**互动时间**，不是发布时间。落盘时标上
        \`published_from: "interaction"\`；真正的发布时间由 cell_id 反解，
        反解不了时至少要如实标成「互动时间近似」，不能冒充精确时间。
      - 差集为空就写空的 \`{"dynamics": [], "feeds": []}\`，如实说明。

      写探针时的硬要求：
      - ⚠️ **优先用包内现成的探针**：\`<插件目录>/tools/qzone_feed_recover.js\`
        （已实测跑通，把下面这些坑都处理了）。用法：
        \`NODE_PATH=<导出工具目录>/node_modules node <插件目录>/tools/qzone_feed_recover.js
        --target-qq <QQ号> --shuoshuo <导出产物 messages.json> --out <RAW_DIR>/qzone_archive.json
        --work-dir /tmp/qq-space-export-work --login-timeout 900 --max-pages 20\`
        下面这些要求是**自己重写探针时**才要照着做的。
      - **必须用系统 Chrome**：\`chromium.launchPersistentContext\` 要显式传 \`executablePath\`
        （macOS: \`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\`），
        否则会去用 Playwright 自带的 chromium，本机往往没装（\`npx playwright install\`）。
      - **必须等抓取脚本完全退出后再跑**：同一个 user-data-dir 不能被两个 Chrome 同时打开。
      - 探针的原始响应先落盘（如 \`feed-raw-dump.json\`），再从里面算差集，别只看接口返回的条数。
      - ⚠️ **每翻一页就落一次盘**（原始 dump 和 qzone_archive.json 都写）。
        这个接口被 WAF 拦是常态，中途断掉时，已经拿到的卡片不能跟着一起丢。
      - ⚠️ **请求按需发**：同一页先试桌面 cookie 头，拿到内容就直接用，
        别把三条通道都打一遍——每页多打两个请求，很容易撞上 WAF 限流。
      - ⚠️ **QQ 空间的 \`uin\` / \`p_skey\` 是会话 cookie，浏览器一关就没了。**
        持久化的 chrome-profile 里只剩 ptlogin2 的 cookie，回溯探针必须在自己的浏览器窗口里**再登一次**。
        所以探针要留足等待时间（建议 15 分钟）并明确提示用户扫码，别指望复用上一次的登录态。
      - ⚠️ **判断「登录好了」必须看 \`p_skey\`，不能只看 \`uin\`**。
        持久化 profile 里常留着 \`uin\` / \`skey\` 的残骸（名字还在、值也短），
        光有它们接口一律回 \`code:-3000 need login\`。判定条件：
        \`uin\` 有效 **且** \`p_skey\` 存在且长度正常（>10）。
        只扫码不点手机 QQ 的「确认登录」，\`p_skey\` 不会下发——
        提示用户时要说明「扫码 + 手机确认」两步，缺一个都拿不到数据。
        踩过的坑：把残留 \`uin\` 当成登录就绪，直接跳过等待，空跑十分钟才发现根本没登上。
      - ⚠️ **这个接口要桌面端会话**。两种发法都试，哪种通用用哪种：
        a. **显式带桌面 cookie 头**（照 QQ-Zone-Restore-Archive 的做法，最稳）：
           从浏览器 cookies 里取 \`uin\` / \`skey\` / \`p_uin\` / \`pt4_token\` / \`p_skey\`
           拼成 \`uin=o<QQ号>; skey=..; p_uin=o<QQ号>; pt4_token=..; p_skey=..\`，
           再配上桌面 Referer（\`https://user.qzone.qq.com/<QQ号>/main\`）和桌面 UA，
           用 \`context.request.get(url, { headers: { cookie, referer, 'user-agent' } })\` 发。
        b. 页面内同源 \`fetch(url, {credentials:'include'})\`：
           页面必须先停在 \`https://user.qzone.qq.com/<QQ号>/main\`。
           页面停在别的域（比如 i.qq.com 登录中转页）会被 CORS 掐掉，
           表现是 \`TypeError: Failed to fetch\`（status 0），看起来像没登录。
      - ⚠️ **cookie 要在「页面真的停在 user.qzone.qq.com 上」之后才取全**。
        扫码后页面会先落到 i.qq.com 登录中转页，这时 QZone 的 \`p_skey\` / \`pt4_token\`
        还没下发；而一旦页面停在 i.qq.com 上，服务端又会把这些 cookie 重新下发成**空值**
        （名字还在、值没了）。所以：等页面自己跳回 user.qzone.qq.com，再取 cookie，
        并且全程保留「字段最全」的那次快照。
      - ⚠️ **会被腾讯 WAF 限流**：请求太密会返回 HTTP 501 + \`waf.tencent.com\` 页面。
        看到这个就退避重试（等 30 秒以上），翻页之间也留 3–5 秒。
        一次完整回溯不要反复重跑——跑得越勤，冷却越久。
   c. 归档库和历史消息都没有 → 写一个空的 \`{"dynamics": [], "feeds": []}\`，
      并在报告里明确写：**本机既没有 QQ 客户端缓存，也没有归档库，已删除说说无法回溯**。这不是导出失败。

4. 归档库转 JSON（第 3 步 a 找到了库才做）：
   - dynamics 表取 cell_id, published_at, content, author_uin, author_name, category, pictures_json, video_json
   - feeds 表取 cell_id, event_type, event_time, actor_uin, actor_name, comments_json, event_summary, feed_key
   - 每条 dynamics 额外计算 is_history_residue：是否存在同 owner_uin 同 cell_id 且 feed_key LIKE 'history-v2-event:%' 的 feed
   - 输出 {"dynamics": [...], "feeds": [...]} 到 \`<RAW_DIR>/qzone_archive.json\`

5. 收尾报告要包含：实际抓到的条数、覆盖年份区间、评论/点赞/图片数、文件是否写入成功，
   以及回溯到多少条已删除说说（**0 条也要说清原因**）。

## 约束
- 只处理用户本人账号的数据，不要抓取他人的空间。
- 遇到验证码、风控提示，提示用户稍后再试，不要尝试绕过。
- 如果某一步失败，明确说明失败原因和已经完成的部分，不要用占位数据伪装成功。`;


const CHAT_SYSTEM = `你是一个以用户本人身份说话的 QQ 聊天机器人。你的全部依据来自下面提供的「知识库资料」和「你是谁」。

硬性规则：
1. 只能使用资料中出现过的信息回答。资料里没有的，宁可不知道。
2. 严禁编造具体的时间、地点、人物、事件、数字。
3. 如果资料不足以回答，用一句话说明不知道，不要猜测、不要扩写、不要给建议。
4. 所有历史内容一律用**过去时态**叙述，因为资料是过去留下的记录。
5. 语气模仿资料里的用户：短句、口语化、不说教、不用"作为 AI"这类自称。
6. 回答控制在 1-3 句，像发朋友圈一样短。
7. 不要输出"根据资料""根据知识库"这类元叙述。
8. 只输出最终回答本身：不要写前言、检索过程、标题、markdown 或任何解释。
9. 「你是谁」段是用户本人的人生底色：被问到性格、那几年、当时的状态时，
   就按那一段的口吻回答，不要说"根据我的资料"，直接以本人语气说。
10. 资料里标了「正文未能恢复」的说说，只能说它发过、什么时候发、被谁互动过，
    不要猜它当时写了什么。
11. 尽量用资料里的原话和原词，别把话换过说法说——那样既不像本人，
    也容易被判成「没落在资料里」。`;

/** @param {import('./miniapp-api.js').MiniAppContext} context */
export async function start(context) {
  const store = new Store(context.dataDir);
  await store.init();

  const runtime = {
    store,
    context,
    exportController: null,
    exportSessionId: null,
    pendingPermission: null,
    index: null,
    chatContext: [],
    profile: null,
    profileJob: { running: false, status: '', message: '' },
    chatJobs: new Map(),
    chatSeq: 0,
    buildLock: false,
  };

  const clientEntry = await readFile(join(context.pluginRoot, 'miniapp/client/index.html'), 'utf8');
  runtime.clientEntry = clientEntry;

  const server = createServer((request, response) => {
    handle(request, response, runtime).catch((error) => {
      context.logger.error('miniapp.request.failed', { message: String(error?.message ?? error) });
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      response.end(JSON.stringify({ error: 'internal_error', message: String(error?.message ?? error) }));
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(context.listen.port, context.listen.host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  context.logger.info('miniapp.runtime.listening');

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    context.signal.removeEventListener('abort', onAbort);
    runtime.exportController?.abort();
    await new Promise((resolve) => server.close(() => resolve()));
  };
  const onAbort = () => {
    void dispose();
  };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();

  return { dispose };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
async function handle(request, response, runtime) {
  const url = new URL(request.url ?? '/', 'http://miniapp.local');
  const path = url.pathname;

  if (request.method === 'GET' && (path === '/dashboard' || path === '/')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(runtime.clientEntry);
    return;
  }
  if (request.method === 'GET' && path === '/api/state') {
    return json(response, await snapshot(runtime));
  }
  if (request.method === 'GET' && path === '/api/search') {
    const query = url.searchParams.get('q') ?? '';
    return json(response, await searchPreview(runtime, query));
  }
  if (request.method === 'POST' && path === '/api/export/start') {
    const body = await readBody(request);
    return json(response, await startExport(runtime, body));
  }
  if (request.method === 'POST' && path === '/api/export/stop') {
    return json(response, await stopExport(runtime));
  }
  if (request.method === 'POST' && path === '/api/permission') {
    const body = await readBody(request);
    return json(response, await answerPermission(runtime, body));
  }
  if (request.method === 'POST' && path === '/api/kb/build') {
    const body = await readBody(request);
    return json(response, await buildKnowledgeBase(runtime, body));
  }
  if (request.method === 'POST' && path === '/api/profile/build') {
    return json(response, await buildPersonaProfile(runtime));
  }
  if (request.method === 'GET' && path === '/api/profile') {
    const profile = runtime.profile ?? (await loadProfile(runtime));
    if (!profile) return json(response, { ok: false, message: '还没有生成人物画像' });
    return json(response, {
      ok: true,
      source: profile.source,
      narrative: profile.narrative,
      facts: profile.facts,
    });
  }
  if (request.method === 'POST' && path === '/api/chat') {
    const body = await readBody(request);
    return json(response, await startChat(runtime, body));
  }
  if (request.method === 'GET' && path === '/api/chat/result') {
    return json(response, chatResult(runtime, url.searchParams.get('id') ?? ''));
  }
  if (request.method === 'POST' && path === '/api/persona') {
    const body = await readBody(request);
    return json(response, await savePersona(runtime, body));
  }
  if (request.method === 'POST' && path === '/api/reset') {
    return json(response, await reset(runtime));
  }

  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'not_found' }));
}

function json(response, payload, status = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    request.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 状态快照
// ---------------------------------------------------------------------------
async function snapshot(runtime) {
  const { store } = runtime;
  await store.loadState();
  const raw = await store.listRaw();
  return {
    phase: store.state.phase,
    message: store.state.message,
    progress: store.state.progress ?? [],
    stats: store.state.stats,
    ownerUin: store.state.ownerUin,
    persona: store.state.persona,
    lastError: store.state.lastError,
    rawFiles: raw,
    hasMessages: raw.includes('qzoneexport_messages.json'),
    hasArchive: raw.includes('qzone_archive.json'),
    // 演示数据标记：界面要明确提示，避免把样例当成自己的真实说说
    isDemo: raw.includes('demo.json'),
    hasProfile: Boolean(runtime.profile),
    profileSource: runtime.profile?.source ?? '',
    profileBuilding: Boolean(runtime.profileJob?.running),
    profileStatus: runtime.profileJob?.status ?? '',
    profileMessage: runtime.profileJob?.message ?? '',
    pendingPermission: runtime.pendingPermission
      ? {
          requestId: runtime.pendingPermission.requestId,
          toolName: runtime.pendingPermission.toolName,
          description: runtime.pendingPermission.description,
        }
      : null,
    exporting: Boolean(runtime.exportController),
    fallbackAnswer: FALLBACK_ANSWER,
  };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
/**
 * 把导出运行器写进数据目录，交给 Agent 调用。
 * 运行器的内容随包发布，Agent 不需要自己即兴写启动脚本——
 * 之前的问题正是 Agent 自行写了个无限重启的监督器，把浏览器反复弹给用户。
 */
async function prepareExportRunner(runtime) {
  const dir = join(runtime.store.dataDir, 'export');
  await mkdir(dir, { recursive: true });
  const runnerPath = join(dir, 'qq_export_runner.py');
  const source = join(runtime.context.pluginRoot, 'miniapp', 'node', 'export-runner.py');
  await writeFile(runnerPath, await readFile(source, 'utf8'), 'utf8');
  return { runnerPath, statusPath: join(dir, 'export-status.json') };
}

async function startExport(runtime, body) {
  const { store, context } = runtime;
  if (runtime.exportController) {
    return { ok: false, message: '导出已在进行中' };
  }
  if (!context.agent) {
    return { ok: false, message: '当前宿主未授予 Agent 调用权限（agentAccess: session.run）' };
  }
  const ownerUin = String(body.ownerUin ?? '').trim();
  const rawDir = join(store.dataDir, 'raw');
  const { runnerPath, statusPath } = await prepareExportRunner(runtime);
  const instruction = EXPORT_INSTRUCTION
    .replaceAll('<RAW_DIR>', rawDir)
    .replaceAll('<RUNNER_PATH>', runnerPath)
    .replaceAll('<STATUS_PATH>', statusPath);

  const controller = new AbortController();
  runtime.exportController = controller;
  runtime.exportSessionId = null;
  runtime.pendingPermission = null;
  await store.saveState({
    phase: PHASE.EXPORTING,
    message: '正在准备导出，请留意弹出的 QQ 空间登录窗口',
    lastError: '',
    ownerUin: ownerUin || store.state.ownerUin,
  });
  await store.clearProgress();

  void (async () => {
    try {
      const result = await context.agent.run(
        { text: instruction, sessionId: runtime.exportSessionId ?? undefined },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'turn.started') {
              runtime.exportSessionId = event.sessionId;
              void store.appendProgress({ kind: 'turn', text: 'Agent 已开始执行导出流程' });
            } else if (event.type === 'message.committed') {
              const text = typeof event.text === 'string' ? event.text : '';
              if (text) void store.appendProgress({ kind: 'message', text: text.slice(0, 500) });
            } else if (event.type === 'tool.started') {
              void store.appendProgress({ kind: 'tool', text: `调用工具 ${event.name ?? ''}` });
            } else if (event.type === 'permission.requested') {
              runtime.pendingPermission = {
                requestId: event.requestId,
                sessionId: event.sessionId,
                toolName: event.toolName ?? '',
                description: event.reason ?? '',
              };
              void store.appendProgress({ kind: 'permission', text: `需要授权：${event.toolName ?? '某项操作'}` });
            }
          },
        },
      );
      runtime.exportSessionId = result.sessionId ?? runtime.exportSessionId;
      if (result.status === 'finished') {
        await store.appendProgress({ kind: 'done', text: '导出流程结束' });
        await store.saveState({
          phase: PHASE.IDLE,
          message: '导出流程已结束，请检查文件是否就绪后点击「构建知识库」',
        });
      } else if (result.status === 'aborted') {
        await store.saveState({ phase: PHASE.IDLE, message: '导出已取消' });
      } else {
        await store.saveState({
          phase: PHASE.FAILED,
          message: '导出未成功完成',
          lastError: result.error?.message ?? '未知错误',
        });
      }
    } catch (error) {
      await store.saveState({
        phase: PHASE.FAILED,
        message: '导出过程出错',
        lastError: String(error?.message ?? error),
      });
    } finally {
      runtime.exportController = null;
      runtime.pendingPermission = null;
    }
  })();

  return { ok: true, message: '导出已启动' };
}

async function stopExport(runtime) {
  runtime.exportController?.abort();
  runtime.exportController = null;
  await runtime.store.saveState({ phase: PHASE.IDLE, message: '已请求停止导出' });
  return { ok: true };
}

async function answerPermission(runtime, body) {
  const pending = runtime.pendingPermission;
  if (!pending) return { ok: false, message: '没有待处理的授权请求' };
  const decision = body.decision === 'allow' ? 'allowOnce' : 'deny';
  try {
    await runtime.context.agent.reply({
      sessionId: pending.sessionId,
      requestId: pending.requestId,
      decision,
    });
    runtime.pendingPermission = null;
    await runtime.store.appendProgress({
      kind: 'permission',
      text: decision === 'allow' ? '已允许本次操作' : '已拒绝本次操作',
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

// ---------------------------------------------------------------------------
// 建库
// ---------------------------------------------------------------------------
async function buildKnowledgeBase(runtime, body) {
  const { store, context } = runtime;
  if (runtime.buildLock) return { ok: false, message: '正在构建中' };
  runtime.buildLock = true;
  try {
    const ownerUin = String(body.ownerUin ?? store.state.ownerUin ?? '').trim();
    const persona = String(body.persona ?? store.state.persona ?? '');

    await store.saveState({ phase: PHASE.BUILDING, message: '正在合并数据源', lastError: '' });

    const messages = await store.readRaw('qzoneexport_messages.json');
    const archive = await store.readRaw('qzone_archive.json');
    if (!messages && !archive) {
      await store.saveState({ phase: PHASE.FAILED, message: '还没有任何导出数据', lastError: '请先完成导出' });
      return { ok: false, message: '还没有任何导出数据，请先完成导出' };
    }

    const records = [];
    if (messages) records.push(...parseQzoneExport(messages));
    if (archive) records.push(...parseQzoneArchive(archive, ownerUin));
    if (!records.length) {
      await store.saveState({ phase: PHASE.FAILED, message: '没有解析出任何说说', lastError: '数据格式无法识别' });
      return { ok: false, message: '没有解析出任何说说' };
    }

    const merged = mergeRecords(records);

    // 交叉校验：能从说说 ID 反解出时间的，以 ID 为准
    for (const record of merged) {
      if (!record.published_at && ownerUin) {
        const decoded = moodCellIdPublishedAt(record.id, ownerUin, 0);
        if (decoded) {
          record.published_at = decoded;
          record.time_source = TIME_SOURCE.FROM_ID;
        }
      }
    }

    const chunks = buildChunks(merged);
    const summaries = buildYearSummaries(merged);

    await store.clearKb();
    await store.writeJsonl(store.unifiedPath, merged);
    await store.writeJsonl(store.chunksPath, chunks);
    await store.writeJsonl(store.summariesPath, summaries);

    const years = merged.map((r) => r.published_at).filter((v) => v > 0);
    const recovered = merged.filter((r) => r.recovered).length;
    const recoveredBodyMissing = merged.filter((r) => r.recovered && r.body_missing).length;
    // 回溯不到的时候要说清是「数据源没有」还是「真的一条都没有」，
    // 否则「已删除后恢复 0」看起来就像功能坏了。
    const archiveHasContent = Boolean(archive)
      && ((archive.dynamics?.length ?? 0) + (archive.feeds?.length ?? 0) > 0);
    const recoveryNote = recovered > 0
      ? (recoveredBodyMissing > 0
        ? `已回溯 ${recovered} 条已删除说说，其中 ${recoveredBodyMissing} 条正文没能恢复，只留下了发布时间和互动痕迹。`
        : '')
      : archiveHasContent
        ? '归档库已读取，但没有可恢复的互动残留。'
        : archive
          ? '归档库文件是空的：本机既没有 QQ 客户端缓存，也没有 QQ-Zone-Restore-Archive 归档库，已删除说说无法回溯。'
          : '本机既没有 QQ 客户端缓存，也没有 QQ-Zone-Restore-Archive 归档库，已删除说说无法回溯。';
    const stats = {
      totalRecords: merged.length,
      recovered,
      recoveredBodyMissing,
      unknownTime: merged.filter((r) => !r.published_at).length,
      chunkCount: chunks.length,
      summaryCount: summaries.length,
      yearFrom: years.length ? String(new Date(Math.min(...years) * 1000).getFullYear()) : '',
      yearTo: years.length ? String(new Date(Math.max(...years) * 1000).getFullYear()) : '',
      recoveryNote,
    };

    runtime.chatContext = [];
    runtime.chatJobs.clear();
    // 知识库变了，旧画像作废。
    runtime.profile = null;
    await store.removeProfile();
    // 但**立刻补一份统计底座**：纯统计、零成本、零编造，永远可用。
    // 不补的话，用户还没点「生成人物画像」时对话里没有人物底色，
    // 接地校验会因为命中率不够，把本来有据可依的回答误杀成
    // 「当时的我还不知道这是什么意思」——看着像知识库里没有，其实是校验太严。
    const baseline = buildProfile(merged, summaries);
    if (baseline) {
      await store.writeJson(store.profilePath, {
        facts: baseline.facts,
        narrative: '',
        source: 'facts',
        text: baseline.text,
        updatedAt: Date.now(),
      });
      runtime.profile = {
        chunk: { id: 'profile', text: baseline.text, year: '', published_at: 0, recovered: false },
        facts: baseline.facts,
        narrative: '',
        source: 'facts',
      };
    }
    runtime.index = buildIndex([...chunks, ...summaries, ...(runtime.profile ? [runtime.profile.chunk] : [])]);
    await store.saveState({ phase: PHASE.READY, message: '知识库已就绪', stats, persona, ownerUin });
    context.logger.info('miniapp.kb.built', { records: merged.length, chunks: chunks.length });
    return { ok: true, stats };
  } catch (error) {
    await store.saveState({
      phase: PHASE.FAILED,
      message: '构建失败',
      lastError: String(error?.message ?? error),
    });
    return { ok: false, message: String(error?.message ?? error) };
  } finally {
    runtime.buildLock = false;
  }
}

async function savePersona(runtime, body) {
  const persona = String(body.persona ?? '');
  await runtime.store.saveState({ persona });
  return { ok: true, persona };
}

async function reset(runtime) {
  const { store } = runtime;
  await store.clearKb();
  await store.saveState({ phase: PHASE.IDLE, message: '已清空知识库', stats: {}, progress: [] });
  runtime.index = null;
  runtime.chatContext = [];
  runtime.chatJobs.clear();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 人物画像
// ---------------------------------------------------------------------------

const PROFILE_SYSTEM = `你在为一个人整理人物档案，材料是他自己的社交动态记录。
只写材料里能读出来的东西，不做心理学发挥，不加"可能""也许"这类猜测。`;

/** 把全量说说按时间铺开，作为画像素材。 */
function profileMaterial(records) {
  return records
    .filter((r) => r.kind !== 'guestbook' && (r.content ?? '').trim())
    .sort((a, b) => (a.published_at || 0) - (b.published_at || 0))
    .map((record) => {
      const time = record.published_at
        ? new Date(record.published_at * 1000).toISOString().slice(0, 10)
        : '时间未知';
      const where = record.location ? `｜${record.location}` : '';
      const social = record.like_count
        ? `｜${record.like_count}赞/${(record.comments ?? []).length}评论`
        : '';
      return `${time}${where}${social} ${record.content}`;
    })
    .join('\n');
}

function profilePrompt(records, baseline) {
  return [
    PROFILE_SYSTEM,
    '',
    '【统计画像】',
    baseline.facts,
    '',
    '【全部说说（按时间排序）】',
    profileMaterial(records),
    '',
    '【任务】',
    '写一份第三人称人物档案，300–600 字，分四段，每段一个标题：',
    '时间线：这个人从哪一年到哪一年，在做什么，有哪些阶段性的变化；',
    '社交与生活：常去的地方、常来往的人、生活场景；',
    '说话方式：句子长度、口头禅、语气习惯；',
    '性格：他是个什么样的人，遇事什么反应。',
    '',
    '【硬性要求】',
    '1. 只写上面材料里出现过的事实，不要写材料里没有的时间、地点、人物、事件、数字。',
    '2. 不要写"作为一个 AI""综上所述"这类元叙述。',
    '3. 用具体的材料细节说话，不要堆砌空泛形容词。',
  ].join('\n');
}

/**
 * 生成人物画像。
 * 底座是确定性统计——永远可用、零成本、零编造；
 * 再用大模型把它润色成一段能指导角色扮演的叙述，
 * 叙述中凡出现资料外事实的句子会被剔除，剩得太少就退回统计版。
 *
 * 走后台任务而不是同步等待：读全量说说再让大模型归纳要几十秒，
 * 挂在 HTTP 请求里会被宿主代理掐断。进度经 /api/state 暴露。
 */
async function buildPersonaProfile(runtime) {
  const { store, context } = runtime;
  if (runtime.profileJob.running) return { ok: false, message: '人物画像正在生成中' };
  runtime.profileJob = { running: true, status: 'running', message: '正在读完全部说说并归纳…' };

  void (async () => {
    try {
      const records = await store.readJsonl(store.unifiedPath);
      const summaries = await store.readJsonl(store.summariesPath);
      if (!records.length) {
        runtime.profileJob = { running: false, status: 'error', message: '还没有知识库，请先点「构建知识库」' };
        return;
      }
      const baseline = buildProfile(records, summaries);
      if (!baseline) {
        runtime.profileJob = { running: false, status: 'error', message: '没有可用于归纳的说说内容' };
        return;
      }
      runtime.profileJob = { running: true, status: 'running', message: '统计底座已生成，正在让大模型润色…' };

      let narrative = '';
      let source = 'facts';
      if (context.agent) {
        try {
          const result = await context.agent.run(
            { text: profilePrompt(records, baseline) },
            { signal: context.signal },
          );
          if (result.status === 'finished' && result.text) {
            // 校验源必须是「带时间地点的记录」而不是纯正文——
            // 叙述里本来就会讲「2015 年那会儿」，只拿正文去校验会把这类句子全判成无依据。
            const sourceText = profileMaterial(records);
            const cleaned = sanitizeNarrative(result.text, sourceText);
            // 判据是「站得住的句子够不够多」，不是字数——
            // 一句话的回复不是画像，句子够多且大半站得住才算。
            if (cleaned.kept >= 3 && cleaned.kept / cleaned.total >= 0.5) {
              narrative = cleaned.text;
              source = 'llm';
            } else {
              context.logger.info('miniapp.profile.narrative_rejected', {
                kept: cleaned.kept,
                total: cleaned.total,
              });
            }
          }
        } catch (error) {
          context.logger.info('miniapp.profile.llm_failed', { message: String(error?.message ?? error) });
        }
      }

      const text = narrative
        ? `[类型] 人物画像（由全量说说归纳；叙述部分由大模型生成，已逐句做过事实校验）\n\n${narrative}\n\n${baseline.facts}\n`
        : baseline.text;

      await store.writeJson(store.profilePath, {
        facts: baseline.facts,
        narrative,
        source,
        text,
        updatedAt: Date.now(),
      });

      runtime.profile = {
        chunk: { id: 'profile', text, year: '', published_at: 0, recovered: false },
        facts: baseline.facts,
        narrative,
        source,
      };

      const chunks = await store.readJsonl(store.chunksPath);
      const summaryRows = await store.readJsonl(store.summariesPath);
      runtime.index = buildIndex([...chunks, ...summaryRows, runtime.profile.chunk]);
      runtime.chatContext = [];

      runtime.profileJob = {
        running: false,
        status: 'done',
        message: source === 'llm' ? '已生成（叙述由大模型润色并逐句校验）' : '已生成（统计版）',
      };
    } catch (error) {
      runtime.profileJob = {
        running: false,
        status: 'error',
        message: `生成失败：${String(error?.message ?? error)}`,
      };
    }
  })();

  return { ok: true, started: true, message: '已开始生成人物画像' };
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------
async function ensureIndex(runtime) {
  if (runtime.index) return runtime.index;
  const chunks = await runtime.store.readJsonl(runtime.store.chunksPath);
  const summaries = await runtime.store.readJsonl(runtime.store.summariesPath);
  if (!chunks.length && !summaries.length) return null;
  await loadProfile(runtime);
  runtime.index = buildIndex([...chunks, ...summaries, ...(runtime.profile ? [runtime.profile.chunk] : [])]);
  return runtime.index;
}

/** 读取已生成的人物画像。画像不参与「是否有依据」的判断，只作为人物底色注入。 */
async function loadProfile(runtime) {
  const raw = await runtime.store.readJson(runtime.store.profilePath);
  if (!raw || !raw.facts) {
    runtime.profile = null;
    return null;
  }
  runtime.profile = {
    chunk: { id: 'profile', text: raw.text ?? '', year: '', published_at: 0, recovered: false },
    facts: raw.facts ?? '',
    narrative: raw.narrative ?? '',
    source: raw.source ?? 'facts',
  };
  return runtime.profile;
}

async function searchPreview(runtime, query) {
  const index = await ensureIndex(runtime);
  if (!index) return { ok: true, hits: [], indexed: false };
  const hits = search(index, query, CHAT_TOP_K);
  return {
    ok: true,
    indexed: true,
    confident: isConfident(hits, query),
    hits: hits.map((hit) => ({
      id: hit.chunk.id,
      score: Number(hit.score.toFixed(3)),
      text: hit.chunk.text.slice(0, 400),
      year: hit.chunk.year,
    })),
  };
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

/**
 * 把本轮命中的块并入对话上下文。
 * 追问（「那后来呢」「他是谁」）本身检索不到新块时，也能用上一轮的真实资料作答；
 * 同时保证模型看过的每一段资料都是知识库原文，接地校验才有意义。
 */
function mergeChatContext(runtime, hits) {
  const map = new Map();
  for (const hit of hits) map.set(hit.chunk.id, hit.chunk);
  for (const chunk of runtime.chatContext) map.set(chunk.id, chunk);
  const merged = [...map.values()].slice(0, CHAT_CONTEXT_LIMIT);
  runtime.chatContext = merged;
  return merged;
}

/**
 * 对话入口。
 *
 * 检索闸门是同步的：命中不足就直接回固定话术，连模型都不调——这条路径上不存在编造的机会。
 *
 * 需要模型时**不在 HTTP 请求里等**。宿主会在请求超时后掐断连接，
 * 挂在请求里的模型回合会被一起杀掉，页面只看到「Failed to fetch」，答案全丢。
 * 所以这里只登记任务、立即返回，前端轮询 /api/chat/result 取结果。
 */
async function startChat(runtime, body) {
  const question = String(body.message ?? '').trim();
  if (!question) return { ok: false, message: '消息不能为空' };

  const index = await ensureIndex(runtime);
  if (!index) {
    return { ok: true, grounded: false, answer: FALLBACK_ANSWER, sources: [], reason: 'knowledge_base_empty' };
  }

  // 检索闸门：命中不足就不调用模型，直接回固定话术。
  const hits = search(index, question, CHAT_TOP_K);
  const profile = runtime.profile ?? (await loadProfile(runtime));
  const profileText = profile ? (profile.narrative || profile.facts) : '';

  // 泛化问法（「我是个什么样的人」「那几年我过得怎么样」）问不出实义词，
  // BM25 命中不了任何一条具体说说。但它们的答案就在人物画像里——
  // 画像同样是从全量说说归纳出来的，属于知识库，只是走的不是逐条检索这条路。
  // 所以画像存在时，这类问题直接放行给模型，答案仍然要过接地校验。
  const selfQuestion = isSelfCharacterQuestion(question);
  if (!isConfident(hits, question) && !(selfQuestion && profileText)) {
    return {
      ok: true,
      grounded: false,
      answer: FALLBACK_ANSWER,
      sources: [],
      reason: 'no_confident_match',
    };
  }

  runtime.chatSeq += 1;
  const id = `chat-${runtime.chatSeq}`;
  const job = {
    id,
    question,
    status: 'running',
    grounded: false,
    answer: '',
    sources: [],
    reason: '',
    rejected: '',
    error: '',
  };
  runtime.chatJobs.set(id, job);
  // 任务表只留最近的若干条，避免长时间运行后无限增长。
  while (runtime.chatJobs.size > 20) {
    const oldest = runtime.chatJobs.keys().next().value;
    runtime.chatJobs.delete(oldest);
  }

  // 上下文在受理请求时就并好：多轮追问的资料顺序跟提问顺序一致。
  const chunks = mergeChatContext(runtime, hits);
  void runChatJob(runtime, job, hits, chunks, profileText).catch((error) => {
    job.status = 'error';
    job.error = String(error?.message ?? error);
  });

  return { ok: true, started: true, id };
}

/** 前端轮询用：取一个对话任务的结果。 */
function chatResult(runtime, id) {
  const job = runtime.chatJobs.get(id);
  if (!job) return { ok: false, status: 'missing', message: '没有这个对话任务' };
  if (job.status === 'running') return { ok: true, status: 'running' };
  if (job.status === 'error') return { ok: false, status: 'error', message: job.error || '生成回答失败' };
  return {
    ok: true,
    status: 'done',
    grounded: job.grounded,
    answer: job.answer,
    sources: job.sources,
    reason: job.reason,
    rejected: job.rejected,
  };
}

/** 后台跑模型回合：脱离 HTTP 请求的生命周期，宿主掐断请求也不会影响它。 */
async function runChatJob(runtime, job, hits, chunks, profileText) {
  const { store, context } = runtime;
  const question = job.question;

  const persona = store.state.persona || '';
  const kbText = chunks
    .map((chunk, index2) => `【资料 ${index2 + 1}】\n${chunk.text}`)
    .join('\n\n');
  // 人设是用户自己写的，属于可信事实，同样纳入接地上下文，
  // 免得模型复述人设里的年份时被误判成编造。
  const contextText = [
    profileText ? `【你是谁】\n${profileText}` : '',
    persona ? `【人设】\n${persona}` : '',
    kbText,
  ].filter(Boolean).join('\n\n');
  const prompt = [
    CHAT_SYSTEM,
    '',
    profileText ? `【你是谁】\n${profileText}\n` : '',
    persona ? `【人设】\n${persona}\n` : '',
    '【知识库资料】',
    kbText || '（本轮没有检索到具体说说，请依据「你是谁」这一段回答）',
    '',
    `【用户的问题】\n${question}`,
    '',
    '只依据上面的「知识库资料」和「你是谁」回答。两段里都没有的信息不要编造；'
      + '如果资料不足以回答，就直说不知道。',
  ].filter(Boolean).join('\n');

  if (!context.agent) {
    job.status = 'error';
    job.error = '当前宿主未授予 Agent 调用权限，无法生成回答';
    return;
  }

  let result;
  try {
    // 每个问题都用独立会话：上一轮被判为编造的原话不会留在会话历史里污染下一轮。
    // 连续性靠上面显式并入的知识库上下文维持，不靠模型记忆。
    result = await context.agent.run(
      { text: prompt },
      {
        signal: context.signal,
        onEvent: (event) => {
          // 对话里一律禁用工具：模型只能看本轮给的资料，不能上网、不能读文件。
          if (event.type === 'permission.requested') {
            void context.agent
              .reply({ sessionId: event.sessionId, requestId: event.requestId, decision: 'deny' })
              .catch(() => {});
          }
        },
      },
    );
  } catch (error) {
    job.status = 'error';
    job.error = String(error?.message ?? error);
    return;
  }
  if (result.status !== 'finished' || !result.text) {
    job.status = 'error';
    job.error = result.error?.message ?? `生成回答失败（${result.status}）`;
    return;
  }

  const answer = result.text.trim();
  const ratio = groundingRatio(answer, contextText);
  const factsOk = factualTokensGrounded(answer, contextText);
  if (ratio < GROUNDING_RATIO_MIN || !factsOk) {
    // 答案没有落在检索到的资料里，判定为编造，改用固定话术
    const reason = factsOk ? 'low_grounding_ratio' : 'ungrounded_factual_claim';
    context.logger.info('miniapp.chat.grounding_rejected', { ratio: Number(ratio.toFixed(3)), reason });
    job.status = 'done';
    job.grounded = false;
    job.answer = FALLBACK_ANSWER;
    job.reason = reason;
    job.sources = hits.map((hit) => ({ id: hit.chunk.id, score: Number(hit.score.toFixed(3)) }));
    job.rejected = answer.slice(0, 300);
    return;
  }

  job.status = 'done';
  job.grounded = true;
  job.answer = answer;
  job.sources = hits.map((hit) => ({
    id: hit.chunk.id,
    score: Number(hit.score.toFixed(3)),
    text: hit.chunk.text.slice(0, 240),
    year: hit.chunk.year,
  }));
}
