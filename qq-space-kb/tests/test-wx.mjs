// 2.0 回归测试：微信朋友圈接入。
//
// 运行：node tests/test-wx.mjs
//
// 分五块：
//   [1] 1.0 逐字节回归锁 —— 同一份 QQ 空间输入，2.0 的输出必须与 1.7.1 **完全相同**
//   [2] 朋友圈解析层 —— 契约归一化、只取本人、卡片正文、媒体不下载
//   [3] 双源入库与画像 —— 合并不碰撞、口径切双源、朋友圈专属维度
//   [4] 取数工具端到端 —— 造一个假的已解密 sns.db，跑 wx-export-runner.py
//   [5] 服务端路由端到端 —— 真实 HTTP：导入 / 开关 / 重建 / 关闭后回到 1.0
//
// 所有数据都是合成的，不含任何真实身份信息。

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  buildChunks,
  buildGroundingText,
  buildIndex,
  buildKbDigest,
  buildProfile,
  buildYearSummaries,
  isWxRecord,
  mergeRecords,
  search,
  WX_ID_PREFIX,
} from '../miniapp/node/kb.mjs';

import {
  composeWxContent,
  countBySource,
  normalizeWxPayload,
  parseWechatSns,
  stripDeviceSuffix,
} from '../miniapp/node/wxsns.mjs';

import { sampleQzoneRecords } from './fixtures/qzone-sample.mjs';

const execFileAsync = promisify(execFile);
const HERE = join(import.meta.dirname, '..');

let passed = 0;
let failed = 0;
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

