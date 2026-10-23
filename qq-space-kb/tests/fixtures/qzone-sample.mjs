// 固定的 QQ 空间样例记录集（2.0 回归用）。
//
// 用途：拿同一份输入分别喂给 1.0 和 2.0 的 buildProfile / buildYearSummaries /
// renderChunk，比对输出**逐字节**是否一致。
// 有了这份样例，「不影响 1.0」就不靠人说了算，而是有可执行的锁。
//
// 数据全部是合成的，不含任何真实身份信息。

import { emptyRecord } from '../../miniapp/node/kb.mjs';

const OWNER = '1927686067';

/** QQ 空间说说 ID：owner(小端 u32) + 时间戳(小端 u32) + 随机后缀。 */
function moodId(ts, suffix) {
  const le = (n) => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(n >>> 0);
    return buf.toString('hex');
  };
  return le(Number(OWNER)) + le(ts) + suffix;
}

const T = {
  '2015-03-14T02:00:00Z': 1426300800,
  '2016-07-22T14:30:00Z': 1469195400,
  '2018-11-05T11:45:00Z': 1541405100,
  '2020-05-18T15:20:00Z': 1589803200,
};

export const SAMPLE_OWNER = OWNER;

export function sampleQzoneRecords() {
  const records = [];

  // 1. 普通说说：正文 + 位置 + 赞 + 评论
  const a = emptyRecord();
  a.id = moodId(T['2015-03-14T02:00:00Z'], 'a1b2c301');
  a.ids = [a.id];
  a.sources = ['qzoneexport'];
  a.kind = 'shuoshuo';
  a.published_at = T['2015-03-14T02:00:00Z'];
  a.time_source = 'exact';
  a.content = '第一份正式工作，工资刚够房租，冬天冷得早上都不想出门。';
  a.location = '演示市演示区';
  a.like_count = 12;
  a.comment_count = 2;
  a.like_users = [{ uin: '10001', nick: '演示同学甲' }];
  a.comments = [
    { nick: '演示同学甲', content: '恭喜' },
    { nick: '演示同学乙', content: '那边挺冷的吧' },
  ];
  records.push(a);

  // 2. 已删除后恢复、正文没回来
  const b = emptyRecord();
  b.id = moodId(T['2016-07-22T14:30:00Z'], 'b2c3d402');
  b.ids = [b.id];
  b.sources = ['qzoneexport'];
  b.kind = 'shuoshuo';
  b.published_at = T['2016-07-22T14:30:00Z'];
  b.time_source = 'exact';
  b.recovered = true;
  b.body_missing = true;
  b.content = '';
  b.like_count = 3;
  b.comment_count = 1;
  records.push(b);

  // 3. 带图说说
  const c = emptyRecord();
  c.id = moodId(T['2018-11-05T11:45:00Z'], 'c3d4e503');
  c.ids = [c.id];
  c.sources = ['qzoneexport'];
  c.kind = 'shuoshuo';
  c.published_at = T['2018-11-05T11:45:00Z'];
  c.time_source = 'exact';
  c.content = '搬去新住处第一天，楼下是条老街，早上很安静。';
  c.images = [{ url: 'https://example.com/demo/q1' }];
  c.like_count = 7;
  records.push(c);

  // 4. 时间不可考
  const d = emptyRecord();
  d.id = moodId(0, 'd4e5f604');
  d.ids = [d.id];
  d.sources = ['qzoneexport'];
  d.kind = 'shuoshuo';
  d.published_at = 0;
  d.time_source = 'unknown';
  d.content = '记不清是哪年写的了，反正那阵子很忙。';
  records.push(d);

  // 5. 留言板：不算「我发过的说说」，画像与年度小结都要排除
  const e = emptyRecord();
  e.id = 'history-guestbook:sample0001';
  e.ids = [e.id];
  e.sources = ['qzoneexport'];
  e.kind = 'guestbook';
  e.published_at = T['2020-05-18T15:20:00Z'];
  e.time_source = 'exact';
  e.content = '来自留言板的留言，不该被当成我发的。';
  records.push(e);

  return records;
}
