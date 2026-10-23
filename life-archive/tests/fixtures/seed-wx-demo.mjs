// 朋友圈演示数据种子（2.0）。
//
// 用法：
//   node tests/fixtures/seed-wx-demo.mjs --data-dir <MiniApp 的 dataDir>
//   node tests/fixtures/seed-wx-demo.mjs --data-dir <dir> --owner wxid_demo0001
//
// 写两样东西：
//   1. raw/wechat_sns.json —— **合成**的朋友圈导出，形状与 SIWX 的 JSON 导出一致
//   2. state.json 的 wx 段 —— 打开朋友圈数据源（默认是关的）
//
// 注意：这里全是**合成数据**，不是真实朋友圈记录。
// 真实导出请用外部解密工具（SIWX 等）或包内的 wx-export-runner.py，
// 产出的 JSON 放回 raw/wechat_sns.json 即可。
//
// 合成数据的 wxid 一律带 demo 标记，隐私回扫会放行；
// 真实 wxid 一旦混进包目录，回扫会直接判失败。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function parseArgs(argv) {
  const out = { dataDir: '', owner: 'wxid_demo0001' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data-dir') out.dataDir = argv[i + 1] ?? '';
    if (argv[i] === '--owner') out.owner = argv[i + 1] ?? out.owner;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.dataDir) {
  console.error('用法：node tests/fixtures/seed-wx-demo.mjs --data-dir <MiniApp 的 dataDir> [--owner wxid_demo0001]');
  process.exit(1);
}
const OWNER = args.owner;
const FRIEND = 'wxid_demo9999';

/** ISO → unix 秒。 */
const ts = (iso) => Math.floor(Date.parse(iso) / 1000);

/**
 * 动态 ID：snsId = (createTime_ms << 23) | random(23 bit)。
 * 跟真实朋友圈同构——插件侧要能正确还原有符号 int64。
 */
function snsId(iso, salt) {
  const ms = Date.parse(iso);
  const random = salt % (1 << 23);
  return String((BigInt(ms) << 23n) | BigInt(random));
}