/** 异步版本的 check（要读文件、跑子进程的那种）。 */
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name} — ${error.message}`);
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 测试数据（全部合成）
// ---------------------------------------------------------------------------
const WX_OWNER = 'wxid_demo0001';
const WX_FRIEND = 'wxid_demo9999';

const ts = (iso) => Math.floor(Date.parse(iso) / 1000);

const WX_PAYLOAD = {
  meta: { account: WX_OWNER, count: 4, format: 'json', source: 'test' },
  posts: [
    {
      id: '1001',
      time: ts('2018-04-12T22:10:00Z'),
      author: WX_OWNER,
      text: '换了住处，阳台正对着一片工地。',
      kind: 1,
      location: null,
      media: [],
      likes: [{ name: '演示同学甲', username: 'wxid_demo8888' }],
      comments: [{ name: '演示同学乙', username: 'wxid_demo7777', text: '那边现在什么样了' }],
    },
    {
      id: '1002',
      time: ts('2019-01-18T12:30:00Z'),
      author: WX_OWNER,
      text: '',
      kind: 3,
      card: {
        kind: 'link',
        title: '一份旧城改造的公开资料',
        description: '整理了街区尺度的变化。',
        url: 'https://example.com/demo/article',
        source: '演示公众号',
      },
      location: null,
      media: [],
      likes: [],
      comments: [],
    },
    {
      id: '1003',
      time: ts('2020-05-20T23:15:00Z'),
      author: WX_OWNER,
      text: '夜里的江边风很大。',
      kind: 15,
      location: { name: '演示市旧城区展馆', address: '演示市演示路 1 号' },
      media: [
        { type: 'video', url: 'https://video.qq.com/demo/v1', thumb: 'https://mmbiz.qpic.cn/demo/v1_t', md5: 'demov1', width: 720, height: 1280 },
        { type: 'image', url: 'https://mmbiz.qpic.cn/demo/m1', thumb: 'https://mmbiz.qpic.cn/demo/m1_t', md5: 'demom1', width: 1080, height: 1440 },
      ],
      likes: [],
      comments: [],
    },
    {
      id: '1004',
      time: ts('2021-11-26T20:50:00Z'),
      author: WX_OWNER,
      text: '',
      kind: 54,
      location: null,
      media: [
        {
          type: 'image',
          url: 'https://mmbiz.qpic.cn/demo/c1',
          thumb: 'https://mmbiz.qpic.cn/demo/c1_t',
          md5: 'democ1',
          width: 900,
          height: 600,
          description: '这篇长文盘点了十年间手写笔记本的变迁。',
        },
      ],
      likes: [],
      comments: [],
    },
    {
      id: '2001',
      time: ts('2022-06-15T10:00:00Z'),
      author: WX_FRIEND,
      text: '好友发的，必须被过滤。',
      kind: 1,
      location: null,
      media: [],
      likes: [],
      comments: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// [1] 1.0 逐字节回归锁
// ---------------------------------------------------------------------------
console.log('\n[1] 1.0 逐字节回归锁（同一份输入，输出必须与 1.7.1 完全相同）');

const golden = JSON.parse(await readFile(join(HERE, 'tests/fixtures/golden-qzone-1.0.json'), 'utf8'));
const qqRecords = mergeRecords(sampleQzoneRecords());
const qqSummaries = buildYearSummaries(qqRecords);
const qqProfile = buildProfile(qqRecords, qqSummaries);
const qqChunks = buildChunks(qqRecords);

check('画像 facts 与 1.7.1 逐字节一致', () => {
  assert.equal(qqProfile.facts, golden.profileFacts);
});
check('画像全文与 1.7.1 逐字节一致', () => {
  assert.equal(qqProfile.text, golden.profileText);
});
check('年度小结与 1.7.1 逐字节一致', () => {
  assert.deepEqual(
    qqSummaries.map((s) => ({ id: s.id, year: s.year, count: s.count, text: s.text })),
    golden.summaries,
  );
});
check('知识块与 1.7.1 逐字节一致', () => {
  assert.deepEqual(qqChunks.map((c) => ({ id: c.id, text: c.text })), golden.chunks);
});
check('全库速览与 1.7.1 逐字节一致', () => {
  assert.equal(buildKbDigest(qqRecords), golden.digest);
});
check('接地文本与 1.7.1 逐字节一致', () => {
  assert.equal(buildGroundingText(qqRecords, qqSummaries, qqProfile.facts), golden.grounding);
});
check('纯 QQ 空间时口径仍是「条说说」', () => {
  assert.ok(qqProfile.facts.includes('条说说'));
  assert.ok(!qqProfile.facts.includes('条动态'));
  assert.ok(!qqProfile.facts.includes('朋友圈'));
});
check('纯 QQ 空间时知识块不带朋友圈来源标记', () => {
  assert.ok(!qqChunks.some((c) => c.text.includes('微信朋友圈')));
});

// ---------------------------------------------------------------------------
// [2] 朋友圈解析层
// ---------------------------------------------------------------------------
console.log('\n[2] 朋友圈解析层');

const parsed = parseWechatSns(WX_PAYLOAD, {});

check('SIWX 形状能解析出本人动态', () => {
  assert.equal(parsed.stats.total, 5);
  assert.equal(parsed.stats.kept, 4);
  assert.equal(parsed.stats.notMine, 1);
});
check('好友发的被过滤掉', () => {
  assert.ok(!parsed.records.some((r) => r.content.includes('好友发的')));
});
check('记录 ID 带 wx- 前缀', () => {
  assert.ok(parsed.records.every((r) => r.id.startsWith(WX_ID_PREFIX)));
  assert.ok(parsed.records.every((r) => isWxRecord(r)));
});
check('记录来源标记为 wechat-sns', () => {
  assert.ok(parsed.records.every((r) => r.sources.includes('wechat-sns')));
});
check('发布时间正确', () => {
  const first = parsed.records[0];
  assert.equal(first.published_at, ts('2018-04-12T22:10:00Z'));
  assert.equal(first.time_source, 'exact');
});
check('位置被提取', () => {
  const withLoc = parsed.records.find((r) => r.id === 'wx-1003');
  assert.equal(withLoc.location, '演示市旧城区展馆');
});
check('赞与评论分开计数', () => {
  const first = parsed.records[0];
  assert.equal(first.like_count, 1);
  assert.equal(first.comment_count, 1);
  assert.equal(first.comments[0].nick, '演示同学乙');
  assert.equal(first.like_users[0].nick, '演示同学甲');
});
check('链接卡片的标题摘要进正文', () => {
  const link = parsed.records.find((r) => r.id === 'wx-1002');
  assert.ok(link.content.includes('旧城改造'));
  assert.ok(link.content.includes('街区尺度'));
  assert.equal(link.post_url, 'https://example.com/demo/article');
});
check('公众号文章正文在 media.description 里，也被收进来', () => {
  const article = parsed.records.find((r) => r.id === 'wx-1004');
  assert.ok(article.content.includes('手写笔记本'));
});
check('视频与图片分开放，只存链接不下载', () => {
  const media = parsed.records.find((r) => r.id === 'wx-1003');
  assert.equal(media.videos.length, 1);
  assert.equal(media.images.length, 1);
  assert.equal(media.videos[0].url, 'https://video.qq.com/demo/v1');
  // 只存链接与描述：不该有本地路径
  assert.ok(!JSON.stringify(media).includes('/Users/'));
});
check('没有正文也没有媒体时给事实性描述', () => {
  const bare = { ...WX_PAYLOAD, posts: [{ id: 'wx-3001', time: ts('2020-01-01T00:00:00Z'), author: WX_OWNER, text: '', kind: 1 }] };
  const r = parseWechatSns(bare, {}).records[0];
  assert.ok(r.content.includes('朋友圈'));
});

check('设备后缀被剥掉', () => {
  assert.equal(stripDeviceSuffix('wxid_demo0001_4160'), 'wxid_demo0001');
  assert.equal(stripDeviceSuffix('wxid_demo0001'), 'wxid_demo0001');
});
check('带设备后缀的账号目录名也能匹配上本人', () => {
  const payload = {
    meta: { account: `${WX_OWNER}_4160` },
    posts: [{ id: 'wx-4001', time: ts('2020-01-01T00:00:00Z'), author: WX_OWNER, text: '正文' }],
  };
  const result = parseWechatSns(payload, {});
  assert.equal(result.stats.kept, 1);
  assert.equal(result.stats.owner, WX_OWNER);
});
check('毫秒时间戳自动折算成秒', () => {
  const ms = Date.parse('2020-01-01T00:00:00Z');
  const payload = { meta: { account: WX_OWNER }, posts: [{ id: 'wx-5001', time: ms, author: WX_OWNER, text: '正文' }] };
  assert.equal(parseWechatSns(payload, {}).records[0].published_at, Math.floor(ms / 1000));
});
check('负数 tid 还原成无符号 ID', () => {
  const payload = { meta: { account: WX_OWNER }, posts: [{ id: '-1', time: ts('2020-01-01T00:00:00Z'), author: WX_OWNER, text: '正文' }] };
  const record = parseWechatSns(payload, {}).records[0];
  assert.equal(record.id, `${WX_ID_PREFIX}18446744073709551615`);
});
check('字段名变体也能解析（time/create_time、text/content、name/nickname）', () => {
  const payload = {
    owner_wxid: WX_OWNER,
    moments: [{
      tid: '6001',
      create_time: ts('2020-01-01T00:00:00Z'),
      username: WX_OWNER,
      content: '变体字段的正文',
      likes: [{ username: 'wxid_demo8888', nickname: '演示同学甲' }],
      comments: [{ username: 'wxid_demo7777', nickname: '演示同学乙', content: '变体评论' }],
    }],
  };
  const result = parseWechatSns(payload, {});
  assert.equal(result.stats.kept, 1);
  assert.equal(result.records[0].content, '变体字段的正文');
  assert.equal(result.records[0].comments[0].nick, '演示同学乙');
});
check('归一化器接受 posts 与 moments 两种数组键', () => {
  assert.equal(normalizeWxPayload({ posts: [] }).posts.length, 0);
  assert.equal(normalizeWxPayload({ moments: [{ id: '1' }] }).posts.length, 1);
});
check('正文合成把卡片字段都串起来', () => {
  const composed = composeWxContent({
    text: '正文',
    card: { kind: 'music', title: '歌名', description: '描述', source: '', music: { singer: '歌手', album: '专辑' } },
    media: [{ description: '媒体描述', title: '' }],
  });
  assert.ok(composed.includes('正文'));
  assert.ok(composed.includes('歌名'));
  assert.ok(composed.includes('歌手'));
  assert.ok(composed.includes('媒体描述'));
});
check('没有 owner 时一条都不入库（宁可没有也不放错人）', () => {
  const payload = { posts: [{ id: 'wx-6001', time: ts('2020-01-01T00:00:00Z'), author: WX_OWNER, text: '正文' }] };
  const result = parseWechatSns(payload, {});
  assert.equal(result.stats.kept, 0);
  assert.equal(result.stats.notMine, 1);
});

// ---------------------------------------------------------------------------
// [3] 双源入库与画像
// ---------------------------------------------------------------------------
console.log('\n[3] 双源入库与画像');

const wxRecords = parsed.records;
const dual = mergeRecords([...qqRecords, ...wxRecords]);

check('合并后 QQ 与朋友圈记录都在', () => {
  assert.equal(dual.length, qqRecords.length + wxRecords.length);
});
check('两个来源的 ID 不碰撞', () => {
  const ids = new Set(dual.map((r) => r.id));
  assert.equal(ids.size, dual.length);
});
check('来源分布能数出来', () => {
  const counts = countBySource(dual);
  assert.equal(counts['wechat-sns'], wxRecords.length);
  assert.ok(counts['qzoneexport'] > 0);
});
check('朋友圈记录也进知识块，并标明来源', () => {
  const chunks = buildChunks(dual);
  const wxChunk = chunks.find((c) => c.id.startsWith(WX_ID_PREFIX));
  assert.ok(wxChunk);
  assert.ok(wxChunk.text.includes('[来源] 微信朋友圈'));
});
check('检索能命中朋友圈的内容', () => {
  const chunks = buildChunks(dual);
  const index = buildIndex(chunks);
  const hits = search(index, '阳台 工地', 3);
  assert.ok(hits.length > 0);
});

const dualProfile = buildProfile(dual, buildYearSummaries(dual));

check('双源时画像口径切到「条动态」并拆来源', () => {
  assert.ok(dualProfile.facts.includes('条动态'));
  assert.ok(dualProfile.facts.includes('微信朋友圈'));
  assert.ok(dualProfile.facts.includes('QQ 空间'));
});
check('朋友圈专属维度：发圈节奏 / 发布时段 / 媒体偏好 / 内容类型', () => {
  assert.ok(dualProfile.facts.includes('[朋友圈·发圈节奏]'));
  assert.ok(dualProfile.facts.includes('[朋友圈·发布时段]'));
  assert.ok(dualProfile.facts.includes('[朋友圈·媒体偏好]'));
  assert.ok(dualProfile.facts.includes('[朋友圈·内容类型]'));
});
check('朋友圈专属维度：常出现的位置 / 互动最多的人', () => {
  assert.ok(dualProfile.facts.includes('[朋友圈·常出现的位置]'));
  assert.ok(dualProfile.facts.includes('[朋友圈·互动最多的人]'));
});
check('双平台表达差被算出来', () => {
  assert.ok(dualProfile.facts.includes('[两个平台的表达差]'));
  assert.ok(dualProfile.facts.includes('朋友圈平均'));
  assert.ok(dualProfile.facts.includes('QQ 空间平均'));
});
check('年度小结在混源时说「条动态」并拆来源', () => {
  const summaries = buildYearSummaries(dual);
  const mixed = summaries.find((s) => s.text.includes('条动态'));
  assert.ok(mixed);
  assert.ok(mixed.text.includes('QQ 空间'));
  assert.ok(mixed.text.includes('微信朋友圈'));
});
check('纯 QQ 空间那一年的小结仍是 1.0 原话', () => {
  const summaries = buildYearSummaries(dual);
  const qqOnly = summaries.filter((s) => s.text.includes('条说说'));
  assert.ok(qqOnly.length > 0);
});

// ---------------------------------------------------------------------------
// [4] 取数工具端到端
// ---------------------------------------------------------------------------
console.log('\n[4] 取数工具端到端（wx-export-runner.py）');

const runnerDir = await mkdtemp(join(tmpdir(), 'wx-runner-'));
const accountDir = join(runnerDir, 'demoacct_4160', 'db_storage', 'sns');
await mkdir(accountDir, { recursive: true });
const fakeDb = join(accountDir, 'sns.db');
const runnerOut = join(runnerDir, 'wechat_sns.json');

const TIMELINE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<SnsDataItem>
  <TimelineObject>
    <id>1234567890123456789</id>
    <username>${WX_OWNER}</username>
    <createTime>1541405100</createTime>
    <contentDesc>取数工具端到端用的合成正文。</contentDesc>
    <ContentObject>
      <type>1</type>
      <mediaList>
        <media>
          <url>https://mmbiz.qpic.cn/demo/e2e1</url>
          <size width="1080" height="1440"/>
          <thumb>https://mmbiz.qpic.cn/demo/e2e1_t</thumb>
        </media>
      </mediaList>
    </ContentObject>
    <private>0</private>
  </TimelineObject>
  <LocalExtraInfo>
    <like_user_list>
      <user_comment><username>wxid_demo8888</username><nickname>演示同学甲</nickname><content></content><type>1</type><create_time>1541405200</create_time></user_comment>
    </like_user_list>
    <comment_user_list>
      <user_comment><username>wxid_demo7777</username><nickname>演示同学乙</nickname><content>端到端评论</content><type>2</type><create_time>1541405300</create_time></user_comment>
    </comment_user_list>
  </LocalExtraInfo>
</SnsDataItem>`;

