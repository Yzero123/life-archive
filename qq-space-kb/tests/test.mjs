// 本地回归测试：用 mock Agent 启动真实 Node 服务，走真实 HTTP 路由。
// 重点验证「知识库没有就不猜」这条硬规则。
//
// 运行：node tests/test.mjs

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, utimes } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildChunks,
  buildIndex,
  buildProfile,
  buildYearSummaries,
  emptyRecord,
  factualTokensGrounded,
  formatTimestamp,
  groundingRatio,
  isConfident,
  isRecoverTrace,
  isSelfCharacterQuestion,
  mergeRecords,
  moodCellIdOwnerUin,
  moodCellIdPublishedAt,
  normalizeQuery,
  parseQzoneArchive,
  parseQzoneExport,
  sanitizeNarrative,
  search,
} from '../miniapp/node/kb.mjs';

const FALLBACK = '当时的我还不知道这是什么意思';

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

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------
const OWNER = '1927686067';

function moodId(ownerUin, ts, suffix) {
  const le = (n) => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(n >>> 0);
    return buf.toString('hex');
  };
  return le(Number(ownerUin)) + le(ts) + suffix;
}

const TS_2015 = 1426351680; // 2015-03-14
const TS_2018 = 1532532194; // 2018-07-25

const MESSAGES_JSON = [
  {
    tid: moodId(OWNER, TS_2015, 'aaaa1111'),
    custom_content: '今天把 QQ 空间历史说说整理成离线网页了，注册用户到了一万，翻旧内容终于不再费劲。',
    created_time: TS_2015,
    custom_create_time: '2015-03-14 23:28',
    commentlist: [
      { content: '牛啊', nick: '小明', createTime: '2015年03月15日' },
      { content: '静安寺那边确实挺远的', nick: '小红', createTime: TS_2015 + 3600 },
    ],
    likeTotal: 18,
    likes: [{ fuin: 10001, nick: '小刚' }],
    lbs: { address: '上海市静安区', name: '静安寺' },
    pic: [{ hd_url: 'https://photo.example.com/a1.jpg' }],
    post_url: `https://user.qzone.qq.com/${OWNER}/mood/x`,
  },
  {
    tid: moodId(OWNER, TS_2018, 'bbbb2222'),
    custom_content: '换了新工作，搬到南京西路了。',
    created_time: TS_2018,
    commentlist: [],
    likeTotal: 3,
    likes: [],
    lbs: { address: '上海市静安区', name: '南京西路' },
    pic: [],
  },
  {
    tid: 'no-time-record',
    custom_content: '这条没有绝对时间戳。',
    created_time: 0,
    commentlist: [],
    likeTotal: 0,
  },
];

