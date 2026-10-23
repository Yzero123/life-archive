// 微信朋友圈 → 统一知识库记录（2.0）
//
// 与 1.0 的关系：**只做加法**。
// 朋友圈记录产出的字段，和 QQ 空间记录走同一套 `emptyRecord()` 骨架，
// 于是下游的 mergeRecords / buildChunks / buildYearSummaries / buildProfile /
// buildIndex / 对话链路**一行都不用改**——朋友圈就是「另一种来源的记录」。
//
// 两条铁律：
//   1. **只取本人发的**。好友发的朋友圈不是「我发的」，进库等于让 bot 替别人说话。
//      （与 1.0 的作者归属过滤同一套思路。）
//   2. **媒体只存链接与描述，不下载**。图片视频走 CDN + ISAAC64 独立加密，
//      工程量大且微信 CDN 上约 58% 的旧图已失效，对 bot 画像收益有限。
//      保留 url / 描述 / 尺寸 / md5，够模型说清「这条配了几张图、什么内容」。
//
// 数据契约：直接吃 SIWX 的 JSON 导出形状（`meta` + `posts[]`）。
// 为什么对齐它而不是自己另立一套——
//   - SIWX 是 2.0 的主力解密路径，对齐它就等于「导入零转换」；
//   - 我们自己的 `wx-export-runner.py` 也产同一形状，于是**一个契约、两个生产者**；
//   - 归一化器对字段名做了宽容处理（time/create_time、text/content/name…），
//     第三方工具换了字段名也不会直接崩。

import { emptyRecord, TIME_SOURCE, WX_ID_PREFIX } from './kb.mjs';

export { WX_ID_PREFIX };
export const WX_SOURCE = 'wechat-sns';
export const WX_KIND = 'moments';

/** 卡片类型只有这五种，按**实际字段**推导，绝不信 type 编号。 */
const CARD_KIND_MAP = {
  link: 'link',
  music: 'music',
  note: 'note',
  finder: 'finder',
  finder_feed: 'finder',
  live: 'finder_live',
  finder_live: 'finder_live',
};

function text(value) {
  return String(value ?? '').trim();
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 账号目录名常带设备后缀（wxid_xxx_4160），比对作者时必须剥掉。
 * 否则「自己发的」一条都匹配不上——这是最容易踩且最难发现的坑。
 */
export function stripDeviceSuffix(account) {
  const value = text(account);
  if (!value) return '';
  return value.replace(/_\d+$/, '');
}

/** 有符号 int64 → 无符号。SQLite 里的 snsId 常是负数。 */
function unsignedId(value) {
  const raw = text(value);
  if (!raw) return '';
  if (/^-?\d+$/.test(raw)) {
    const n = BigInt(raw);
    const unsigned = n < 0n ? n + (1n << 64n) : n;
    return unsigned.toString();
  }
  return raw;
}

/** 时间戳统一成秒。毫秒（>1e11）自动折算。 */
function toSeconds(value) {
  const n = num(value, 0);
  if (!n) return 0;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/** 卡片 → 统一形状。 */
function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = CARD_KIND_MAP[text(raw.kind)] ?? null;
  if (!kind) return null;
  const card = {
    kind,
    title: text(raw.title),
    description: text(raw.description ?? raw.desc),
    url: text(raw.url),
    source: text(raw.source),
    cover: text(raw.cover),
    duration: num(raw.duration, 0),
  };
  const music = raw.music ?? {};
  const singer = text(music.singer ?? raw.singer);
  const album = text(music.album ?? raw.album);
  if (singer || album) card.music = { singer, album };
  const finder = raw.finder ?? {};
  const nickname = text(finder.nickname ?? raw.nickname);
  if (nickname) {
    if (kind === 'finder_live') card.live = { nickname, desc: card.description };
    else card.finder = { nickname };
  }
  const note = raw.note ?? {};
  const noteText = text(note.text ?? raw.text);
  if (noteText) card.note = { text: noteText };
  return card;
}

/**
 * 从**扁平**的 post 字段合成卡片。
 *
 * WeChatDataAnalysis 的导出把卡片摊在 post 顶层：
 * `title` / `contentUrl` / `finderFeed` / `finderLive` / `official`，
 * 没有 SIWX 那种 `card: {...}` 子对象。卡片类型按**实际存在的字段**推导，
 * 不看 type 编号——编号在不同微信版本里会漂移。
 */
function cardFromFlatPost(post) {
  const finder = post.finderFeed ?? null;
  const live = post.finderLive ?? null;
  const official = post.official ?? null;
  const source = text(post.sourceName);

  if (finder && typeof finder === 'object' && Object.keys(finder).length) {
    const nickname = text(finder.nickname);
    return {
      kind: 'finder',
      title: text(finder.title),
      description: text(finder.description ?? finder.desc),
      url: '',
      source,
      cover: text(finder.thumbUrl ?? finder.coverUrl),
      duration: num(finder.videoPlayDuration, 0),
      finder: nickname ? { nickname } : {},
    };
  }
  if (live && typeof live === 'object' && Object.keys(live).length) {
    const nickname = text(live.nickname);
    return {
      kind: 'finder_live',
      title: '',
      description: text(live.desc ?? live.description),
      url: '',
      source,
      cover: text(live.coverUrl ?? live.headUrl),
      duration: 0,
      live: nickname ? { nickname } : {},
    };
  }
  const title = text(post.title);
  const url = text(post.contentUrl);
  if (title || url) {
    return {
      kind: 'link',
      title,
      description: text(post.contentDesc),
      url,
      source: source || text(official?.username),
      cover: '',
      duration: 0,
    };
  }
  return null;
}

/** 媒体 → 统一形状。视频靠 type/duration 判断。 */
function normalizeMedia(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = text(raw.url);
  const thumb = text(raw.thumb ?? raw.thumb_url ?? raw.thumbUrl);
  if (!url && !thumb) return null;
  const rawType = raw.type;
  const duration = num(raw.duration ?? raw.videoDuration ?? raw.videoPlayDuration, 0);
  const isVideo = rawType === 'video' || rawType === 6 || (rawType !== 'image' && rawType !== 2 && duration > 0);
  return {
    url,
    thumb,
    md5: text(raw.md5),
    width: num(raw.width, 0),
    height: num(raw.height, 0),
    duration,
    isVideo,
    description: text(raw.description),
    title: text(raw.title),
  };
}

function normalizeComment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const content = text(raw.text ?? raw.content);
  if (!content) return null;
  return {
    nick: text(raw.name ?? raw.nickname ?? raw.nick) || '匿名',
    content,
    uin: text(raw.username ?? raw.uin),
  };
}

