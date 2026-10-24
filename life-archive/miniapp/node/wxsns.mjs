// 微信朋友圈 → 统一知识库记录（2.0）
//
// 与 1.0 的关系：**只做加法**。
// 朋友圈记录产出的字段，和 QQ 空间记录走同一套 `emptyRecord()` 骨架，
// 于是下游的 mergeRecords / buildChunks / buildYearSummaries / buildProfile /
// buildIndex / 对话链路**一行都不用改**——朋友圈就是「另一种来源的记录」。
//
// 三条铁律：
//   1. **本人发的是主体**。好友发的朋友圈不是「我发的」，不能当成我的话进库。
//   2. **但「我在别人朋友圈下说的话」是我说的**。留言原话进库，好友原文只作
//      上下文（`user_voice` 字段只装我的话），接地校验和表达习惯统计都用
//      `user_voice`——所以 bot 不会把别人的话当成我说的。
//   3. **媒体只存链接与描述，不下载**。图片视频走 CDN + ISAAC64 独立加密，
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

import {
  MAX_COMMENTS,
  MAX_CONTENT_CHARS,
  MAX_LIKE_USERS,
  MAX_MEDIA,
  MAX_RECORDS,
  capText,
} from './limits.mjs';

export { WX_ID_PREFIX };
export const WX_SOURCE = 'wechat-sns';
export const WX_KIND = 'moments';

/** 2.1 新增：我在别人朋友圈下留的言（原话是我的）。 */
export const WX_COMMENT_SOURCE = 'wechat-sns-comment';
export const WX_COMMENT_KIND = 'moments_comment';
export const WX_COMMENT_ID_PREFIX = 'wx-c-';

/** 2.1 新增：我给别人朋友圈点的赞（只有事实，没有我的原话）。 */
export const WX_LIKE_SOURCE = 'wechat-sns-like';
export const WX_LIKE_KIND = 'moments_like';
export const WX_LIKE_ID_PREFIX = 'wx-l-';