const POSTS = [
  {
    id: snsId('2018-04-12T22:10:00Z', 0x1a2b3c),
    time: ts('2018-04-12T22:10:00Z'),
    text: '换了住处，阳台正对着一片工地，每天早上先听见钻机响。',
    kind: 1,
    location: null,
    media: [],
    likes: [{ name: '演示同学甲', username: 'wxid_demo8888' }],
    comments: [{ name: '演示同学乙', username: 'wxid_demo7777', text: '那边现在盖成什么样了' }],
  },
  {
    id: snsId('2018-09-03T21:40:00Z', 0x4d5e6f),
    time: ts('2018-09-03T21:40:00Z'),
    text: '第一次把作品投了出去，等了整两周没回音，后来才知道石沉大海。',
    kind: 2,
    location: null,
    media: [
      { url: 'https://mmbiz.qpic.cn/demo/a1', thumb: 'https://mmbiz.qpic.cn/demo/a1_t', md5: 'demo0000000000000000000000000000aa', width: 1080, height: 1440 },
      { url: 'https://mmbiz.qpic.cn/demo/a2', thumb: 'https://mmbiz.qpic.cn/demo/a2_t', md5: 'demo0000000000000000000000000000bb', width: 1080, height: 1080 },
    ],
    likes: [],
    comments: [{ name: '演示同学甲', username: 'wxid_demo8888', text: '恭喜' }],
  },
  {
    id: snsId('2019-01-18T12:30:00Z', 0x7a8b9c),
    time: ts('2019-01-18T12:30:00Z'),
    text: '',
    kind: 3,
    card: {
      kind: 'link',
      title: '一份关于旧城改造的公开资料',
      description: '整理了街区尺度的变化，配了很多实景照片。',
      url: 'https://example.com/demo/article',
      source: '演示公众号',
    },
    location: null,
    media: [],
    likes: [],
    comments: [],
  },
  {
    id: snsId('2019-07-07T19:05:00Z', 0x0d1e2f),
    time: ts('2019-07-07T19:05:00Z'),
    text: '去了趟旧城区的展馆，最喜欢第三层那些关于城市规划的手稿。',
    kind: 2,
    location: { name: '演示市旧城区展馆', address: '演示市演示区演示路 1 号' },
    media: [
      { url: 'https://mmbiz.qpic.cn/demo/b1', thumb: 'https://mmbiz.qpic.cn/demo/b1_t', md5: 'demo0000000000000000000000000000cc', width: 1200, height: 800 },
    ],
    likes: [{ name: '演示同学乙', username: 'wxid_demo7777' }],
    comments: [],
  },
  {
    id: snsId('2020-05-20T23:15:00Z', 0x3c4b5a),
    time: ts('2020-05-20T23:15:00Z'),
    text: '夜里的江边风很大，跑步的人比想象中多。',
    kind: 15,
    location: null,
    media: [
      { url: 'https://video.qq.com/demo/v1', thumb: 'https://mmbiz.qpic.cn/demo/v1_t', md5: 'demo0000000000000000000000000000dd', width: 720, height: 1280 },
    ],
    likes: [],
    comments: [],
  },
  {
    id: snsId('2021-03-11T08:40:00Z', 0x6e7f8a),
    time: ts('2021-03-11T08:40:00Z'),
    text: '',
    kind: 28,
    card: {
      kind: 'finder',
      title: '',
      description: '一条关于旧书店的短视频',
      finder: { nickname: '演示视频号' },
    },
    location: null,
    media: [],
    likes: [],
    comments: [],
  },
  {
    id: snsId('2021-11-26T20:50:00Z', 0x9b0c1d),
    time: ts('2021-11-26T20:50:00Z'),
    text: '',
    kind: 54,
    card: null,
    location: null,
    // 公众号文章的正文在 media 的 description 里——只取正文会得到一条空动态
    media: [
      {
        url: 'https://mmbiz.qpic.cn/demo/c1',
        thumb: 'https://mmbiz.qpic.cn/demo/c1_t',
        md5: 'demo0000000000000000000000000000ee',
        width: 900,
        height: 600,
        description: '这篇长文盘点了十年间手写笔记本的变迁，从纸质到电子，笔触其实一直没变。',
      },
    ],
    likes: [],
    comments: [],
  },
  {
    id: snsId('2022-06-14T21:00:00Z', 0x2e3f4a),
    time: ts('2022-06-14T21:00:00Z'),
    text: '',
    kind: 1,
    location: null,
    media: [],
    likes: [],
    comments: [],
  },
  // 好友发的：必须被「只取本人」过滤掉
  {
    id: snsId('2022-06-15T10:00:00Z', 0x5b6c7d),
    time: ts('2022-06-15T10:00:00Z'),
    author: FRIEND,
    text: '这条是好友发的，导入时必须被过滤掉。',
    kind: 1,
    location: null,
    media: [],
    likes: [],
    comments: [],
  },
].map((post) => ({
  tid: post.id,
  id: post.id,
  time: post.time,
  timeText: new Date(post.time * 1000).toISOString().replace('T', ' ').slice(0, 19),
  author: post.author ?? OWNER,
  text: post.text ?? '',
  kind: post.kind ?? 0,
  card: post.card ?? null,
  private: false,
  location: post.location ?? null,
  likes: post.likes ?? [],
  comments: post.comments ?? [],
  media: (post.media ?? []).map((media, index) => ({ index, type: 'image', ...media })),
}));

const mine = POSTS.filter((post) => post.author === OWNER);
const payload = {
  meta: {
    account: OWNER,
    exportedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    count: mine.length,
    format: 'json',
    source: 'demo',
    range: { start: mine[0].time, end: mine[mine.length - 1].time },
    stats: { rows_in_table: POSTS.length, kept: mine.length, not_mine: POSTS.length - mine.length, parse_failed: 0 },
  },
  posts: POSTS,
};

const rawDir = join(args.dataDir, 'raw');
await mkdir(rawDir, { recursive: true });
await writeFile(join(rawDir, 'wechat_sns.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

// 打开朋友圈数据源（默认是关的，演示数据要显式打开）
const statePath = join(args.dataDir, 'state.json');
let state = {};
try {
  state = JSON.parse(await readFile(statePath, 'utf8'));
} catch {
  state = {};
}
state.wx = {
  enabled: true,
  imported: true,
  count: mine.length,
  owner: OWNER,
  source: 'demo',
  importedAt: Date.now(),
};
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

// 演示数据标记：界面据此提示「这是合成数据」，避免和真实导出混淆
await writeFile(
  join(rawDir, 'demo.json'),
  `${JSON.stringify({
    kind: 'demo',
    ownerUin: state.ownerUin ?? '',
    wx: true,
    note: '合成演示数据，不是真实 QQ / 微信记录',
  }, null, 2)}\n`,
  'utf8',
);

console.log(`✅ 朋友圈演示数据已写入 ${rawDir}`);
console.log(`   wechat_sns.json — 共 ${POSTS.length} 条，其中本人 ${mine.length} 条、好友 ${POSTS.length - mine.length} 条`);
console.log(`   state.json — 已打开朋友圈数据源`);
console.log(`   演示用 wxid：${OWNER}`);