const ARCHIVE_JSON = {
  dynamics: [
    {
      cell_id: moodId(OWNER, TS_2015, 'aaaa1111'),
      published_at: TS_2015,
      content: '今天把 QQ 空间历史说说整理成离线网页了，翻旧内容终于不再费劲。',
      category: 'self',
      is_history_residue: false,
    },
    {
      cell_id: 'history-v2:' + 'a'.repeat(32),
      published_at: TS_2018,
      content: '那年冬天在南方过了第一个春节。',
      category: 'self',
      is_history_residue: true,
    },
  ],
  feeds: [
    {
      cell_id: 'history-v2:' + 'a'.repeat(32),
      event_type: 2,
      event_time: TS_2018 + 100,
      actor_name: '好友丙',
      comments_json: JSON.stringify({
        main_comment: { commentid: 'c3', user: { uin: '20003', nickname: '好友丙' }, content: '新年快乐', date: TS_2018 + 100 },
      }),
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. 单元层
// ---------------------------------------------------------------------------
console.log('\n[1] 领域核心');

check('说说 ID 正确反解发布时间', () => {
  // 用合成 ID：前 8 位小端 u32 是作者 QQ 号，后 8 位是发布时间戳
  const cellId = moodId(OWNER, TS_2018, 'aabb1122');
  assert.equal(moodCellIdPublishedAt(cellId, OWNER, TS_2018 + 100), TS_2018);
});
check('QQ 号不匹配时拒绝', () => {
  const cellId = moodId(OWNER, TS_2018, 'aabb1122');
  assert.equal(moodCellIdPublishedAt(cellId, '1927686068', TS_2018 + 100), null);
});
check('非法 ID 不抛异常', () => {
  assert.equal(moodCellIdPublishedAt('zzzzzzzzzzzzzzzz', '1927686067', 0), null);
  assert.equal(moodCellIdPublishedAt('', '1927686067', 0), null);
});

const qzeRecords = parseQzoneExport(MESSAGES_JSON);
const archiveRecords = parseQzoneArchive(ARCHIVE_JSON, OWNER);
const merged = mergeRecords([...qzeRecords, ...archiveRecords]);

check('QZoneExport 解析出 3 条', () => assert.equal(qzeRecords.length, 3));
check('归档库解析出 2 条', () => assert.equal(archiveRecords.length, 2));
check('合并后 4 条唯一记录', () => assert.equal(merged.length, 4));
check('两源命中的同一条被合并', () => {
  const both = merged.filter((r) => r.sources.length > 1);
  assert.equal(both.length, 1);
  assert.equal(both[0].like_count, 18);
});
check('已删除恢复内容被标记', () => {
  const recovered = merged.filter((r) => r.recovered);
  assert.equal(recovered.length, 1);
  assert.ok(recovered[0].id.startsWith('history-v2:'));
});
check('无时间戳记录标记为 unknown', () => {
  const unknown = merged.filter((r) => !r.published_at);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].time_source, 'unknown');
});

// ---------------------------------------------------------------------------
// 1b. 无正文的回溯记录
//
// 已删除的说说在互动卡片里常常抽不到正文预览。只要有 cell_id，发布时间就能
// 反解出来，「发过、什么时候发、被谁互动过」本身是真实知识。
// 早期版本在合并和成块两处都按「有没有正文」过滤，导致 recovered 永远是 0。
// ---------------------------------------------------------------------------
console.log('\n[1b] 无正文的回溯记录');

const MISSING_CELL = moodId(OWNER, TS_2015, 'cccc3333');
const ARCHIVE_BODY_MISSING = {
  dynamics: [
    {
      cell_id: MISSING_CELL,
      published_at: TS_2015,
      content: '',
      category: 'self',
      is_history_residue: true,
    },
  ],
  feeds: [
    {
      cell_id: MISSING_CELL,
      event_type: 217,
      event_time: TS_2015 + 500,
      actor_name: '好友丁',
    },
  ],
};

const missingRecords = parseQzoneArchive(ARCHIVE_BODY_MISSING, OWNER);
const missingMerged = mergeRecords(missingRecords);
const missingChunks = buildChunks(missingMerged);
const missingSummaries = buildYearSummaries(missingMerged);

check('无正文回溯记录仍被解析出来', () => assert.equal(missingRecords.length, 1));
check('解析出 body_missing 标记', () => assert.equal(missingRecords[0].body_missing, true));
check('有正文的记录 body_missing 为 false', () => {
  const withBody = parseQzoneArchive(ARCHIVE_JSON, OWNER);
  assert.equal(withBody.find((r) => r.content)?.body_missing, false);
});
check('合并时不丢弃无正文的回溯记录', () => assert.equal(missingMerged.length, 1));
check('isRecoverTrace 认它', () => assert.equal(isRecoverTrace(missingMerged[0]), true));
check('isRecoverTrace 拒绝普通空记录', () => {
  assert.equal(isRecoverTrace(emptyRecord()), false);
});
check('成块后写明正文未能恢复', () => {
  assert.equal(missingChunks.length, 1);
  assert.ok(missingChunks[0].text.includes('正文未能恢复'));
  assert.equal(missingChunks[0].recovered, true);
  assert.equal(missingChunks[0].body_missing, true);
});
check('正文没恢复，但发布时间仍然查得到', () => {
  assert.ok(missingChunks[0].text.includes('2015'));
  assert.equal(missingChunks[0].published_at, TS_2015);
});
check('互动痕迹也保留下来', () => {
  assert.equal(missingChunks[0].like_count, 1);
  assert.ok(missingChunks[0].text.includes('1个赞'));
});
check('年度摘要说明有正文未能恢复', () => {
  assert.equal(missingSummaries.length, 1);
  assert.ok(missingSummaries[0].text.includes('正文未能恢复'));
});
check('既无正文又无任何可定位信息的回溯记录要被丢掉', () => {
  const orphan = mergeRecords([{ ...emptyRecord(), recovered: true, body_missing: true }]);
  assert.equal(orphan.length, 0);
});

// ---------------------------------------------------------------------------
// 1c. 谁发的
//
// 互动卡片里混着「我评论过的别人的动态」。这类内容本来就不在「我的说说列表」里，
// 所以「历史消息有、说说列表没有」这个差集不能直接当成「我已删除的说说」。
// 收进来的话，bot 会声称自己发过根本没发过的内容——比漏一条严重得多。
// ---------------------------------------------------------------------------
console.log('\n[1c] 作者归属');

// ⚠️ 这里的 ID、QQ 号、内容**全部是合成的**。
// 用真实账号的 cell_id / 说说正文 / 好友昵称来写测试，等于把个人信息塞进分发包。
const OTHER_OWNER = '1827366067';
const OWNER_PADDED = '01927686067'; // 同一个号，带前导 0
const MY_CELL = moodId(OWNER, TS_2018, 'aaaa1111');          // 作者 = OWNER
const OTHER_CELL = moodId(OTHER_OWNER, TS_2018, 'bbbb2222'); // 作者 = 别人

check('能从 cell_id 反解作者 QQ 号', () => {
  assert.equal(moodCellIdOwnerUin(MY_CELL), Number(OWNER));
  assert.equal(moodCellIdOwnerUin(OTHER_CELL), Number(OTHER_OWNER));
  assert.equal(moodCellIdOwnerUin('history-v2:' + 'a'.repeat(32)), 0);
  assert.equal(moodCellIdOwnerUin(''), 0);
});
check('别人的动态不当作「我的说说」收进来', () => {
  const other = parseQzoneArchive({
    dynamics: [{
      cell_id: OTHER_CELL,
      published_at: TS_2018,
      content: '这是别人发的一条动态，我只是评论过它。',
      category: 'self',
      is_history_residue: true,
    }],
    feeds: [],
  }, OWNER);
  assert.equal(other.length, 0);
});
check('QQ 号带前导 0 也不误杀自己的内容', () => {
  const mine = parseQzoneArchive({
    dynamics: [{
      cell_id: MY_CELL,
      published_at: TS_2018 + 100,
      content: '',
      category: 'self',
      is_history_residue: true,
    }],
    feeds: [],
  }, OWNER_PADDED);
  assert.equal(mine.length, 1);
});
check('QQ 号带前导 0 也能反解发布时间', () => {
  assert.equal(moodCellIdPublishedAt(MY_CELL, OWNER, TS_2018 + 100), TS_2018);
  assert.equal(moodCellIdPublishedAt(MY_CELL, OWNER_PADDED, TS_2018 + 100), TS_2018);
});
check('互动时间是近似值，不冒充精确发布时间', () => {
  // 内嵌时间比互动时间还晚 → 反解不可信，标成「互动时间近似」
  const cell = moodId(OWNER, TS_2018, 'dddd4444');
  const r = parseQzoneArchive({
    dynamics: [{
      cell_id: cell,
      published_at: TS_2015,
      published_from: 'interaction',
      content: '',
      category: 'self',
      is_history_residue: true,
    }],
    feeds: [],
  }, OWNER)[0];
  assert.equal(r.time_source, 'interaction-approx');
  assert.equal(r.published_at, TS_2015);
});
check('能从 cell_id 反解出发布时间时，时间精度升级', () => {
  const r = parseQzoneArchive({
    dynamics: [{
      cell_id: MY_CELL,
      published_at: TS_2018 + 100,
      published_from: 'interaction',
      content: '',
      category: 'self',
      is_history_residue: true,
    }],
    feeds: [],
  }, OWNER)[0];
  assert.equal(r.time_source, 'from-mood-id');
  assert.equal(r.published_at, TS_2018);
});

// ---------------------------------------------------------------------------
// 1d. 接地校验的红线
//
// 硬红线是「不许编造具体事实」：数字、日期、外文专名、引介出来的人名。
// 措辞重合度只兜「整段都在编」的情况——中文口语里虚词天然不重合，
// 阈值定太紧会把**有据可依**的回答误杀成固定话术，看着像「知识库里没有」。
// ---------------------------------------------------------------------------
console.log('\n[1d] 接地校验的红线');

// ⚠️ 下面的资料片段同样是**合成**的，不能用真实说说正文和好友昵称。
const CTX_2015 = '[时间] 2015-04-09 08:40（精确）\n[位置] 滨江区\n[互动] 0条评论 / 7个赞\n'
  + '[正文] 周末去爬了半山\n[评论摘录] 阿元: 厉害\n';

check('cell_id 里的数字不会被当成资料里的数字事实', () => {
  // 「500」只出现在 cell_id 的十六进制片段里，不该算资料里有这个数字
  const ctx = '[时间] 2020-01-13 11:12\n[原文] https://user.qzone.qq.com/'
    + OWNER + '/mood/' + moodId(OWNER, TS_2015, 'c0500') + '\n';
  assert.equal(factualTokensGrounded('我欠了同学 500 块。', ctx), false);
});
check('资料里真有的数字照常通过', () => {
  assert.equal(factualTokensGrounded('那一年攒了 610 个赞。', '[互动] 610 个赞'), true);
});
check('编造的外文专名被拦下', () => {
  assert.equal(factualTokensGrounded('2015 年我买了台 iPhone。', CTX_2015), false);
  assert.equal(factualTokensGrounded('2015 年我装了 Instagram。', CTX_2015), false);
});
check('顺手带出的英文普通词不误杀', () => {
  assert.equal(factualTokensGrounded('2015 年我在滨江区，I was very busy 那会儿。', CTX_2015), true);
});
check('引介出来的人名必须在资料里', () => {
  assert.equal(factualTokensGrounded('我认识了一个叫小美的朋友。', CTX_2015), false);
  assert.equal(factualTokensGrounded('我认识了一个叫阿元的人。', CTX_2015), true);
});
check('资料里没有的年份被拦下', () => {
  assert.equal(factualTokensGrounded('2019 年我去了冰岛。', CTX_2015), false);
});
check('画像里带各年代表原文（模型照着原话答，接地校验才有据）', () => {
  const p = buildProfile(merged, buildYearSummaries(merged));
  assert.ok(p.facts.includes('[各年代表原文]'));
  assert.ok(p.facts.includes('2015 年：'));
});

const chunks = buildChunks(merged);
check('切出 4 个 L1 块（含无时间戳但有内容的记录）', () => assert.equal(chunks.length, 4));
check('无时间戳的记录仍入库并显式标注', () => {
  const c = chunks.find((x) => x.id === 'no-time-record');
  assert.ok(c, '应保留该条');
  assert.ok(c.text.includes('[时间] 未知'));
});
check('块内含元数据前缀', () => {
  const c = chunks.find((x) => x.published_at === TS_2015);
  assert.ok(c.text.includes(`[时间] ${formatTimestamp(TS_2015)}`), c.text.split('\n')[0]);
  assert.ok(c.text.includes('[位置] 上海市静安区'));
  assert.ok(c.text.includes('[互动] 2条评论 / 18个赞'));
  assert.ok(c.text.includes('[评论摘录]'));
});
check('已恢复块带来源标记', () => {
  const c = chunks.find((x) => x.recovered);
  assert.ok(c.text.includes('[来源] 已删除后从互动残留恢复'));
});
check('超长块被截到 900 字以内且保留时间前缀', () => {
  const long = {
    id: 'x', content: '很长'.repeat(500), published_at: TS_2015, time_source: 'exact',
    location: '某地', like_count: 9, comments: Array.from({ length: 20 }, (_, i) => ({ nick: `好友${i}`, content: '评论内容'.repeat(30) })),
    post_url: 'http://x/y', recovered: false, first_interaction_at: 0, forward_from: '',
  };
  const built = buildChunks([long])[0];
  assert.ok(built.text.length <= 900, `实际 ${built.text.length}`);
  assert.ok(built.text.startsWith('[时间] '));
});

const summaries = buildYearSummaries(merged);
check('生成 3 个年度摘要', () => assert.ok(summaries.length >= 3));
check('摘要含条数与代表性内容', () => {
  const s = summaries.find((x) => x.year === '2015');
  assert.ok(s.text.includes('[条数]'));
  assert.ok(s.text.includes('代表性内容'));
});

// ---------------------------------------------------------------------------
// 2. 检索层
// ---------------------------------------------------------------------------
console.log('\n[2] 检索与置信度');
const index = buildIndex([...chunks, ...summaries]);

check('知识库内的问题能命中', () => {
  const hits = search(index, '静安寺', 6);
  assert.ok(hits.length > 0);
  assert.ok(isConfident(hits, '静安寺'));
});
check('知识库内的问题能命中（长表述）', () => {
  const hits = search(index, '我当年在静安寺弄那个离线网页是什么事', 6);
  assert.ok(hits.length > 0);
});
check('知识库外的问题不被判为置信', () => {
  const hits = search(index, '特斯拉Cybertruck的续航里程是多少', 6);
  assert.equal(isConfident(hits, '特斯拉Cybertruck的续航里程是多少'), false);
});
check('完全无关的问题不命中任何块', () => {
  const hits = search(index, '量子计算机的拓扑量子比特', 6);
  assert.equal(hits.length, 0);
});
check('空查询不返回结果', () => {
  assert.equal(search(index, '', 6).length, 0);
});

check('问法词被剥掉，只留实义内容', () => {
  assert.equal(normalizeQuery('2015 年我在忙什么？'), '2015');
  assert.equal(normalizeQuery('我当年在静安寺弄那个离线网页是什么事').includes('静安寺'), true);
});
check('纯年份问法能定位到那一年的记录', () => {
  const hits = search(index, '2015 年我在忙什么？', 6);
  assert.ok(hits.length > 0);
  assert.equal(isConfident(hits, '2015 年我在忙什么？'), true);
  assert.ok(hits.some((hit) => String(hit.chunk.year) === '2015'), '应命中 2015 年的块');
});
check('年份 + 无关内容不会被年份规则放行', () => {
  const hits = search(index, '2015 年特斯拉续航是多少', 6);
  assert.equal(isConfident(hits, '2015 年特斯拉续航是多少'), false);
});

// ---------------------------------------------------------------------------
// 2.5 泛化问法识别
// ---------------------------------------------------------------------------

console.log('\n[2.5] 泛化问法识别');

check('「我是个什么样的人」识别为自我性格类问题', () => {
  assert.equal(isSelfCharacterQuestion('我是个什么样的人？'), true);
});
check('「那几年我过得怎么样」识别为自我性格类问题', () => {
  assert.equal(isSelfCharacterQuestion('那几年我过得怎么样'), true);
});
check('「你了解我吗」识别为自我性格类问题', () => {
  assert.equal(isSelfCharacterQuestion('你了解我吗'), true);
});
check('知识库外的技术问题不算自我性格类问题', () => {
  assert.equal(isSelfCharacterQuestion('特斯拉 Cybertruck 的续航是多少'), false);
});
check('带「我」但与性格无关的问题不算自我性格类问题', () => {
  assert.equal(isSelfCharacterQuestion('我昨天吃饭了吗'), false);
});
check('问具体事实的问题不算自我性格类问题（不能靠画像放行）', () => {
  assert.equal(isSelfCharacterQuestion('我当年买过特斯拉吗'), false);
});
check('泛化问法本身在 BM25 里命中不了具体说说（所以需要单独路由）', () => {
  const hits = search(index, '我是个什么样的人', 6);
  const confident = isConfident(hits, '我是个什么样的人');
  assert.equal(confident, false, '这条断言是前提：BM25 靠不住，得靠画像路由');
});

// ---------------------------------------------------------------------------
// 3. 接地校验
// ---------------------------------------------------------------------------
console.log('\n[3] 接地校验');
const contextText = chunks.map((c) => c.text).join('\n\n');

check('落在资料里的答案通过接地', () => {
  const answer = '2015 年那会儿我在静安寺，把 QQ 空间历史说说整理成了离线网页。';
  assert.ok(groundingRatio(answer, contextText) > 0.35);
  assert.ok(factualTokensGrounded(answer, contextText));
});
check('编造的答案接地比不足', () => {
  const answer = '2019 年你去了冰岛看极光，还在东京的寿司店吃了金枪鱼。';
  assert.ok(groundingRatio(answer, contextText) < 0.35, `实测 ${groundingRatio(answer, contextText).toFixed(3)}`);
});
check('编造具体年份被事实校验拦下', () => {
  const answer = '我 2019 年在冰岛看极光。';
  assert.equal(factualTokensGrounded(answer, contextText), false);
});

// 资料里的时间写法是 "2015-03-15"，模型作答常写成 "2015 年 3 月 15 日"。
// 两种写法必须认作同一件事，否则合规回答会被误杀。
const localDate = (ts) => {
  const d = new Date(ts * 1000);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
};
const d2015 = localDate(TS_2015);

check('日期写法差异不误杀（资料 2015-03-15 vs 回答「2015 年 3 月 15 日」）', () => {
  const answer = `${d2015.year} 年 ${d2015.month} 月 ${d2015.day} 日，你在静安寺把 QQ 空间历史说说整理成了离线网页。`;
  assert.equal(factualTokensGrounded(answer, contextText), true);
});
check('资料里没有的完整日期被拦下', () => {
  assert.equal(factualTokensGrounded('1998 年 7 月 9 日，你在冰岛。', contextText), false);
});
check('资料里没有的年份被拦下', () => {
  assert.equal(factualTokensGrounded('我 2019 年在冰岛看极光。', contextText), false);
});
check('资料里没有的月份被拦下', () => {
  assert.equal(factualTokensGrounded('那是 12 月的事。', contextText), false);
});
check('点赞数与资料一致时通过', () => {
  assert.equal(factualTokensGrounded('那条有 18 个赞。', contextText), true);
});
check('点赞数与资料不一致时拦下', () => {
  assert.equal(factualTokensGrounded('那条有 337 个赞。', contextText), false);
});
check('中文数字人数一致时通过', () => {
  assert.equal(factualTokensGrounded('注册用户到了一万。', contextText), true);
});
check('中文数字人数不一致时拦下', () => {
  assert.equal(factualTokensGrounded('注册用户到了两万人。', contextText), false);
});

// ---------------------------------------------------------------------------
// 3.5 人物画像
// ---------------------------------------------------------------------------
console.log('\n[3.5] 人物画像');

const profile = buildProfile(merged, summaries);
check('画像能生成', () => assert.ok(profile));
check('画像含跨度、分布、人际、话题、表达习惯', () => {
  for (const key of ['[跨度]', '[年份分布]', '[互动最多的人]', '[表达习惯]', '[互动总量]']) {
    assert.ok(profile.facts.includes(key), `缺少 ${key}`);
  }
});
check('画像里的年份都在记录里', () => {
  const years = [...profile.facts.matchAll(/(\d{4}) 年/g)].map((m) => m[1]);
  const known = new Set(
    merged
      .map((r) => (r.published_at ? new Date(r.published_at * 1000).getFullYear() : null))
      .filter(Boolean)
      .map(String),
  );
  for (const year of years) assert.ok(known.has(year), `画像出现记录里没有的年份 ${year}`);
});
check('画像里的统计与记录一致', () => {
  const posted = merged.filter((r) => r.kind !== 'guestbook' && (r.content ?? '').trim());
  assert.ok(profile.facts.includes(`共 ${posted.length} 条说说`), profile.facts);
});

const cleaned = sanitizeNarrative(
  '2015 年那会儿在静安寺把 QQ 空间历史说说整理成了离线网页。2019 年去了冰岛看极光。注册用户到了一万。',
  contextText,
);
check('叙述里资料外的句子被剔除', () => {
  assert.ok(!cleaned.text.includes('冰岛'), cleaned.text);
  assert.ok(cleaned.text.includes('静安寺'), cleaned.text);
  assert.equal(cleaned.total, 3);
  assert.equal(cleaned.kept, 2);
});
check('全部句子都不成立时返回空', () => {
  const none = sanitizeNarrative('2019 年去了冰岛。2021 年去了挪威。', contextText);
  assert.equal(none.kept, 0);
  assert.equal(none.text, '');
});

// ---------------------------------------------------------------------------
// 4. 端到端：真实服务 + mock Agent
// ---------------------------------------------------------------------------
console.log('\n[4] 端到端（真实 HTTP 路由 + mock Agent）');

const dataDir = await mkdtemp(join(tmpdir(), 'qq-kb-test-'));
await mkdir(join(dataDir, 'raw'), { recursive: true });
await writeFile(join(dataDir, 'raw', 'qzoneexport_messages.json'), JSON.stringify(MESSAGES_JSON), 'utf8');
await writeFile(join(dataDir, 'raw', 'qzone_archive.json'), JSON.stringify(ARCHIVE_JSON), 'utf8');

const agentCalls = [];
let agentReply = '2015 年那会儿你在静安寺，把 QQ 空间历史说说整理成了离线网页，翻旧内容不用再一个个点。';
const mockAgent = {
  async run(input) {
    agentCalls.push(input.text);
    // 画像任务：返回一段叙述，其中一句故意写了记录里没有的年份
    if (input.text.includes('【任务】')) {
      return {
        sessionId: 'mock-session',
        status: 'finished',
        text: '2015 年那会儿在静安寺把 QQ 空间历史说说整理成了离线网页。'
          + '注册用户到了一万，那条记录里有评论说牛啊。'
          + '2018 年搬到了南京西路。'
          + '2019 年去了冰岛看极光。',
      };
    }
    return { sessionId: 'mock-session', status: 'finished', text: agentReply };
  },
  async reply() {},
};

const { start } = await import('../miniapp/node/server.mjs');

// 先占一个空闲端口再交给服务，避免用 0 让 OS 随机分配后读不到真实端口
const probe = createNetServer();
const port = await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const assigned = probe.address().port;
    probe.close(() => resolve(assigned));
  });
});

