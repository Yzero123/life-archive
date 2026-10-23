// QQ 空间说说知识库 · Node 服务
//
// 职责：
//   1. 对外提供窄业务路由（页面只管展示）
//   2. 驱动 Agent 完成 QQ 登录与全量导出
//   3. 合并两路数据源、切知识块、建检索索引
//   4. 对话：先检索，检索不到直接回固定话术；检索到才让 Agent 基于资料作答，并做接地校验

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PHASE,
  Store,
} from './store.mjs';

import {
  buildChunks,
  buildGroundingText,
  buildIndex,
  buildKbDigest,
  buildProfile,
  buildYearSummaries,
  FALLBACK_ANSWER,
  factualTokensGrounded,
  groundingRatio,
  isConfident,
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

// ---------------------------------------------------------------------------
// 宿主模型回合的调用与重试
// ---------------------------------------------------------------------------
//
// 宿主在 Mini App 刚启动、或者运行时换代（restart / 发布）的那一小段时间里，
// Agent 桥会回 `AGENT_UNAVAILABLE`（对外映射成 runtime_unavailable）。
// 宿主的定义很明确：**「什么都没开始，稍后重试即可」**——不是失败，也不是拒绝。
//
// 不重试的代价很实在：Mini App 起来后问的**第一句话**会直接报错，
// 而第二句开始又正常了，看起来像"偶发抽风"。实测（v1.7.0 自检）：
// 刚启动后第一问「我是个什么样的人」就撞上这个错误，
// 同一进程里的后三问全部正常——所以这确实是启动窗口，不是内容问题。
//
// 注意别把 `AGENT_OUTCOME_UNKNOWN` 也重试掉：那个码的意思是
// 「回合可能已经跑了」，重试会把同一个问题问两遍。
const AGENT_RETRY_CODES = new Set(['AGENT_UNAVAILABLE', 'BUSY', 'runtime_unavailable', 'busy']);
const AGENT_RETRY_ATTEMPTS = 3;
const AGENT_RETRY_DELAY_MS = 800;

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 宿主把这个错误语义化了：可重试 = 什么都没开始。 */
function isRetryableAgentError(error) {
  const code = String(error?.code ?? '');
  if (AGENT_RETRY_CODES.has(code)) return true;
  const message = String(error?.message ?? '');
  return /unavailable|busy/i.test(message);
}

/** 调一次宿主模型回合；遇到可重试错误就退避后重试。 */
async function runAgentTurn(context, input, options) {
  let lastError = null;
  for (let attempt = 0; attempt < AGENT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await context.agent.run(input, options);
    } catch (error) {
      lastError = error;
      if (!isRetryableAgentError(error)) break;
      if (attempt === AGENT_RETRY_ATTEMPTS - 1) break;
      await delay(AGENT_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

// 措辞重合度**不再**作为拒答条件，只留作展示参考。
//
// 为什么撤掉：中文口语回答里虚词二元组（「那帮人」「倒是没少」）天然不重合，
// 拿它当闸门会把**有据可依**的回答误杀成固定话术——那看起来像「知识库里没有」，
// 其实是有。实测：纯真转述 0.73，有据口语转述 0.33，边界样本 0.28，
// 纯编造 0.04，掺假经历 0.17——有据的和掺假的根本分不开，拿它当闸门只会误杀。
// 真正的硬红线是事实级校验（日期 / 数字 / 外文专名 / 引介人名不许编），
// 而且现在拿**整个知识库**当对照范围，判定的是「库里有没有出处」。

const EXPORT_INSTRUCTION = `请帮用户完成一次 QQ 空间历史说说的全量导出，并把结果写到指定路径。

## 目标产物（必须真实产出，不能用样例数据代替）
1. \`<RAW_DIR>/qzoneexport_messages.json\` —— QZoneExport 的 messages.json，数组格式，每条至少含 tid / content / created_time 三个字段。
2. \`<RAW_DIR>/qzone_archive.json\` —— 已删除说说的回溯结果，格式为 {"dynamics": [...], "feeds": [...]}。
   **即使一条都没捞到也要写这个文件**（空数组），这样界面能区分「没捞到」和「根本没试」。

## 本次流程只扫码一次
导出和回溯共用**同一个常驻浏览器**——运行器自己起系统 Chrome，带调试端口和持久化 profile，
导出跑完**不关它**，回溯再挂上去复用同一份登录态。

QQ 空间的 uin / p_skey 是**会话 cookie**，浏览器一关就没。所以：
- ✅ 浏览器窗口开着的时候，全程只需要用户**扫码一次**（扫码 + 手机 QQ 点「确认登录」两步）。
- ❌ **不要关掉那个浏览器窗口**，不要删它的 profile 目录
  （\`<WORK_DIR>/resource/temp/chrome-profile-session\`），不要另起浏览器、不要换 profile。

## 铁律
1. **只启动一次，不要写任何自动重跑循环。** 不要写 supervisor、守护进程、while 循环去反复重启。
   反复重开浏览器会把用户逼疯，而且每次都要重新扫码。
2. **运行器必须挂后台**，绝不能挂在一次前台工具调用里——它要等用户扫码，可能十几分钟。
   运行器自己会处理这件事：调用一次之后你只管轮询状态文件。
3. **浏览器被关闭 = 用户主动中止**，立刻停下来报告，不要自动重开。
   断点保留在 result 目录里，用户自己会再点一次「开始导出」续跑。
4. **回溯必须复用常驻浏览器的 CDP 端点**（状态文件里的 \`cdpUrl\`），不要自己开浏览器。
5. 登录态看着空了（服务端把 cookie 重新下发成空值）时，先跑 \`revisit\` 把它拉回来，
   **不要直接让用户重新扫码**——浏览器还开着，重新访问一次空间首页就能补回来。

## 步骤

### 0. 启动导出流水线

\`<PLUGIN_ROOT>\` 是插件根目录（下面要用它下面的 tools/），\`<WORK_DIR>\` 是工作目录。

\`\`\`
python3 "<RUNNER_PATH>" --status "<STATUS_PATH>" --plugin-root "<PLUGIN_ROOT>" --work-dir <WORK_DIR> --owner <QQ号>
\`\`\`

它会立刻返回（挂后台），并打印状态文件路径。**只调用这一次**，之后只轮询。

### 1. 告诉用户扫码（就这一次）

读状态文件：

\`\`\`
cat "<STATUS_PATH>"
\`\`\`

- \`state\` 是 \`waiting_login\` → 告诉用户：「浏览器窗口已经打开，请用手机 QQ 扫码登录 QQ 空间，
  **并在手机上点「确认登录」**。整个流程只需要扫这一次，后面回溯也不用再扫。」
  然后隔一会儿再读一次状态文件汇报进度。**不要重复启动运行器。**
- \`state\` 是 \`exporting\` → 抓取中。看 \`<WORK_DIR>/export-run.log\` 尾部汇报进度
  （已抓页数、累计条数）。**绝不要重新启动。**
- \`state\` 是 \`failed\` → 读 \`error\` 字段，如实报告给用户。

状态文件里还带 \`cdpUrl\`（常驻浏览器的调试端点）、\`browserPid\`、\`uin\`、\`log\`、\`sessionState\`——回溯要用。

### 2. 落盘：把工具产物转成 messages.json

抓取结束后，把 \`get-qzone-history/resource/result/\` 里的 messages JSON 转成
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
| \`likeTotal\` | DOM 里的**赞**数 | ⚠️ 工具的 \`like_count\` 是**转发**数（原始串「评论(20)转发(490)」里 490 是转发），**别用**。赞数从 DOM 的 \`a.qz_like_btn\` 取，文本形如「赞(345)」——同一个容器里还有一个隐藏的空模板，取**有数字**的那个 |
| \`commentlist\` | DOM 里的评论条目 | 每条含 \`content\` / \`nick\` / \`createTime\` / \`replys\`。**正文抓不到就别硬编**，条数用下面的 \`cmtnum\` |
| \`cmtnum\` | 工具输出的 \`comment_count\` | 就是页面「评论(N)」里的 N，工具抓得准，**不要清零** |
| \`fwdnum\` | 工具输出的 \`like_count\` | 就是页面「转发(N)」里的 N。别把它当赞数用 |
| \`lbs\` | \`{"name":..,"address":..,"idname":..}\` | 定位，从 DOM 的定位文案取 |
| \`pic\` | 图片数组 | 每项放 \`{"hd_url":..,"b_url":..}\`，用 \`image_urls\` 里已下载的本地文件路径 |
| \`video\` | 视频数组 | 每项放 \`{"play_url":..}\` |
| \`post_url\` | \`https://user.qzone.qq.com/<QQ号>/mood/<tid>\` | |
| \`uin\` | 你的 QQ 号 | |
| \`source_name\` | 你的昵称 | |

**赞 / 评论 / 转发是三个数，别混。** 混了画像就会报出「55 万赞」这种对不上的结论——
知识库里有了这个数，校验也拦不住，bot 会照着说。

> 已知的缺口：现有说说的**评论正文**通常抓不到（要逐条展开「查看全部 N 条评论」，
> 工作量大且容易撞 WAF）。抓不到就只留**条数**，正文一个字都不要编。

时间和赞数如果从工具的 JSON 拿不准，就从页面 DOM 里取（之前就是这么做的，能拿到每条精确到秒的时间和准确的赞数）。

### 3. 回溯已删除说说（复用同一个浏览器，不用再扫码）

这一步最容易被跳过，跳过了用户会以为功能坏了。

**a. 先把登录态拉回来（不重新扫码）。** 抓取过程中浏览器可能换过页面，
服务端会把 QZone 的会话 cookie 重新下发成空值。跑一次这个，它会重新访问空间首页、
凭还在的 SSO 会话把 cookie 补回来：

\`\`\`
node "<PLUGIN_ROOT>/tools/qzone_session.js" revisit --state <WORK_DIR>/qzone-session.json --timeout 60
\`\`\`

返回的 \`loginReady\` 为 true 就继续；为 false 才需要让用户再扫一次（**在同一个窗口里扫，不用重启任何东西**）。

**b. 先找本机归档库**（QQ-Zone-Restore-Archive 的 SQLite），依次检查：
- macOS: \`~/Library/Application Support/top.ehre.qzonearchive/qzone-archive.sqlite3\`
- Windows: \`%APPDATA%\\top.ehre.qzonearchive\\qzone-archive.sqlite3\`
- 都没找到就搜一遍：\`find ~ -maxdepth 6 -iname "qzone-archive*.sqlite3" 2>/dev/null\`
  找到了就按第 4 步的方式转成 JSON。**找不到就跳过，绝不编造**。

**c. 本机没有归档库，就走互动中心的历史消息**：已删除但仍被人点赞评论的说说，
会在**历史消息卡片**里留下痕迹——卡片带 \`//user.qzone.qq.com/<QQ号>/mood/<cell_id>\` 链接，
而这个 cell_id 不在当前说说列表里。

接口（QQ-Zone-Restore-Archive 逆向出来的，公开可查）：
\`\`\`
https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds2_html_pav_all
?uin=<QQ号>&begin_time=0&end_time=0&get_appnotification=1&getnotifi=1
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

**d. 用包内现成的探针**（已实测跑通，把上面这些坑都处理了），关键是**带上 \`--cdp\`**：

\`\`\`
NODE_PATH=<导出工具目录>/node_modules node "<PLUGIN_ROOT>/tools/qzone_feed_recover.js" \\
  --target-qq <QQ号> --shuoshuo <导出产物 messages.json> --out <RAW_DIR>/qzone_archive.json \\
  --cdp <状态文件里的 cdpUrl> --work-dir <WORK_DIR> --login-timeout 300 --max-pages 20
\`\`\`

带 \`--cdp\` 之后它**挂到常驻浏览器上**，复用已有登录态，**不会新开浏览器、不需要再扫码**，
跑完也不会把常驻浏览器带走（CDP 连接下的 \`browser.close()\` 只断开客户端）。
不传 \`--cdp\` 就会退回老行为（自己开浏览器、需要在这个窗口里再登一次）——**别那样用**。

自己重写探针时还要照着做的硬要求：
- **必须用系统 Chrome**：\`chromium.launchPersistentContext\` 要显式传 \`executablePath\`
  （macOS: \`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\`），
  否则会去用 Playwright 自带的 chromium，本机往往没装（\`npx playwright install\`）。
- **判断「登录好了」必须看 \`p_skey\`，不能只看 \`uin\`**。
  持久化 profile 里常留着 \`uin\` / \`skey\` 的残骸（名字还在、值也短），
  光有它们接口一律回 \`code:-3000 need login\`。判定条件：
  \`uin\` 有效 **且** \`p_skey\` 存在且长度正常（>10）。
  只扫码不点手机 QQ 的「确认登录」，\`p_skey\` 不会下发——
  提示用户时要说明「扫码 + 手机确认」两步，缺一个都拿不到数据。
  踩过的坑：把残留 \`uin\` 当成登录就绪，直接跳过等待，空跑十分钟才发现根本没登上。
- 探针的原始响应先落盘（如 \`feed-raw-dump.json\`），再从里面算差集，别只看接口返回的条数。
- ⚠️ **每翻一页就落一次盘**（原始 dump 和 qzone_archive.json 都写）。
  这个接口被 WAF 拦是常态，中途断掉时，已经拿到的卡片不能跟着一起丢。
- ⚠️ **请求按需发**：同一页先试桌面 cookie 头，拿到内容就直接用，
  别把三条通道都打一遍——每页多打两个请求，很容易撞上 WAF 限流。
- 腾讯 WAF 会限流（HTTP 501 + \`waf.tencent.com\`）：被拦就退避 30 秒再试，
  翻页之间留 3–5 秒；一次回溯别反复重跑，跑得越勤冷却越久。

### 4. 归档库转 JSON（只在第 3 步 b 找到归档库时才需要）

读 SQLite 里的说说表，字段对齐 \`{"dynamics": [...], "feeds": [...]}\`：
- \`dynamics\`：每条含 \`cell_id\` / \`published_at\` / \`content\` / \`author_uin\`。
- \`published_at\` 用 unix 秒级时间戳；反解不出来就留 0，不要编一个日期。
- \`author_uin\` 用 cell_id 前 8 位小端 u32 解出来的作者 QQ 号。

## 完成

两个产物都写好后，回报给用户：说说总条数、覆盖年份区间、其中回溯回来多少条、
其中多少条正文没能恢复。**数字要如实说，回溯为 0 就说 0 并说明为什么**，
不要拿「应该差不多是这个量级」糊弄过去。
`;



const CHAT_SYSTEM = `你就是这个 QQ 空间号的主人，正在跟一个熟悉你的朋友聊天。
你的全部依据是下面给的「知识库资料」和「你是谁」——那是你自己过去留下的记录。

硬性规则：
1. 只说资料里有的事。资料里没有的时间、地点、人物、数字、事件，一个都不要提。
2. **如果资料不足以回答，只输出这一句**，不要解释、不要客套、不要追问：
   当时的我还不知道这是什么意思
3. 回答要像发朋友圈：1-3 句，短句、口语化、不说教、不用"作为 AI"这类自称。
4. 不要输出"根据资料""根据知识库"这类元叙述，直接说事。
5. 所有历史内容一律用**过去时态**叙述，因为资料是过去留下的记录。
6. 「你是谁」段是你的人生底色。被问到性格、那几年、当时的状态时，
   就按那一段的口吻回答，不要说"根据我的资料"。
7. 资料里标了「正文未能恢复」的说说，只能说它发过、什么时候发、被谁互动过，
   不要猜它当时写了什么。
8. 尽量用资料里的原话和原词，别把话换过说法说——那样才像本人。
9. **不必逐条复述**。可以把好几条记录串成一段话，按时间顺序讲，
   可以说自己的感受、想法和当时的处境。资料给够了，怎么说是你的事。
10. **条数、数量一律照【年度小结】里的数字抄**，不要自己去数【全库速览】的行数——
   数出来的数会错，而错的数字会被事实红线拦下。`;


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

/** 进程是否还活着（用来判断常驻浏览器有没有被用户关掉）。 */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读导出状态文件，整理成页面能直接显示的形状。
 *
 * 这里最要紧的是 **browserAlive**（常驻浏览器还活着吗）和 **loginReady**（登录态就绪吗）：
 * 用户最怕的就是「又要重扫一次」，页面必须把「浏览器还开着、登录态还在」
 * 这件事明确说出来——只要浏览器还活着，下一次扫码就是在这个窗口里补扫一次。
 */
async function readExportSession(dataDir) {
  const statusPath = join(dataDir, 'export', 'export-status.json');
  let status = null;
  try {
    status = JSON.parse(await readFile(statusPath, 'utf8'));
  } catch {
    return null;
  }
  if (!status || typeof status !== 'object') return null;
  // 旧版状态文件没有 browserPid（那时还没有常驻浏览器）。
  // 直接当成「没有会话」，别让页面误报「浏览器已关闭」。
  if (!('browserPid' in status)) return null;
  const browserAlive = isPidAlive(status.browserPid);
  const loginReady = Boolean(status.loginReady);
  return {
    state: String(status.state ?? ''),
    message: String(status.message ?? ''),
    error: String(status.error ?? ''),
    // cdpUrl 只回环地址 + 端口，没有敏感信息，但也没必要给页面完整串
    cdpEndpoint: status.cdpUrl ? String(status.cdpUrl).replace(/^https?:\/\//, '') : '',
    browserAlive,
    browserPid: status.browserPid ?? null,
    loginReady,
    uin: status.uin ?? '',
    exportPid: status.exportPid ?? null,
    workDir: status.workDir ?? '',
    log: status.log ?? '',
    updatedAt: status.updatedAt ?? null,
  };
}

/**
 * 知识库是不是「旧」的：raw 里的数据比 kb 新，说明导出过新数据但还没重建。
 *
 * 只看 phase 是看不出来的——导出流程结束后 phase 会被置回 idle，
 * 但知识库还在、照样能对话。页面上必须说清「现在对话用的是上一次的构建结果」。
 */
async function isKbStale(store) {
  let kbTime = 0;
  try {
    kbTime = (await stat(store.chunksPath)).mtimeMs;
  } catch {
    return false; // 还没有知识库，谈不上过期
  }
  if (!kbTime) return false;
  for (const path of [store.messagesPath, store.archivePath]) {
    try {
      const rawTime = (await stat(path)).mtimeMs;
      // 1 秒容差：写盘和建库可能在同一秒内完成，别误报。
      if (rawTime > kbTime + 1000) return true;
    } catch {
      // 这个原始文件不存在，跳过
    }
  }
  return false;
}

async function snapshot(runtime) {
  const { store } = runtime;
  await store.loadState();
  const raw = await store.listRaw();
  const exportSession = await readExportSession(store.dataDir);
  // 有没有可用的知识库——比 phase 更能说明「现在能不能聊」。
  const kbReady = Boolean(store.state.stats?.chunkCount);
  const kbStale = kbReady ? await isKbStale(store) : false;
  return {
    phase: store.state.phase,
    kbReady,
    kbStale,
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
    // 导出流水线（常驻浏览器 / 登录态）状态，页面用来显示「只扫一次」
    exportSession,
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
 *
 * 同时把插件根目录一起交出去：运行器要用它下面的 `tools/qzone_session.js`
 * 来管常驻浏览器（一次扫码的关键）。
 */
async function prepareExportRunner(runtime) {
  const dir = join(runtime.store.dataDir, 'export');
  await mkdir(dir, { recursive: true });
  const runnerPath = join(dir, 'qq_export_runner.py');
  const source = join(runtime.context.pluginRoot, 'miniapp', 'node', 'export-runner.py');
  await writeFile(runnerPath, await readFile(source, 'utf8'), 'utf8');
  return {
    runnerPath,
    statusPath: join(dir, 'export-status.json'),
    pluginRoot: runtime.context.pluginRoot,
    // 导出工具与常驻浏览器的落脚点。放在系统临时目录下，
    // 里面是 clone 出来的工具、依赖和浏览器 profile——不该进数据目录。
    workDir: join(tmpdir(), 'qq-space-export-work'),
  };
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

  // 后台抓取进程可能还在跑（Agent 那轮已经结束，但 worker 仍在后台抓）。
  // 这时再点一次「开始导出」会起第二个抓取进程，两个进程抢同一个浏览器。
  const prev = await readExportSession(store.dataDir);
  if (prev && prev.state === 'exporting' && isPidAlive(prev.exportPid)) {
    return {
      ok: false,
      message: `后台抓取还在运行（PID ${prev.exportPid}），不要重复启动。等它跑完或先关掉那个浏览器窗口。`,
    };
  }

  const { runnerPath, statusPath, pluginRoot, workDir } = await prepareExportRunner(runtime);
  const instruction = EXPORT_INSTRUCTION
    .replaceAll('<RAW_DIR>', rawDir)
    .replaceAll('<RUNNER_PATH>', runnerPath)
    .replaceAll('<STATUS_PATH>', statusPath)
    .replaceAll('<PLUGIN_ROOT>', pluginRoot)
    .replaceAll('<WORK_DIR>', workDir);

  const controller = new AbortController();
  runtime.exportController = controller;
  runtime.exportSessionId = null;
  runtime.pendingPermission = null;
  await store.saveState({
    phase: PHASE.EXPORTING,
    message: '正在准备导出：会弹出一个 QQ 空间浏览器窗口，全程只需要扫码登录一次',
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
        // 说清楚「现在处于什么状态」：有没有旧知识库，决定了后面那句话怎么写。
        const hadKb = Boolean(store.state.stats?.chunkCount);
        await store.saveState({
          phase: PHASE.IDLE,
          message: hadKb
            ? '导出流程已结束。知识库还是上一次的结果，点「重新构建知识库」用新数据重建。'
            : '导出流程已结束，点「构建知识库」把说说建成知识库。',
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
  await runtime.store.saveState({
    phase: PHASE.IDLE,
    message: '已请求停止导出（后台抓取若已启动会继续跑完；浏览器保持打开，登录态还在）',
  });
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
    refreshKbContext(runtime, merged, summaries, runtime.profile ? (runtime.profile.narrative || runtime.profile.facts) : '');
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
          const result = await runAgentTurn(
            context,
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
  const records = await runtime.store.readJsonl(runtime.store.unifiedPath);
  refreshKbContext(runtime, records, summaries, runtime.profile ? (runtime.profile.narrative || runtime.profile.facts) : '');
  runtime.index = buildIndex([...chunks, ...summaries, ...(runtime.profile ? [runtime.profile.chunk] : [])]);
  return runtime.index;
}

/**
 * 备好「全库速览」和「接地校验对照文本」。
 *
 * 两者都从全量记录算，不依赖检索——这是「对话灵活但不失真」的地基：
 *   - 全库速览：检索落空时把整个知识库摊给模型，泛化问也能答；
 *   - 对照文本：事实红线拿**整个知识库**当参照，
 *     模型提到库里真实存在、但这轮没检索到的内容时不会被误判成编造。
 */
function refreshKbContext(runtime, records, summaries, profileText) {
  runtime.summaries = summaries;
  runtime.kbDigest = buildKbDigest(records);
  runtime.kbDigestLines = runtime.kbDigest ? runtime.kbDigest.split('\n') : [];
  runtime.kbGroundText = buildGroundingText(records, summaries, profileText);
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

  // 检索只是**给模型找资料**，不再是「答不答得出来」的闸门。
  //
  // 早先的闸门是「检索不置信就直接回固定话术，连模型都不调」——
  // 问法一变（「我是个什么样的人」）就答不上，看起来像知识库里没有，其实是有。
  // 现在一律调模型：命中就喂明细，没命中就升级到全库速览，让模型自己判断。
  const hits = search(index, question, CHAT_TOP_K);
  const confident = isConfident(hits, question);
  const profile = runtime.profile ?? (await loadProfile(runtime));
  const profileText = profile ? (profile.narrative || profile.facts) : '';

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
    // 这次回答用了什么层级的资料，页面上要显示出来
    scope: confident ? 'retrieved' : 'full',
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
    // 这次回答用了哪一层资料：retrieved = 检索命中明细，full = 升级到全库速览
    scope: job.scope ?? 'retrieved',
    groundingRatio: job.groundingRatio ?? null,
  };
}

/** 后台跑模型回合：脱离 HTTP 请求的生命周期，宿主掐断请求也不会影响它。 */
async function runChatJob(runtime, job, hits, chunks, profileText) {
  const { store, context } = runtime;
  const question = job.question;

  const persona = store.state.persona || '';
  const kbText = chunks
    .map((chunk, index2) => `【相关说说 ${index2 + 1}】\n${chunk.text}`)
    .join('\n\n');

  /**
   * 分层喂资料。
   *
   * 日常：画像 + 年度小结 + 检索命中的明细（几 KB）。
   * 检索落空：再把**全库速览**摊上去（每条一行，日期 + 正文摘录），
   *   「我是个什么样的人」这种问法检索不到任何具体说说，但全库摆出来模型就能答。
   */
  const annualText = (runtime.summaries ?? [])
    .map((summary) => summary.text)
    .join('\n\n');
  const digest = runtime.kbDigest ?? '';
  const fullKb = job.scope === 'full' && digest
    ? `\n\n【全库速览】（${(runtime.kbDigestLines ?? []).length} 条，按时间倒序；正文未恢复的只标了痕迹）\n${digest}`
    : '';

  // 接地上下文：人设是用户自己写的，属于可信事实；
  // 事实红线的对照范围是**整个知识库**，不是本轮这几块——
  // 否则模型提到库里真实存在、但这轮没检索到的内容会被误判成编造。
  const groundingText = runtime.kbGroundText || [
    profileText,
    annualText,
    kbText,
    persona,
  ].filter(Boolean).join('\n\n');

  const prompt = [
    CHAT_SYSTEM,
    '',
    profileText ? `【你是谁】\n${profileText}\n` : '',
    persona ? `【人设】\n${persona}\n` : '',
    annualText ? `【年度小结】\n${annualText}\n` : '',
    '【相关说说】',
    kbText || '（本轮没有检索到具体说说，请依据「你是谁」「年度小结」「全库速览」回答）',
    fullKb,
    '',
    `【用户的问题】\n${question}`,
    '',
    '只依据上面的资料回答。资料里没有的信息不要编造；'
      + '如果资料不足以回答，就只输出一句：' + FALLBACK_ANSWER,
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
    result = await runAgentTurn(
      context,
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

  // 模型自己说「不知道」→ 固定话术。
  // 这一步交给模型，是因为它手里有全库资料：它说不知道，
  // 说明知识库里确实没有；比检索闸门瞎猜准得多。
  if (answer.includes(FALLBACK_ANSWER)) {
    job.status = 'done';
    job.grounded = false;
    job.answer = FALLBACK_ANSWER;
    job.reason = 'model_declined';
    job.sources = [];
    return;
  }

  // 事实红线：日期 / 数字 / 外文专名 / 引介人名必须能在**知识库里查到出处**。
  // 措辞重合度不再作为拒答条件——中文口语的虚词天然不重合，
  // 拿它当闸门会把有据可依的回答误杀成「不知道」。
  const ratio = groundingRatio(answer, groundingText);
  const factsOk = factualTokensGrounded(answer, groundingText);
  job.groundingRatio = Number(ratio.toFixed(3));
  if (!factsOk) {
    context.logger.info('miniapp.chat.grounding_rejected', { ratio: Number(ratio.toFixed(3)), reason: 'ungrounded_factual_claim' });
    job.status = 'done';
    job.grounded = false;
    job.answer = FALLBACK_ANSWER;
    job.reason = 'ungrounded_factual_claim';
    job.sources = hits.map((hit) => ({ id: hit.chunk.id, score: Number(hit.score.toFixed(3)) }));
    job.rejected = answer.slice(0, 300);
    return;
  }

  job.status = 'done';
  job.grounded = true;
  job.answer = answer;
  job.reason = '';
  job.sources = hits.map((hit) => ({
    id: hit.chunk.id,
    score: Number(hit.score.toFixed(3)),
    text: hit.chunk.text.slice(0, 240),
    year: hit.chunk.year,
  }));
}