function normalizeLike(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    uin: text(raw.username ?? raw.uin),
    nick: text(raw.name ?? raw.nickname ?? raw.nick),
  };
}

/** 一条原始 post → 归一化 post。 */
function normalizePost(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = unsignedId(raw.id ?? raw.tid);
  if (!id) return null;

  const location = raw.location;
  let place = '';
  if (typeof location === 'string') place = text(location);
  else if (location && typeof location === 'object') place = text(location.name) || text(location.address);

  const media = Array.isArray(raw.media) ? raw.media : Array.isArray(raw.medias) ? raw.medias : [];
  const likes = Array.isArray(raw.likes) ? raw.likes : [];
  const comments = Array.isArray(raw.comments) ? raw.comments : [];

  return {
    id,
    author: text(raw.author ?? raw.username ?? raw.user_name),
    time: toSeconds(raw.time ?? raw.create_time ?? raw.createTime ?? raw.ts),
    text: text(raw.text ?? raw.content ?? raw.contentDesc ?? raw.content_desc),
    kind: num(raw.kind ?? raw.content_type ?? raw.type, 0),
    private: Boolean(raw.private),
    location: place,
    card: normalizeCard(raw.card) ?? cardFromFlatPost(raw),
    forwardFrom: text(raw.sourceName ?? raw.source_username),
    media: media.map(normalizeMedia).filter(Boolean),
    likes: likes.map(normalizeLike).filter(Boolean),
    comments: comments.map(normalizeComment).filter(Boolean),
  };
}

/**
 * 归一化整份 payload。
 *
 * 接受三种顶层形状：
 *   - SIWX：            `{ meta: { account }, posts: [...] }`
 *   - WeChatDataAnalysis：`{ account, username, posts: [...] }`（account 在顶层）
 *   - 本插件取数工具：  `{ meta: { account }, posts: [...] }`
 * owner 依次从 `meta.account` → 顶层 `account` → 顶层 `username` → `owner_wxid` 取。
 */
export function normalizeWxPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const meta = source.meta && typeof source.meta === 'object' ? source.meta : {};
  const list = Array.isArray(source.posts) ? source.posts
    : Array.isArray(source.moments) ? source.moments
      : Array.isArray(source) ? source : [];
  const owner = stripDeviceSuffix(
    meta.account ?? source.account ?? source.username ?? source.owner_wxid ?? source.owner ?? '',
  );
  const posts = list.map(normalizePost).filter(Boolean);
  return { owner, posts, meta };
}

// ---------------------------------------------------------------------------
// 正文合成
// ---------------------------------------------------------------------------

