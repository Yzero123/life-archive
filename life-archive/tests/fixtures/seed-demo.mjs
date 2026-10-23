// 演示数据种子：在没有真实 QQ 账号时，用合成的说说数据跑通「建库 → 检索 → 对话」全链路。
//
// 用法：
//   node tests/fixtures/seed-demo.mjs --data-dir <MiniApp 的 dataDir>
//   node tests/fixtures/seed-demo.mjs --data-dir <dir> --owner 999888777
//
// 注意：写入的是**合成的演示数据**，不是真实 QQ 记录。
// 真实导出请走页面上的「开始导出」，由 Agent 驱动扫码登录后落盘。

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function parseArgs(argv) {
  const out = { dataDir: '', owner: '999888777' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data-dir') out.dataDir = argv[i + 1] ?? '';
    if (argv[i] === '--owner') out.owner = argv[i + 1] ?? out.owner;
  }
  return out;
}

// QQ 空间说说 tid 的构造：owner_uin(小端4字节) + 时间戳(小端4字节) + 随机后缀
function moodId(ownerUin, ts, suffix) {
  const le = (n) => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(n >>> 0);
    return buf.toString('hex');
  };
  return le(Number(ownerUin)) + le(ts) + suffix;
}

const TS = {
  '2013-07-15T02:00:00Z': 1373853600,
  '2014-03-02T14:30:00Z': 1393768200,
  '2015-11-20T13:10:00Z': 1448010600,
  '2016-08-05T11:45:00Z': 1470380700,
  '2017-01-28T15:20:00Z': 1485610800,
  '2018-04-18T10:05:00Z': 1524035100,
  '2019-12-30T13:40:00Z': 1577612400,
};

const args = parseArgs(process.argv.slice(2));
if (!args.dataDir) {
  console.error('用法：node tests/fixtures/seed-demo.mjs --data-dir <MiniApp 的 dataDir> [--owner QQ号]');
  process.exit(1);
}
const OWNER = args.owner;

const MESSAGES = [
  {
    tid: moodId(OWNER, TS['2013-07-15T02:00:00Z'], 'a1b2c301'),
    custom_content: '刚毕业第一份工作，在一家小公司写网页，月薪 3500。同事都比我大两岁，晚上常一起去吃烧烤。',
    created_time: TS['2013-07-15T02:00:00Z'],
    custom_create_time: '2013-07-15 10:00',
    commentlist: [
      { content: '恭喜毕业！', nick: '阿May', createTime: '2013年07月15日' },
      { content: '深圳那边挺热的吧', nick: '老周', createTime: TS['2013-07-15T02:00:00Z'] + 7200 },
    ],
    likeTotal: 12,
    likes: [{ fuin: 10001, nick: '阿May' }],
    lbs: { address: '广东省深圳市南山区', name: '科技园' },
    pic: [],
  },
  {
    tid: moodId(OWNER, TS['2014-03-02T14:30:00Z'], 'b2c3d402'),
    custom_content: '搬到北京了，租了个五环外的小房间，冬天冷得要命，暖气还是坏的。',
    created_time: TS['2014-03-02T14:30:00Z'],
    custom_create_time: '2014-03-02 22:30',
    commentlist: [],
    likeTotal: 5,
    likes: [],
    lbs: { address: '北京市海淀区', name: '上地' },
    pic: [],
  },
  {
    tid: moodId(OWNER, TS['2015-11-20T13:10:00Z'], 'c3d4e503'),
    custom_content: '做了第一个自己独立上线的项目，注册用户到了一万。那天晚上一个人在静安寺的出租屋喝了两瓶啤酒。',
    created_time: TS['2015-11-20T13:10:00Z'],
    custom_create_time: '2015-11-20 21:10',
    commentlist: [
      { content: '牛啊，一万用户！', nick: '阿May', createTime: '2015年11月20日' },
      { content: '静安寺那边确实挺远的', nick: '老周', createTime: TS['2015-11-20T13:10:00Z'] + 3600 },
      { content: '记得请我们吃饭', nick: '小林', createTime: TS['2015-11-20T13:10:00Z'] + 5400 },
    ],
    likeTotal: 18,
    likes: [{ fuin: 10001, nick: '阿May' }],
    lbs: { address: '上海市静安区', name: '静安寺' },
    pic: [],
  },
  {
    tid: moodId(OWNER, TS['2016-08-05T11:45:00Z'], 'd4e5f604'),
    custom_content: '去了趟成都，窄巷子里喝茶，宽巷子里吃火锅，吃到扶墙出门。',
    created_time: TS['2016-08-05T11:45:00Z'],
    custom_create_time: '2016-08-05 19:45',
    commentlist: [],
    likeTotal: 9,
    likes: [],
    lbs: { address: '四川省成都市青羊区', name: '宽窄巷子' },
    pic: [],
  },
  {
    tid: moodId(OWNER, TS['2018-04-18T10:05:00Z'], 'e5f6a705'),
    custom_content: '创业第三年，团队扩到 20 个人。开始睡不好觉，凌晨两点还在回邮件。',
    created_time: TS['2018-04-18T10:05:00Z'],
    custom_create_time: '2018-04-18 18:05',
    commentlist: [
      { content: '注意点身体', nick: '小林', createTime: '2018年04月18日' },
    ],
    likeTotal: 7,
    likes: [],
    lbs: { address: '浙江省杭州市西湖区', name: '西溪' },
    pic: [],
  },
  {
    tid: moodId(OWNER, TS['2019-12-30T13:40:00Z'], 'f6a7b806'),
    custom_content: '这一年过得很快。好像很多事没做完，但又说不上来到底缺了什么。',
    created_time: TS['2019-12-30T13:40:00Z'],
    custom_create_time: '2019-12-30 21:40',
    commentlist: [],
    likeTotal: 4,
    likes: [],
    pic: [],
  },
  {
    tid: 'no-time-demo-record',
    custom_content: '记不清是哪天了，那阵子好像总在改一个怎么改都改不完的登录页。',
    created_time: 0,
    commentlist: [],
    likeTotal: 0,
  },
];