await execFileAsync('python3', ['-c', `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content BLOB)")
conn.execute("INSERT INTO SnsTimeLine VALUES (?, ?, ?)", (1234567890123456789, "${WX_OWNER}", """${TIMELINE_XML}"""))
conn.commit()
conn.close()
`, fakeDb]);

// discover 扫的是「当前目录下的 output/*/sns/sns.db」，所以在这儿再放一份
await mkdir(join(runnerDir, 'output', 'demoacct', 'sns'), { recursive: true });
await writeFile(join(runnerDir, 'output', 'demoacct', 'sns', 'sns.db'), await readFile(fakeDb));

await checkAsync('wx-export-runner.py 能把已解密的库导成 JSON', async () => {
  const { stdout } = await execFileAsync('python3', [
    join(HERE, 'miniapp/node/wx-export-runner.py'),
    'parse', '--db', fakeDb, '--owner', WX_OWNER, '--out', runnerOut,
  ]);
  assert.ok(stdout.includes('导出'));
  const payload = JSON.parse(await readFile(runnerOut, 'utf8'));
  assert.ok(Array.isArray(payload.posts));
  assert.equal(payload.meta.account, WX_OWNER);
  assert.equal(payload.posts.length, 1);
});

await checkAsync('工具产出的 JSON 正好是插件认得的契约（端到端能入库）', async () => {
  const payload = JSON.parse(await readFile(runnerOut, 'utf8'));
  const result = parseWechatSns(payload, {});
  assert.equal(result.stats.kept, 1);
  assert.equal(result.stats.notMine, 0);
  const record = result.records[0];
  assert.ok(record.content.includes('端到端'));
  assert.equal(record.images.length, 1);
  assert.equal(record.comments[0].nick, '演示同学乙');
  assert.equal(record.like_users[0].nick, '演示同学甲');
});