/**
 * 朋友圈动态的正文常常不在正文字段里：
 *   - 公众号文章：正文在 media 的 description
 *   - 链接卡片：标题/摘要/来源在 card
 *   - 视频号：昵称/描述在 card.finder
 *   - 音乐：歌名/歌手在 card.music
 * 只取正文字段会让大量动态变成空文本——模型就没东西可说了。
 */
export function composeWxContent(post) {
  const parts = [];
  const push = (value) => {
    const t = text(value);
    if (t) parts.push(t);
  };

  push(post.text);

  const card = post.card;
  if (card) {
    push(card.title);
    push(card.description);
    push(card.source);
    push(card.music?.singer);
    push(card.music?.album);
    push(card.finder?.nickname);
    push(card.live?.nickname);
    push(card.note?.text);
  }

  for (const media of post.media ?? []) {
    push(media.description);
    push(media.title);
  }

  return parts.join(' | ').trim();
}

/** 没有文本的动态也给一句**事实性**描述（1.0 的 [图片说说] 同样做法）。 */
function factualFallback(post) {
  const media = post.media ?? [];
  const count = media.length;
  const videos = media.filter((m) => m.isVideo).length;
  if (count) {
    const pieces = [];
    pieces.push(`${count} 张图`);
    if (videos) pieces.push(`${videos} 段视频`);
    return `[朋友圈] ${pieces.join(' / ')}`;
  }
  const card = post.card;
  if (card) return `[朋友圈·${card.kind}] ${card.title || card.description || ''}`.trim();
  return '[朋友圈]';
}

// ---------------------------------------------------------------------------
// 入库
// ---------------------------------------------------------------------------

/**
 * 把朋友圈导出 JSON 解析成统一记录。
 *
 * @param {object} payload  SIWX 形状（或本插件取数工具形状）的 JSON
 * @param {{ ownerWxid?: string }} options
 * @returns {{ records: object[], stats: object }}
 */
export function parseWechatSns(payload, { ownerWxid = '' } = {}) {
  const { owner: payloadOwner, posts } = normalizeWxPayload(payload);
  const owner = stripDeviceSuffix(ownerWxid || payloadOwner);
  const records = [];
  const stats = {
    total: posts.length,
    kept: 0,
    notMine: 0,
    empty: 0,
    owner: owner,
    ownerResolved: Boolean(owner),
  };

  for (const post of posts) {
    // 只取本人发的。作者为空时保守跳过——无法确认归属就不入库。
    if (!owner) {
      stats.notMine += 1;
      continue;
    }
    if (post.author && stripDeviceSuffix(post.author) !== owner) {
      stats.notMine += 1;
      continue;
    }
    if (!post.author) {
      stats.notMine += 1;
      continue;
    }

    const record = emptyRecord();
    record.id = `${WX_ID_PREFIX}${post.id}`;
    record.ids = [record.id];
    record.sources = [WX_SOURCE];
    record.kind = WX_KIND;
    record.recovered = false;
    record.body_missing = false;

    record.published_at = post.time || 0;
    record.time_source = record.published_at ? TIME_SOURCE.EXACT : TIME_SOURCE.UNKNOWN;
    record.location = post.location || '';

    record.comment_count = post.comments.length;
    record.like_count = post.likes.length;
    record.forward_count = 0;
    record.comments = post.comments.map((c) => ({ nick: c.nick, content: c.content }));
    record.like_users = post.likes.map((l) => ({ uin: l.uin, nick: l.nick }));

    record.images = post.media
      .filter((m) => !m.isVideo)
      .map((m) => ({ url: m.url, thumb: m.thumb, md5: m.md5 }));
    record.videos = post.media
      .filter((m) => m.isVideo)
      .map((m) => ({ url: m.url, thumb: m.thumb, duration: m.duration }));

    const composed = composeWxContent(post);
    record.content = composed || factualFallback(post);
    if (!record.content) {
      stats.empty += 1;
      continue;
    }

    record.post_url = post.card?.url || '';
    record.forward_from = post.forwardFrom || '';
    record.raw = {
      tid: post.id,
      content_type: post.kind,
      card_kind: post.card?.kind ?? '',
      card_title: post.card?.title ?? '',
      media_count: post.media.length,
      private: post.private,
    };

    records.push(record);
    stats.kept += 1;
  }

  records.sort((a, b) => (a.published_at || 0) - (b.published_at || 0));
  return { records, stats };
}

/** 从统一记录里数出各来源的条数（画像与状态栏要用）。 */
export function countBySource(records) {
  const counts = new Map();
  for (const record of records ?? []) {
    for (const source of record.sources ?? []) {
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }
  return Object.fromEntries(counts);
}