const ARCHIVE = {
  dynamics: [
    {
      cell_id: moodId(OWNER, TS['2015-11-20T13:10:00Z'], 'c3d4e503'),
      published_at: TS['2015-11-20T13:10:00Z'],
      content: '做了第一个自己独立上线的项目，注册用户到了一万。那天晚上一个人在静安寺的出租屋喝了两瓶啤酒。',
      category: 'self',
      author_uin: OWNER,
      author_name: '我',
      is_history_residue: false,
    },
    {
      cell_id: `history-v2:${'a'.repeat(32)}`,
      published_at: TS['2017-01-28T15:20:00Z'],
      content: '那年冬天在南方过了第一个春节，租的房子里只有一张床，窗外一直在下雨。',
      category: 'self',
      author_uin: OWNER,
      author_name: '我',
      is_history_residue: true,
    },
  ],
  feeds: [
    {
      cell_id: `history-v2:${'a'.repeat(32)}`,
      event_type: 2,
      event_time: TS['2017-01-28T15:20:00Z'] + 100,
      actor_uin: '20003',
      actor_name: '老周',
      comments_json: JSON.stringify({
        main_comment: {
          commentid: 'c-demo-1',
          user: { uin: '20003', nickname: '老周' },
          content: '新年快乐',
          date: TS['2017-01-28T15:20:00Z'] + 100,
        },
      }),
      feed_key: 'history-v2-event:demo',
    },
  ],
};

const rawDir = join(args.dataDir, 'raw');
await mkdir(rawDir, { recursive: true });
await writeFile(join(rawDir, 'qzoneexport_messages.json'), `${JSON.stringify(MESSAGES, null, 2)}\n`, 'utf8');
await writeFile(join(rawDir, 'qzone_archive.json'), `${JSON.stringify(ARCHIVE, null, 2)}\n`, 'utf8');
// 标记文件：让界面能明确提示「当前是演示数据」，避免和真实导出混淆
await writeFile(
  join(rawDir, 'demo.json'),
  `${JSON.stringify({ kind: 'demo', ownerUin: OWNER, note: '合成演示数据，不是真实 QQ 记录' }, null, 2)}\n`,
  'utf8',
);

console.log(`✅ 演示数据已写入 ${rawDir}`);
console.log(`   qzoneexport_messages.json — ${MESSAGES.length} 条（含 1 条无时间戳）`);
console.log(`   qzone_archive.json — ${ARCHIVE.dynamics.length} 条动态（其中 1 条为已删除后恢复）`);
console.log(`   demo.json — 标记文件，界面会显示「演示数据」提示`);
console.log(`   演示用 QQ 号：${args.owner}`);