const context = {
  pluginRoot: join(import.meta.dirname, '..'),
  dataDir,
  listen: { host: '127.0.0.1', port },
  signal: new AbortController().signal,
  logger: { info() {}, error() {} },
  agent: mockAgent,
};

const lifecycle = await start(context);
const base = `http://127.0.0.1:${port}`;

async function call(path, options) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  return res.json();
}

/**
 * 问一句并等到有结果。
 * 需要模型的回合跑在后台（脱离 HTTP 请求），所以要轮询 /api/chat/result。
 */
async function waitFor(started) {
  if (!started.ok || !started.started) return started;
  for (let i = 0; i < 300; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await call('/api/chat/result?id=' + encodeURIComponent(started.id));
    if (result.status !== 'running') return result;
  }
  return { ok: false, message: '等待回答超时' };
}

async function ask(message) {
  return waitFor(await call('/api/chat', { method: 'POST', body: JSON.stringify({ message }) }));
}

try {
  const state0 = await call('/api/state');
  check('服务可访问且返回状态', () => {
    assert.equal(state0.phase, 'idle');
    assert.equal(state0.hasMessages, true);
    assert.equal(state0.hasArchive, true);
  });

  check('状态里带导出会话字段（页面要显示「只扫一次」）', () => {
    assert.ok('exportSession' in state0, 'state 里没有 exportSession 字段');
    // 还没导出过导出流程时它应该是 null；有流程时必须带 browserAlive / loginReady
    if (state0.exportSession !== null) {
      assert.ok('browserAlive' in state0.exportSession);
      assert.ok('loginReady' in state0.exportSession);
    }
  });

  const built = await call('/api/kb/build', {
    method: 'POST',
    body: JSON.stringify({ ownerUin: OWNER, persona: '说话简短直接。' }),
  });
  check('建库成功', () => {
    assert.equal(built.ok, true);
    assert.equal(built.stats.totalRecords, 4);
    assert.equal(built.stats.recovered, 1);
    assert.equal(built.stats.unknownTime, 1);
    assert.equal(built.stats.chunkCount, 4);
  });

  const state1 = await call('/api/state');
  check('状态推进到 ready 且人设已保存', () => {
    assert.equal(state1.phase, 'ready');
    assert.equal(state1.persona, '说话简短直接。');
  });

  check('状态里带 kbReady（顶部状态栏按它判断能不能聊）', () => {
    assert.equal(state1.kbReady, true);
    assert.equal(state0.kbReady, false, '建库前不该说知识库已就绪');
  });

  check('刚建完库不算过期', () => {
    assert.equal(state1.kbStale, false);
  });

  // 导出流程结束后 phase 会被置回 idle，但知识库还在、能对话。
  // 顶部状态栏不能因此显示「待开始」——这正是用户看到的那个问题。
  {
    const stateFile = join(dataDir, 'state.json');
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    await writeFile(stateFile, JSON.stringify({ ...saved, phase: 'idle', message: '导出流程已结束' }), 'utf8');
    const state2 = await call('/api/state');
    check('phase 回到 idle 时 kbReady 仍为 true（状态栏据此显示「知识库就绪」）', () => {
      assert.equal(state2.phase, 'idle');
      assert.equal(state2.kbReady, true);
    });
    await writeFile(stateFile, JSON.stringify({ ...saved, phase: 'ready', message: '知识库已就绪' }), 'utf8');
  }

  // 导出新数据但没重建 → 知识库是旧的，页面必须说清楚
  {
    const rawFile = join(dataDir, 'raw', 'qzoneexport_messages.json');
    const future = new Date(Date.now() + 60000);
    await writeFile(rawFile, await readFile(rawFile, 'utf8'), 'utf8');
    await utimes(rawFile, future, future);
    const state3 = await call('/api/state');
    check('raw 比 kb 新时标记 kbStale（提示用户重建）', () => {
      assert.equal(state3.kbStale, true);
      assert.equal(state3.kbReady, true);
    });
    const now = new Date();
    await utimes(rawFile, now, now);
  }

  // 命中 → 走 Agent 生成
  const hitStarted = await call('/api/chat', { method: 'POST', body: JSON.stringify({ message: '2015 年我在静安寺干嘛' }) });
  check('需要模型的对话立即返回，不挂在 HTTP 请求上', () => {
    assert.equal(hitStarted.ok, true);
    assert.equal(hitStarted.started, true);
    assert.ok(hitStarted.id, '应返回任务 id');
  });
  const hit = await waitFor(hitStarted);
  check('知识库内问题：给出有依据的回答', () => {
    assert.equal(hit.ok, true);
    assert.equal(hit.grounded, true);
    assert.ok(hit.answer.length > 0);
    assert.notEqual(hit.answer, FALLBACK);
    assert.ok(hit.sources.length > 0);
  });
  check('回答时把检索到的资料传给了 Agent', () => {
    assert.ok(agentCalls.length >= 1);
    assert.ok(agentCalls[0].includes('知识库资料'));
    assert.ok(agentCalls[0].includes('静安寺'));
  });

  // 未命中 → 固定话术，且不调用 Agent
  const callsBefore = agentCalls.length;
  const miss = await ask('特斯拉 Cybertruck 的续航是多少');
  check('知识库外问题：回固定话术', () => {
    assert.equal(miss.ok, true);
    assert.equal(miss.grounded, false);
    assert.equal(miss.answer, FALLBACK);
    assert.equal(miss.sources.length, 0);
    assert.equal(miss.reason, 'no_confident_match');
  });
  check('未命中时不调用 Agent（不产生任何编造机会）', () => {
    assert.equal(agentCalls.length, callsBefore);
  });
  check('未命中是同步返回的，不占用后台任务', () => {
    assert.equal(miss.started, undefined, '闸门拦下时应当场给固定话术');
  });

  // Agent 编造 → 接地校验拦下
  agentReply = '2019 年你去了冰岛看极光，还在东京吃了金枪鱼。';
  const fabricated = await ask('你 2015 年在静安寺干嘛');
  check('Agent 编造内容被接地校验拦下', () => {
    assert.equal(fabricated.ok, true);
    assert.equal(fabricated.grounded, false);
    assert.equal(fabricated.answer, FALLBACK);
  });
  check('编造时给出拦截原因并回传原话', () => {
    assert.equal(fabricated.reason, 'ungrounded_factual_claim');
    assert.ok(fabricated.rejected.includes('冰岛'), fabricated.rejected);
  });
  check('提示词带上了系统规则与人设', () => {
    assert.ok(agentCalls[0].includes('过去时态'));
    assert.ok(agentCalls[0].includes('人设'));
  });

  // 恢复一个基于资料的回答
  agentReply = '2015 年那会儿你在静安寺，把 QQ 空间历史说说整理成了离线网页。';
  const good = await ask('你 2015 年在静安寺干嘛');
  check('合规回答正常通过', () => {
    assert.equal(good.grounded, true);
    assert.notEqual(good.answer, FALLBACK);
  });

  // 追问续接：本轮命中新块时，此前检索到的资料仍然留在上下文里
  await ask('静安寺');
  await ask('南京西路');
  check('追问时上下文并入了此前检索到的资料', () => {
    const last = agentCalls[agentCalls.length - 1];
    assert.ok(last.includes('静安寺'), '应保留上一轮资料');
    assert.ok(last.includes('南京西路'), '应包含本轮资料');
  });

  // 空知识库
  await call('/api/reset', { method: 'POST', body: '{}' });
  const empty = await ask('你好');
  check('知识库为空时回固定话术', () => {
    assert.equal(empty.answer, FALLBACK);
    assert.equal(empty.reason, 'knowledge_base_empty');
  });

  // 搜索预览
  await call('/api/kb/build', { method: 'POST', body: JSON.stringify({ ownerUin: OWNER }) });

  // 建库后应当**立刻**有一份统计底座画像，不必等大模型。
  // 缺了它，用户还没点「生成人物画像」时对话里没有人物底色，
  // 接地校验会因为命中率不够把有据可依的回答误杀成固定话术。
  const statsProfile = await call('/api/profile');
  check('建库后自动就有统计底座画像', () => {
    assert.equal(statsProfile.ok, true);
    assert.equal(statsProfile.source, 'facts');
    assert.ok(statsProfile.facts.includes('[跨度]'));
  });
  const stateWithProfile = await call('/api/state');
  check('状态里直接显示已有画像', () => {
    assert.equal(stateWithProfile.hasProfile, true);
    assert.equal(stateWithProfile.profileSource, 'facts');
  });
  await ask('静安寺');
  check('统计底座也会进入对话提示词', () => {
    const last = agentCalls[agentCalls.length - 1];
    assert.ok(last.includes('【你是谁】'), '统计底座应作为人物底色注入');
  });

  const preview = await call('/api/search?q=' + encodeURIComponent('静安寺'));
  check('搜索预览返回命中', () => {
    assert.equal(preview.ok, true);
    assert.ok(preview.hits.length > 0);
    assert.equal(preview.confident, true);
  });

  // 演示数据标记
  await writeFile(join(dataDir, 'raw', 'demo.json'), JSON.stringify({ kind: 'demo' }), 'utf8');
  const demoState = await call('/api/state');
  check('状态里能识别出演示数据', () => {
    assert.equal(demoState.isDemo, true);
  });

  // 人物画像（后台任务，要等它跑完）
  const profileStarted = await call('/api/profile/build', { method: 'POST', body: '{}' });
  check('画像任务能启动并立即返回', () => {
    assert.equal(profileStarted.ok, true);
    assert.equal(profileStarted.started, true);
  });
  let profileBuilt = null;
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const st = await call('/api/state');
    if (st.hasProfile && !st.profileBuilding) {
      profileBuilt = await call('/api/profile');
      break;
    }
  }
  check('画像能生成', () => {
    assert.ok(profileBuilt && profileBuilt.ok, '画像应生成成功');
    assert.ok(profileBuilt.facts.includes('[跨度]'));
  });
  check('大模型叙述里越界的句子被剔除', () => {
    assert.equal(profileBuilt.source, 'llm');
    assert.ok(!profileBuilt.narrative.includes('冰岛'), profileBuilt.narrative);
    assert.ok(profileBuilt.narrative.includes('静安寺'), profileBuilt.narrative);
  });
  const profileState = await call('/api/state');
  check('状态里能看出画像已生成', () => {
    assert.equal(profileState.hasProfile, true);
  });
  const profileGet = await call('/api/profile');
  check('画像可单独读取', () => {
    assert.equal(profileGet.ok, true);
    assert.ok(profileGet.narrative.length > 0);
  });

  // 画像进入对话提示词
  const beforeProfileCall = agentCalls.length;
  await ask('静安寺');
  check('对话提示词里带上了人物画像', () => {
    const last = agentCalls[agentCalls.length - 1];
    assert.ok(last.includes('【你是谁】'), '提示词应含画像段');
    assert.ok(last.includes('静安寺'));
    assert.ok(agentCalls.length > beforeProfileCall);
  });

  // 泛化问法：BM25 命中不了具体说说，靠画像路由放行
  const beforeSelfCall = agentCalls.length;
  const self = await ask('我是个什么样的人？那几年我过得怎么样？');
  check('泛化问题不再落固定话术', () => {
    assert.equal(self.ok, true);
    assert.equal(self.grounded, true);
    assert.notEqual(self.answer, FALLBACK);
  });
  check('泛化问题确实触发了模型回合（说明画像路由生效了）', () => {
    assert.ok(agentCalls.length > beforeSelfCall, '应调用了模型');
  });
  check('泛化问题的提示词里带了画像段', () => {
    const last = agentCalls[agentCalls.length - 1];
    assert.ok(last.includes('【你是谁】'), '应带上人物画像');
  });

  // 泛化路由不放松越界红线：问知识库里没有的特斯拉，画像存在也照样回固定话术
  const beforeOutOfScope = agentCalls.length;
  const outOfScope = await ask('我当年买过特斯拉吗');
  check('泛化路由不放行越界问题', () => {
    assert.equal(outOfScope.answer, FALLBACK);
    assert.equal(outOfScope.reason, 'no_confident_match');
    assert.equal(agentCalls.length, beforeOutOfScope, '越界问题不应调用模型');
  });

  // 页面可访问
  const page = await fetch(`${base}/dashboard`);
  const html = await page.text();
  check('Client 页面可访问且含关键元素', () => {
    assert.equal(page.status, 200);
    assert.ok(html.includes('QQ 空间说说知识库'));
    assert.ok(html.includes('构建知识库'));
    assert.ok(html.includes('当时的我还不知道这是什么意思'));
  });

  await lifecycle.dispose();
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(56));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('\n失败明细：');
  for (const item of failures) console.log(`  ❌ ${item}`);
  process.exit(1);
}
console.log('✅ 全部通过');