await checkAsync('加密库被明确拒绝，并给出下一步指引', async () => {
  const encrypted = join(runnerDir, 'encrypted.db');
  await writeFile(encrypted, Buffer.alloc(64, 0x5a));
  await assert.rejects(
    () => execFileAsync('python3', [
      join(HERE, 'miniapp/node/wx-export-runner.py'),
      'parse', '--db', encrypted, '--owner', WX_OWNER, '--out', join(runnerDir, 'x.json'),
    ]),
    (error) => {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      assert.ok(output.includes('加密') || output.includes('解密'));
      return true;
    },
  );
});

await checkAsync('discover 能列出候选库并标注是否已解密', async () => {
  const { stdout } = await execFileAsync('python3', [
    join(HERE, 'miniapp/node/wx-export-runner.py'), 'discover', '--json',
  ], { cwd: runnerDir });
  const items = JSON.parse(stdout);
  assert.ok(Array.isArray(items));
  assert.ok(items.some((item) => item.path.endsWith('sns.db') && item.decrypted === true));
});

// ---------------------------------------------------------------------------
// [5] 服务端路由端到端
// ---------------------------------------------------------------------------
console.log('\n[5] 服务端路由端到端（真实 HTTP）');

const dataDir = await mkdtemp(join(tmpdir(), 'qq-kb-wx-test-'));
await mkdir(join(dataDir, 'raw'), { recursive: true });