/** 好友原文在留言记录里最多留多少字——够看语境，又不至于喧宾夺主。 */
const REPLY_SNIPPET_MAX = 60;

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
    // 2.1：留言记录要按**留言时间**落库，不能用动态的发布时间。
    time: toSeconds(raw.time ?? raw.create_time ?? raw.createTime),
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
  // 2.1：取数工具标出来的「我的留言」与「我点了赞」。
  // myComments 里保留 username，插件要**自己再核对一次**归属——
  // 不能全信外部数据里的「这是我的」标记。
  const myComments = Array.isArray(raw.myComments) ? raw.myComments : [];

  return {
    id,
    author: text(raw.author ?? raw.username ?? raw.user_name),
    authorName: text(raw.authorName ?? raw.author_name ?? raw.displayName),
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
    myLike: Boolean(raw.myLike),
    myLikeTime: toSeconds(raw.myLikeTime ?? raw.my_like_time),
    myComments: myComments.map(normalizeComment).filter(Boolean),
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
 * @param {{ ownerWxid?: string, includeInteractions?: boolean }} options
 * @returns {{ records: object[], stats: object }}
 */
export function parseWechatSns(payload, { ownerWxid = '', includeInteractions = false } = {}) {
  const { owner: payloadOwner, posts } = normalizeWxPayload(payload);
  const owner = stripDeviceSuffix(ownerWxid || payloadOwner);
  const records = [];
  const stats = {
    total: posts.length,
    kept: 0,
    notMine: 0,
    empty: 0,
    comments: 0,
    likes: 0,
    owner: owner,
    ownerResolved: Boolean(owner),
    // 3.0.1：撞到记录数上限时如实标出来，不假装「全都导进来了」。
    truncated: false,
  };

  for (const post of posts) {
    // 3.0.1：总量上限。不让一份畸形导出把内存吃光。
    if (records.length >= MAX_RECORDS) {
      stats.truncated = true;
      break;
    }
    // 作者为空时保守跳过——无法确认归属就不入库。
    if (!post.author) {
      stats.notMine += 1;
      continue;
    }
    const isMine = stripDeviceSuffix(post.author) === owner;

    // 2.1：先处理「我在这条动态下说的话」。
    // 注意顺序很重要——**我回复自己朋友圈下的评论**（占大头）也是我说的话，
    // 不能因为这条动态是「我发的」就一起丢掉。
    // 归属要**自己再核对一次**：外部数据标的「这是我的」不可全信。
    //
    // 互动开关关掉时，这里必须**一条留言都不生成**——否则「关闭朋友圈互动」
    // 只关掉了点赞，留言照旧入库，开关形同虚设。
    const myComments = includeInteractions
      ? post.myComments.filter((c) => c.uin && stripDeviceSuffix(c.uin) === owner)
      : [];
    for (let index = 0; index < myComments.length; index += 1) {
      const mine = myComments[index];
      const voice = capText(text(mine.content), MAX_CONTENT_CHARS);
      if (!voice) continue;
      const record = emptyRecord();
      record.id = `${WX_COMMENT_ID_PREFIX}${post.id}-${index}`;
      record.ids = [record.id];
      record.sources = [WX_COMMENT_SOURCE];
      record.kind = WX_COMMENT_KIND;
      record.recovered = false;
      record.body_missing = false;

      record.published_at = mine.time || post.time || 0;
      record.time_source = record.published_at ? TIME_SOURCE.EXACT : TIME_SOURCE.UNKNOWN;
      record.location = '';
      record.comment_count = 0;
      record.like_count = 0;
      record.forward_count = 0;
      record.comments = [];
      record.like_users = [];
      record.images = [];
      record.videos = [];

      const who = text(post.authorName) || text(post.author);
      const snippet = text(post.text).slice(0, REPLY_SNIPPET_MAX);
      // 正文给模型留语境，但用标签把「原文」和「我的留言」隔开。
      // 原文是**我自己的动态**时，写「我自己的朋友圈」；是好友的，写昵称。
      const where = isMine ? '我自己的朋友圈' : `「${who}」的朋友圈`;
      record.content = [
        `【留言】在${where}下留言`,
        snippet ? `原文：「${snippet}」` : '',
        `留言：「${voice}」`,
      ].filter(Boolean).join('\n');
      // **只有我的原话进 user_voice**——接地校验、表达习惯统计都用它，
      // 这样 bot 不会把好友的原文当成我说的。
      record.user_voice = voice;
      record.raw = {
        tid: post.id,
        reply_to: post.author,
        reply_to_name: who,
        reply_on_own_post: isMine,
        reply_snippet: snippet,
        comment_index: index,
        liked_by_me: Boolean(post.myLike),
        content_type: post.kind,
      };
      records.push(record);
      stats.comments += 1;
    }

    if (isMine) {
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
      // 2.1：**我回复别人时，微信把评论者昵称填成「我」的昵称**。
      // 不滤掉的话，「互动最多的人」第一名的会是我自己（实测 850 次里 848 次是我）。
      // 自己说过的话另有「留言」记录承载，这里只留**别人**对我的评论。
      record.comments = post.comments
        .filter((c) => !c.uin || stripDeviceSuffix(c.uin) !== owner)
        .map((c) => ({ nick: c.nick, content: c.content }))
        .slice(0, MAX_COMMENTS);
      record.like_users = post.likes
        .filter((l) => !l.uin || stripDeviceSuffix(l.uin) !== owner)
        .map((l) => ({ uin: l.uin, nick: l.nick }))
        .slice(0, MAX_LIKE_USERS);

      record.images = post.media
        .filter((m) => !m.isVideo)
        .map((m) => ({ url: m.url, thumb: m.thumb, md5: m.md5 }))
        .slice(0, MAX_MEDIA);
      record.videos = post.media
        .filter((m) => m.isVideo)
        .map((m) => ({ url: m.url, thumb: m.thumb, duration: m.duration }))
        .slice(0, MAX_MEDIA);

      const composed = composeWxContent(post);
      // 3.0.1：单条正文有硬上限，超了显式标注截断。
      record.content = capText(composed || factualFallback(post), MAX_CONTENT_CHARS);
      record.user_voice = record.content;
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
      continue;
    }

    // 好友发的动态：只有「我参与的部分」才进库。
    if (!includeInteractions) {
      stats.notMine += 1;
      continue;
    }

    // 2.1：我点的赞——只有事实，没有我的原话，所以不带好友原文。
    // 同一动态已经因为留言进库了，就不重复生成点赞记录。
    if (post.myLike && myComments.length === 0) {
      const record = emptyRecord();
      record.id = `${WX_LIKE_ID_PREFIX}${post.id}`;
      record.ids = [record.id];
      record.sources = [WX_LIKE_SOURCE];
      record.kind = WX_LIKE_KIND;
      record.recovered = false;
      record.body_missing = false;

      record.published_at = post.myLikeTime || post.time || 0;
      record.time_source = record.published_at ? TIME_SOURCE.EXACT : TIME_SOURCE.UNKNOWN;
      record.location = '';
      record.comment_count = 0;
      record.like_count = 0;
      record.forward_count = 0;
      record.comments = [];
      record.like_users = [];
      record.images = [];
      record.videos = [];

      const who = text(post.authorName) || text(post.author);
      record.content = `【点赞】给「${who}」的朋友圈点了赞`;
      record.user_voice = '';
      record.raw = {
        tid: post.id,
        liked_author: post.author,
        liked_author_name: who,
        content_type: post.kind,
      };
      records.push(record);
      stats.likes += 1;
    }

    // 2.1：`notMine` = 好友发的、且**我完全没参与**、所以真的被忽略的动态数。
    // 我留过言或点过赞的动态已经以互动记录进库了，不能再算成「被忽略」，
    // 否则页面上的「另有 N 条不是本人发的，已忽略」会虚高。
    // 2.0 里没有互动概念，所有好友动态都真的被忽略，数值与 2.0 完全一致。
    if (myComments.length === 0 && !post.myLike) {
      stats.notMine += 1;
    }
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

/**
 * 合并两次导出的朋友圈数据，按动态 id 去重。
 *
 * 为什么必须合并而不是覆盖：
 * 朋友圈历史在微信服务端，本地 sns.db 只保留一个**会滑动的缓存窗口**。
 * 今天导一次是 34 条，三个月后窗口滑走再导一次，可能只剩最近那几条——
 * 如果直接覆盖，之前攒下的记录就被抹掉了，历史永远攒不齐。
 * 合并之后，每次导入都只增不减，窗口滑到哪里就攒到哪里。
 *
 * 同 id 的记录取「后来的那份」：点赞数、评论这些是会变的。
 */
export function mergeWechatSnsPayload(incoming, existing) {
  const inPosts = Array.isArray(incoming?.posts) ? incoming.posts : [];
  const exPosts = Array.isArray(existing?.posts) ? existing.posts : [];
  if (!inPosts.length) {
    return { payload: incoming, added: 0, total: inPosts.length, merged: false };
  }
  if (!exPosts.length) {
    return { payload: incoming, added: inPosts.length, total: inPosts.length, merged: false };
  }

  const keyOf = (post) => String(post?.id ?? post?.tid ?? '').trim();
  // 时间字段名不统一：契约形状用 time，工具导出用 createTime，还可能是 create_time / ts。
  // 排序只决定展示顺序，所以这里只要能比大小就行，毫秒要折成秒。
  const timeOf = (post) => {
    const raw = post?.time ?? post?.create_time ?? post?.createTime ?? post?.ts;
    const n = Number(raw);
    if (!Number.isFinite(n) || n === 0) return 0;
    return n > 1e11 ? Math.floor(n / 1000) : n;
  };
  const byId = new Map();
  for (const post of exPosts) {
    const key = keyOf(post);
    if (key) byId.set(key, post);
  }

  let added = 0;
  for (const post of inPosts) {
    const key = keyOf(post);
    if (!key) continue;
    if (!byId.has(key)) added += 1;
    byId.set(key, post);
  }

  const posts = [...byId.values()].sort((a, b) => timeOf(b) - timeOf(a));
  const payload = { ...existing, ...incoming, posts, postCount: posts.length };
  return { payload, added, total: posts.length, merged: true };
}