const QQ_OWNER = '1927686067';
function moodId(tsValue, suffix) {
  const le = (n) => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(n >>> 0);
    return buf.toString('hex');
  };
  return le(Number(QQ_OWNER)) + le(tsValue) + suffix;
}
const QQ_TS = 1426300800;
await writeFile(join(dataDir, 'raw', 'qzoneexport_messages.json'), JSON.stringify([{
  tid: moodId(QQ_TS, 'aaaa1111'),
  custom_content: 'QQ 空间里的一条合成说说，用来验证双源合并。',
  created_time: QQ_TS,
  custom_create_time: '2015-03-14 23:28',
  commentlist: [{ content: '合成评论', nick: '演示同学甲', createTime: QQ_TS + 60 }],
  likeTotal: 4,
  likes: [{ fuin: 10001, nick: '演示同学乙' }],
  lbs: { address: '演示市演示区', name: '演示地点' },
  pic: [],
}]), 'utf8');

const mockAgent = {
  async run() { return { sessionId: 'mock', status: 'finished', text: '合成回答' }; },
  async reply() {},
};

const { start } = await import('../miniapp/node/server.mjs');
const probe = createNetServer();
const port = await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const assigned = probe.address().port;
    probe.close(() => resolve(assigned));
  });
});

const lifecycle = await start({
  pluginRoot: HERE,
  dataDir,
  listen: { host: '127.0.0.1', port },
  signal: new AbortController().signal,
  logger: { info() {}, error() {} },
  agent: mockAgent,
});
const base = `http://127.0.0.1:${port}`;

async function call(path, options) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  return res.json();
}

try {
  const status0 = await call('/api/wx/status');
  check('朋友圈数据源默认是关的', () => {
    assert.equal(status0.enabled, false);
    assert.equal(status0.imported, false);
  });

  const importRes = await call('/api/wx/import', {
    method: 'POST',
    body: JSON.stringify({ payload: WX_PAYLOAD }),
  });
  check('导入朋友圈数据成功', () => {
    assert.equal(importRes.ok, true);
    assert.equal(importRes.count, 4);
    assert.equal(importRes.notMine, 1);
    assert.equal(importRes.needRebuild, true);
  });

  await checkAsync('导入后原始数据落在 raw/wechat_sns.json', async () => {
    const raw = JSON.parse(await readFile(join(dataDir, 'raw', 'wechat_sns.json'), 'utf8'));
    assert.equal(raw.posts.length, 5);
  });

  const build1 = await call('/api/kb/build', { method: 'POST', body: JSON.stringify({}) });
  check('重建后知识库里两个来源都有', () => {
    assert.equal(build1.ok, true);
    assert.equal(build1.stats.bySource['qzoneexport'], 1);
    assert.equal(build1.stats.bySource['wechat-sns'], 4);
    assert.equal(build1.stats.totalRecords, 5);
  });

  const profileRes = await call('/api/profile');
  check('画像已经是双源口径', () => {
    assert.equal(profileRes.ok, true);
    assert.ok(profileRes.facts.includes('条动态'));
    assert.ok(profileRes.facts.includes('[朋友圈·发圈节奏]'));
  });

  const searchRes = await call('/api/search?q=' + encodeURIComponent('阳台 工地'));
  check('对话侧能检索到朋友圈内容', () => {
    assert.ok(searchRes.hits.length > 0);
    assert.ok(searchRes.hits.some((h) => h.id.startsWith(WX_ID_PREFIX)));
  });

  const stateRes = await call('/api/state');
  check('状态里能看到朋友圈数据源', () => {
    assert.equal(stateRes.wx.enabled, true);
    assert.equal(stateRes.wx.count, 4);
  });

  // 关闭朋友圈 → 重建 → 必须回到纯 1.0 的口径
  const switchRes = await call('/api/wx/switch', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  check('朋友圈开关可以关掉', () => {
    assert.equal(switchRes.ok, true);
    assert.equal(switchRes.enabled, false);
  });

  const build2 = await call('/api/kb/build', { method: 'POST', body: JSON.stringify({}) });
  check('关掉后重建回到纯 QQ 空间', () => {
    assert.equal(build2.ok, true);
    assert.equal(build2.stats.totalRecords, 1);
    assert.equal(build2.stats.bySource['wechat-sns'], undefined);
  });

  const profileRes2 = await call('/api/profile');
  check('关掉后画像口径回到「条说说」', () => {
    assert.ok(profileRes2.facts.includes('条说说'));
    assert.ok(!profileRes2.facts.includes('朋友圈'));
  });

  const clearRes = await call('/api/wx/clear', { method: 'POST', body: JSON.stringify({}) });
  check('可以清掉朋友圈原始数据', () => {
    assert.equal(clearRes.ok, true);
  });
  await assert.rejects(() => readFile(join(dataDir, 'raw', 'wechat_sns.json'), 'utf8'));

  const importBad = await call('/api/wx/import', {
    method: 'POST',
    body: JSON.stringify({ payload: { posts: [{ id: 'x', author: WX_FRIEND, text: '别人的' }], meta: { account: WX_OWNER } } }),
  });
  check('作者对不上时如实报错，不假装导入成功', () => {
    assert.equal(importBad.ok, false);
    assert.ok(importBad.message.includes('没有一条是本人发的'));
  });

  const page = await (await fetch(`${base}/dashboard`)).text();
  check('页面上有朋友圈面板（状态 / 导入 / 开关 / 清空）', () => {
    assert.ok(page.includes('微信朋友圈'));
    assert.ok(page.includes('btn-wx-import'));
    assert.ok(page.includes('btn-wx-toggle'));
    assert.ok(page.includes('btn-wx-clear'));
    assert.ok(page.includes('wx-dir'));
  });
  check('页面上没有 emoji 装饰', () => {
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(page));
  });
} finally {
  await lifecycle.dispose();
  await rm(dataDir, { recursive: true, force: true });
  await rm(runnerDir, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(56));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('\n失败明细：');
  for (const item of failures) console.log(`  ❌ ${item}`);
  process.exit(1);
}
console.log('✅ 全部通过');
