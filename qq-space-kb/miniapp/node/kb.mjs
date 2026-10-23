// QQ 空间说说知识库 · 领域核心
//
// 纯 JavaScript 实现，不依赖任何第三方包：
//   - 合并 QZoneExport JSON 与 QQ-Zone-Restore-Archive 导出数据
//   - 从说说 ID 反解原始发布时间（对齐 Rust 侧 mood_cell_id_published_at）
//   - 切 L1 明细知识块 / L2 年度画像块
//   - 中文友好的 BM25 检索（字符二元组，无需分词器）
//   - 接地校验：答案必须落在检索到的上下文里

export const QZONE_LAUNCH_TS = 1104537600; // 2005-01-01 UTC

/**
 * 知识库里查不到时的固定话术。
 *
 * Mini App 与 MCP 服务器共用这一份，避免两处各写一个字符串以后漂移。
 * 「不知道」也是一句回答，不该是报错或沉默。
 */
export const FALLBACK_ANSWER = '当时的我还不知道这是什么意思';
export const HISTORY_FEED_PREFIX = 'history-v2-event:';
export const HISTORY_CELL_PREFIX = 'history-v2:';
export const HISTORY_GUESTBOOK_PREFIX = 'history-guestbook:';

export const TIME_SOURCE = {
  EXACT: 'exact',
  FROM_ID: 'from-mood-id',
  INTERACTION: 'interaction-approx',
  UNKNOWN: 'unknown',
};

/**
 * 微信朋友圈记录的 ID 前缀（2.0）。
 *
 * 朋友圈与 QQ 空间是**两个来源的同一种记录**，走同一套合并/切块/检索链路。
 * ID 加前缀是为了让 mergeRecords 的去重逻辑天然不碰撞——
 * 不用改 1.0 的任何一行合并代码。
 */
export const WX_ID_PREFIX = 'wx-';
export const WX_SOURCE = 'wechat-sns';
export const WX_KIND = 'moments';

/** 这条记录是不是朋友圈来的。 */
export function isWxRecord(record) {
  return String(record?.id ?? '').startsWith(WX_ID_PREFIX);
}

const TAG_RE = /<[^>]+>/g;
const BB_RE = /\[([^\[\]]{1,12})\]/g;
const WS_RE = /\s+/g;
const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'",
};

/** 清掉 HTML / BBCode / 实体，压成单行纯文本。 */
export function cleanText(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  for (const [entity, char] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(char);
  }
  text = text.replace(TAG_RE, '').replace(BB_RE, '$1');
  text = text.replace(/[-‍﻿]/g, '');
  return text.replace(WS_RE, ' ').trim();
}

export function truncate(text, limit) {
  const value = String(text ?? '').trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * 从 QQ 空间标准说说 ID 反解原始发布时间。
 * 前 8 位十六进制 = 小端 u32 = 空间主人 QQ 号；后 8 位 = 小端 u32 = 发布时间戳。
 */
export function moodCellIdPublishedAt(cellId, ownerUin, eventTime = 0) {
  const id = String(cellId ?? '');
  if (id.length < 16 || !/^[0-9a-fA-F]{16}/.test(id)) return null;
  const bytes = Buffer.from(id.slice(0, 16), 'hex');
  const encodedOwner = bytes.readUInt32LE(0);
  const publishedAt = bytes.readUInt32LE(4);
  // QQ 号可能带前导 0（如 cookie 里的 'o0123456789'），比较时统一按数字算
  if (encodedOwner !== Number(ownerUin)) return null;
  if (publishedAt < QZONE_LAUNCH_TS) return null;
  if (eventTime > 0 && publishedAt > eventTime) return null;
  return publishedAt;
}

/**
 * 从 QQ 空间标准说说 ID 里读出**作者**的 QQ 号。
 *
 * ID 前 8 位十六进制 = 小端 u32 = 作者 QQ 号。
 * 互动卡片里混着「我评论过的别人的动态」，靠这个判断内容到底是谁发的。
 */
export function moodCellIdOwnerUin(cellId) {
  const id = String(cellId ?? '');
  if (id.length < 16 || !/^[0-9a-fA-F]{16}/.test(id)) return 0;
  return Buffer.from(id.slice(0, 16), 'hex').readUInt32LE(0);
}

/**
 * 这个 cell_id 有可能是一条「说说」吗？
 *
 * 真正的说说 ID 是 24 位十六进制（如 `b327e6725f60718293a4b5c`）。
 * 我们自己合成的占位 ID（正文没捞回来、但发布时间能从 feed 反解的那些）
 * 带 `history-v2:` / `history-guestbook:` 前缀。
 *
 * 其它形态都不是说说——最典型的是互动中心**留言板**卡片用的哨兵 `richinfo`，
 * 它带的是别人在我留言板上的留言。放进知识库等于让 bot 替别人说话。
 */
export function isPlausibleCellId(cellId) {
  const id = String(cellId ?? '').trim();
  if (!id) return false;
  if (/^[0-9a-f]{24}$/i.test(id)) return true;
  if (id.startsWith(HISTORY_CELL_PREFIX)) return true;
  if (id.startsWith(HISTORY_GUESTBOOK_PREFIX)) return true;
  if (id.startsWith(HISTORY_FEED_PREFIX)) return true;
  return false;
}

/** 各种时间表达 → unix 秒；不可解析返回 0。 */
export function toTimestamp(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'boolean') return 0;
  if (typeof value === 'number') {
    const ts = Math.floor(value > 1e10 ? value / 1000 : value);
    return ts >= QZONE_LAUNCH_TS ? ts : 0;
  }
  const text = String(value).trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return toTimestamp(Number(text));
  const normalized = text
    .replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '')
    .replace(/\//g, '-').replace(/\./g, '-');
  const match = normalized.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return 0;
  const [, y, mo, d = '1', h = '0', mi = '0', s = '0'] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const ts = Math.floor(date.getTime() / 1000);
  return ts >= QZONE_LAUNCH_TS ? ts : 0;
}

export function formatTimestamp(ts, withTime = true) {
  if (!ts) return '';
  const date = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${ymd} ${pad(date.getHours())}:${pad(date.getMinutes())}` : ymd;
}

export function yearKey(ts) {
  return ts ? String(new Date(ts * 1000).getFullYear()) : 'unknown';
}

export function monthKey(ts) {
  if (!ts) return 'unknown';
  const date = new Date(ts * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function emptyRecord() {
  return {
    id: '',
    ids: [],
    sources: [],
    kind: 'shuoshuo',
    recovered: false,
    body_missing: false,
    published_at: 0,
    time_source: TIME_SOURCE.UNKNOWN,
    first_interaction_at: 0,
    content: '',
    images: [],
    videos: [],
    location: '',
    like_count: 0,
    // 评论数 / 转发数与赞数分开记。
    // 踩过的坑：导出工具的 `like_count` 抓的是**转发**数（原始串「评论(20)转发(490)」里
    // 490 是转发），赞数要从页面 DOM 的 `a.qz_like_btn`（文本形如「赞(345)」）单独取。
    // 三个数混在一起，画像就会报出「55 万赞」这种对不上的结论。
    comment_count: 0,
    forward_count: 0,
    like_users: [],
    comments: [],
    post_url: '',
    forward_from: '',
    raw: {},
  };
}

function mergeInto(base, other) {
  if (!other) return base;
  if (!base.id && other.id) base.id = other.id;
  for (const key of ['ids', 'sources', 'images', 'videos']) {
    const merged = [...(base[key] ?? [])];
    for (const item of other[key] ?? []) {
      if (!merged.includes(item)) merged.push(item);
    }
    base[key] = merged;
  }
  for (const key of ['content', 'location', 'post_url', 'forward_from']) {
    if (!base[key] && other[key]) base[key] = other[key];
  }
  base.like_count = Math.max(Number(base.like_count ?? 0), Number(other.like_count ?? 0));
  base.comment_count = Math.max(Number(base.comment_count ?? 0), Number(other.comment_count ?? 0));
  base.forward_count = Math.max(Number(base.forward_count ?? 0), Number(other.forward_count ?? 0));
  base.recovered = Boolean(base.recovered) || Boolean(other.recovered);
  base.body_missing = !(base.content ?? '').trim();
  base.published_at = Math.max(Number(base.published_at ?? 0), Number(other.published_at ?? 0));
  const times = [base.first_interaction_at, other.first_interaction_at].filter((v) => Number(v) > 0);
  base.first_interaction_at = times.length ? Math.min(...times) : 0;
  if (base.time_source === TIME_SOURCE.UNKNOWN && other.time_source) base.time_source = other.time_source;

  const seen = new Set((base.comments ?? []).map((c) => `${c.nick}\u0000${c.content}`));
  for (const comment of other.comments ?? []) {
    const key = `${comment.nick}\u0000${comment.content}`;
    if (!seen.has(key)) {
      seen.add(key);
      base.comments.push(comment);
    }
  }
  const seenUsers = new Set((base.like_users ?? []).map((u) => `${u.uin}\u0000${u.nick}`));
  for (const user of other.like_users ?? []) {
    const key = `${user.uin}\u0000${user.nick}`;
    if (!seenUsers.has(key)) {
      seenUsers.add(key);
      base.like_users.push(user);
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// 数据源 A：QZoneExport JSON
// ---------------------------------------------------------------------------
function pickComments(item) {
  for (const key of ['custom_comments', 'commentlist', 'conlist']) {
    const raw = item[key];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const comments = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const content = cleanText(entry.content);
      if (!content) continue;
      const user = entry.user && typeof entry.user === 'object' ? entry.user : {};
      const replies = [];
      for (const reply of entry.replys ?? entry.replies ?? []) {
        if (!reply || typeof reply !== 'object') continue;
        const replyText = cleanText(reply.content);
        if (!replyText) continue;
        replies.push({
          nick: reply.nick || user.nick || '匿名',
          content: replyText,
          created_at: toTimestamp(reply.createTime ?? reply.date),
        });
      }
      comments.push({
        nick: entry.nick || user.nick || '匿名',
        content,
        created_at: toTimestamp(entry.createTime ?? entry.date),
        replies,
      });
    }
    if (comments.length) return comments;
  }
  return [];
}

function pickLikes(item) {
  const likes = [];
  for (const entry of item.likes ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const user = entry.user && typeof entry.user === 'object' ? entry.user : {};
    likes.push({ uin: String(entry.fuin ?? user.uin ?? ''), nick: entry.nick || user.nick || '' });
  }
  return likes;
}

function pickLocation(item) {
  const lbs = item.lbs;
  if (lbs && typeof lbs === 'object') {
    const parts = [lbs.address, lbs.name, lbs.idname].map(cleanText).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  return cleanText(item.location);
}

function pickMedia(items, keys) {
  const urls = [];
  if (!Array.isArray(items)) return urls;
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of keys) {
      const url = entry[key];
      if (typeof url === 'string' && url.trim()) {
        const full = url.startsWith('//') ? `https:${url}` : url.trim();
        if (!urls.includes(full)) urls.push(full);
        break;
      }
    }
  }
  return urls;
}

/** 解析 QZoneExport 的 messages.json（接受数组或 {messages:[...]}）。 */
export function parseQzoneExport(payload) {
  let items = payload;
  if (payload && !Array.isArray(payload) && typeof payload === 'object') {
    const found = ['messages', 'data', 'items', 'list'].find((key) => Array.isArray(payload[key]));
    items = found ? payload[found] : [];
  }
  if (!Array.isArray(items)) return [];

  const records = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const tid = String(item.tid ?? '').trim();
    const content = cleanText(item.custom_content || item.content || '');
    if (!tid && !content) continue;

    let publishedAt = toTimestamp(item.created_time);
    if (!publishedAt) publishedAt = toTimestamp(item.custom_create_time);

    const record = emptyRecord();
    record.id = tid;
    record.ids = tid ? [tid] : [];
    record.sources = ['qzoneexport'];
    record.published_at = publishedAt;
    record.time_source = publishedAt ? TIME_SOURCE.EXACT : TIME_SOURCE.UNKNOWN;
    record.content = content;
    record.images = pickMedia(item.pic, ['hd_url', 'b_url', 'url', 'origin_url']);
    record.videos = pickMedia(item.video, ['play_url', 'url', 'video_url']);
    record.location = pickLocation(item);
    // 赞数：导出工具的 like_count 是**转发**数，赞数要从 DOM 的「赞(N)」单独取。
    // 所以 likeTotal 优先；只有它缺失时才退回 like_count（宁可少也别转发当赞）。
    record.like_count = Number(item.likeTotal ?? 0);
    record.forward_count = Number(item.fwdnum ?? item.forward_count ?? 0);
    record.like_users = pickLikes(item);
    record.comments = pickComments(item);
    // 评论正文没抓到时，条数仍然算数（工具的 comment_count 是准的）。
    record.comment_count = Math.max(Number(item.cmtnum ?? item.comment_count ?? 0), record.comments.length);
    record.post_url = cleanText(item.post_url);
    record.forward_from = cleanText(item.rt_uinname);
    const interactionTimes = record.comments.map((c) => c.created_at).filter((v) => v > 0);
    record.first_interaction_at = interactionTimes.length ? Math.min(...interactionTimes) : 0;
    records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// 数据源 B：QQ-Zone-Restore-Archive（已转换的 JSON 快照）
// ---------------------------------------------------------------------------
function archivePictures(value) {
  const urls = [];
  const pics = value?.picdata?.pic;
  if (!Array.isArray(pics)) return urls;
  for (const pic of pics) {
    if (!pic || typeof pic !== 'object') continue;
    const candidates = [];
    if (Array.isArray(pic.photourl)) candidates.push(...pic.photourl.filter((v) => typeof v === 'string'));
    else if (pic.photourl && typeof pic.photourl === 'object') {
      candidates.push(...Object.values(pic.photourl).filter((v) => typeof v === 'string'));
    }
    for (const name of ['rawUrl', 'origin_url', 'url3', 'url2', 'url1', 'url', 'smallurl']) {
      if (typeof pic[name] === 'string' && pic[name].trim()) candidates.push(pic[name].trim());
    }
    for (const url of candidates) {
      const full = url.startsWith('//') ? `https:${url}` : url;
      if (full && !urls.includes(full)) {
        urls.push(full);
        break;
      }
    }
  }
  return urls;
}

function archiveVideos(value) {
  const urls = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const name of ['videourl', 'url3', 'url2', 'actionurl', 'playurl', 'url']) {
      const raw = node[name];
      if (typeof raw === 'string' && raw.trim()) {
        const full = raw.trim().startsWith('//') ? `https:${raw.trim()}` : raw.trim();
        if (!urls.includes(full)) urls.push(full);
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(value);
  return urls;
}

function archiveComments(commentsJson, fallbackNick, fallbackUin, fallbackTime) {
  if (!commentsJson) return [];
  let value = commentsJson;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== 'object') return [];

  const build = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const content = cleanText(entry.content);
    if (!content) return null;
    const user = entry.user && typeof entry.user === 'object' ? entry.user : {};
    const replies = [];
    for (const reply of entry.replys ?? []) {
      const built = build(reply);
      if (built) replies.push(built);
    }
    return {
      nick: cleanText(user.nickname) || fallbackNick || '匿名',
      uin: String(user.uin ?? fallbackUin ?? ''),
      content,
      created_at: toTimestamp(entry.date) || fallbackTime,
      replies,
    };
  };

  const comments = [];
  const main = build(value.main_comment);
  if (main) comments.push(main);
  for (const entry of value.comments ?? []) {
    const built = build(entry);
    if (built && !comments.some((c) => c.content === built.content && c.nick === built.nick)) {
      comments.push(built);
    }
  }
  return comments;
}

/**
 * 解析归档库快照。
 * 支持两种形态：
 *   1) { dynamics: [...], feeds: [...] }  —— 由 SQLite 转换而来的结构化快照
 *   2) 数组 —— 已经是 dynamics 形态
 */
export function parseQzoneArchive(payload, ownerUin = '') {
  if (!payload) return [];
  const dynamics = Array.isArray(payload) ? payload : (payload.dynamics ?? []);
  const feeds = Array.isArray(payload) ? [] : (payload.feeds ?? []);

  const interactions = new Map();
  for (const feed of feeds) {
    const cellId = feed.cell_id ?? feed.cellId;
    if (!cellId) continue;
    if (!interactions.has(cellId)) {
      interactions.set(cellId, { comments: [], like_users: [], times: [] });
    }
    const bucket = interactions.get(cellId);
    const eventTime = Number(feed.event_time ?? feed.eventTime ?? 0);
    if (eventTime) bucket.times.push(eventTime);
    const eventType = Number(feed.event_type ?? feed.eventType ?? 0);
    if (eventType === 2 || eventType === 311) {
      const comments = archiveComments(
        feed.comments_json ?? feed.commentsJson,
        feed.actor_name ?? feed.actorName ?? '',
        feed.actor_uin ?? feed.actorUin ?? '',
        eventTime,
      );
      for (const comment of comments) {
        if (!comment.content && feed.event_summary) comment.content = cleanText(feed.event_summary);
        if (comment.content) bucket.comments.push(comment);
      }
    } else if (eventType === 217) {
      bucket.like_users.push({
        uin: String(feed.actor_uin ?? feed.actorUin ?? ''),
        nick: cleanText(feed.actor_name ?? feed.actorName ?? ''),
      });
    }
  }

  const records = [];
  for (const row of dynamics) {
    if (!row || typeof row !== 'object') continue;
    const cellId = String(row.cell_id ?? row.cellId ?? '');
    const content = cleanText(row.content);
    if (!content && !cellId) continue;

    // cell_id 必须长得像一条说说的 ID（24 位十六进制），或者是我们自己
    // 合成的占位 ID。别的形态一律丢掉。
    //
    // 踩过的坑：互动中心的**留言板**卡片用一个叫 `richinfo` 的哨兵 cell_id，
    // 它带的是**别人在我留言板上的留言**（"×××：以后生个娃儿……"）。
    // 收进来的话，bot 会把别人写的留言当成「我说过的话」讲出来——
    // 比漏回溯一条严重得多（旧库就因此多出一条 2026 年的假记录）。
    if (!isPlausibleCellId(cellId)) continue;

    // 这条内容不是我发的，就别当「我的说说」收进来。
    // 互动残留里混着「我评论过的别人的动态」——cell_id 前 8 位编码的就是作者 QQ 号。
    // 收进来的话，bot 会声称自己发过根本没发过的内容。
    const cellOwner = moodCellIdOwnerUin(cellId);
    const ownerNum = Number(ownerUin);
    if (cellOwner && ownerNum > 0 && cellOwner !== ownerNum) continue;

    let publishedAt = Number(row.published_at ?? row.publishedAt ?? 0);
    // 互动残留里的时间常常是「谁在什么时候赞/评了这条」，不是发布时间。
    // 数据源标明了这一点就照实标成「互动时间近似」，别冒充精确时间。
    const publishedFrom = String(row.published_from ?? row.publishedFrom ?? '');
    let timeSource = publishedAt
      ? (publishedFrom === 'interaction' ? TIME_SOURCE.INTERACTION : TIME_SOURCE.EXACT)
      : TIME_SOURCE.UNKNOWN;
    const feedKey = String(row.feed_key ?? row.feedKey ?? '');
    const recovered = Boolean(row.is_history_residue ?? row.isHistoryResidue)
      || cellId.startsWith(HISTORY_CELL_PREFIX)
      || feedKey.startsWith(HISTORY_FEED_PREFIX);

    const decoded = moodCellIdPublishedAt(cellId, ownerUin, publishedAt);
    if (decoded) {
      if (publishedAt && publishedAt !== decoded) timeSource = TIME_SOURCE.FROM_ID;
      else if (!publishedAt) timeSource = TIME_SOURCE.FROM_ID;
      publishedAt = decoded;
    } else if (cellId.startsWith(HISTORY_CELL_PREFIX) && publishedAt) {
      timeSource = TIME_SOURCE.INTERACTION;
    }

    const bucket = interactions.get(cellId) ?? { comments: [], like_users: [], times: [] };
    const record = emptyRecord();
    record.id = cellId;
    record.ids = cellId ? [cellId] : [];
    record.sources = ['qzone-archive'];
    record.kind = row.category === 'guestbook' ? 'guestbook' : 'shuoshuo';
    record.recovered = recovered;
    // 正文没恢复出来也是一种事实状态，要单独记下来：
    // 这种记录只保留「发过、什么时候发、被谁互动过」，正文一个字都不编。
    record.body_missing = !content;
    record.published_at = publishedAt;
    record.time_source = timeSource;
    record.first_interaction_at = bucket.times.length ? Math.min(...bucket.times) : 0;
    record.content = content;
    record.images = archivePictures(row.pictures_json ?? row.picturesJson);
    record.videos = archiveVideos(row.video_json ?? row.videoJson);
    record.like_count = bucket.like_users.length;
    record.like_users = bucket.like_users;
    record.comments = bucket.comments;
    record.comment_count = bucket.comments.length;
    record.forward_count = 0;
    record.post_url = cellId && !cellId.startsWith(HISTORY_CELL_PREFIX) && !cellId.startsWith(HISTORY_GUESTBOOK_PREFIX)
      ? `https://user.qzone.qq.com/${ownerUin}/mood/${cellId}`
      : '';
    record.raw = { cell_id: cellId, owner_uin: ownerUin, category: row.category };
    records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------
/**
 * 「回溯痕迹」判定。
 *
 * 已删除的说说即使正文没能恢复，「什么时候发过、被谁赞过/评论过、原文链接」
 * 也依然是能确证的事实。这类记录一旦丢掉，recovered 永远是 0，
 * 看起来就像整个回溯功能没做——实际上数据早就捞到手了。
 */
export function isRecoverTrace(record) {
  if (!record || !record.recovered) return false;
  if (!record.body_missing) return true;
  return Boolean(
    record.id
    || record.published_at
    || record.first_interaction_at
    || (record.comments ?? []).length
    || Number(record.like_count ?? 0),
  );
}

export function mergeRecords(records) {
  const merged = new Map();
  const order = [];
  const anonymous = [];
  for (const record of records) {
    const key = record.id ?? '';
    if (!key) {
      anonymous.push(record);
      continue;
    }
    if (!merged.has(key)) {
      merged.set(key, record);
      order.push(key);
    } else {
      mergeInto(merged.get(key), record);
    }
  }
  const result = [...order.map((key) => merged.get(key)), ...anonymous];
  return result
    .filter((record) => (record.content ?? '').trim() || isRecoverTrace(record))
    .sort((a, b) => (a.published_at || 0) - (b.published_at || 0));
}

// ---------------------------------------------------------------------------
// 知识块
// ---------------------------------------------------------------------------
const TIME_LABEL = {
  [TIME_SOURCE.EXACT]: '精确',
  [TIME_SOURCE.FROM_ID]: '由说说ID反解',
  [TIME_SOURCE.INTERACTION]: '互动时间近似',
  [TIME_SOURCE.UNKNOWN]: '未知',
};

export function renderTimeLine(record) {
  if (record.published_at) {
    return `[时间] ${formatTimestamp(record.published_at)}（${TIME_LABEL[record.time_source] ?? record.time_source}）`;
  }
  if (record.first_interaction_at) {
    return `[时间] 未知（发布于 ${formatTimestamp(record.first_interaction_at, false)} 之前，最早可见互动 ${formatTimestamp(record.first_interaction_at)}）`;
  }
  return '[时间] 未知';
}

/**
 * 渲染 L1 明细块。
 * maxChars 必须小于 AstrBot / 多数分块器的 chunk_size，否则超长块被切开，
 * 第二块会丢失 [时间]/[位置] 前缀，召回质量直接崩掉。
 */
export function renderChunk(record, { maxComments = 3, maxCommentLen = 40, maxChars = 900 } = {}) {
  const comments = record.comments ?? [];
  const rawContent = (record.content ?? '').trim();
  // 正文没能恢复时，只渲染能确证的部分，正文位置写明「未能恢复」——
  // 模型对着一个空正文去猜原文，是这个功能最容易出事的地方。
  const bodyContent = rawContent || (record.body_missing ? '（这条说说已删除，正文未能恢复）' : '');
  const build = (commentSlice, body) => {
    const lines = [renderTimeLine(record)];
    // 朋友圈记录要标出来源：模型得知道这条是发在朋友圈的，不是 QQ 空间。
    // 纯 QQ 空间数据不受影响（这一行只在有朋友圈记录时出现）。
    if (isWxRecord(record)) lines.push('[来源] 微信朋友圈');
    if (record.recovered) lines.push('[来源] 已删除后从互动残留恢复');
    if (record.location) lines.push(`[位置] ${record.location}`);
    const likeCount = Number(record.like_count ?? 0);
    const commentCount = Math.max(Number(record.comment_count ?? 0), comments.length);
    const forwardCount = Number(record.forward_count ?? 0);
    if (commentCount || likeCount || forwardCount) {
      // 三个数各是各的：赞 / 评论 / 转发。混在一起模型就会说错。
      const parts = [];
      if (likeCount) parts.push(`${likeCount}个赞`);
      if (commentCount) parts.push(`${commentCount}条评论`);
      if (forwardCount) parts.push(`${forwardCount}次转发`);
      lines.push(`[互动] ${parts.join(' / ')}`);
    }
    lines.push(`[正文] ${body}`);
    if (commentSlice.length) {
      const excerpt = commentSlice
        .map((c) => `${c.nick || '匿名'}: ${truncate(c.content, maxCommentLen)}`)
        .join(' | ');
      lines.push(`[评论摘录] ${excerpt}`);
    }
    if (record.forward_from) lines.push(`[转发自] ${record.forward_from}`);
    if (record.post_url) lines.push(`[原文] ${record.post_url}`);
    return `${lines.join('\n')}\n`;
  };

  for (let count = maxComments; count > 0; count -= 1) {
    for (const commentLen of [maxCommentLen, 20, 10]) {
      const candidate = build(comments.slice(0, count), bodyContent);
      if (candidate.length <= maxChars) return candidate;
    }
  }
  let body = bodyContent;
  let result = build([], body);
  while (result.length > maxChars && body.length > 20) {
    body = body.slice(0, Math.floor(body.length * 0.8));
    result = build([], body);
  }
  return result;
}

export function buildChunks(records, options = {}) {
  const chunks = [];
  for (const record of records) {
    if (record.kind === 'guestbook' && !options.includeGuestbook) continue;
    const content = (record.content ?? '').trim();
    // 回溯记录即使正文没恢复也要成块：否则「已删除后恢复 N 条」永远显示 0。
    if (!content && !isRecoverTrace(record)) continue;
    chunks.push({
      id: record.id,
      text: renderChunk(record, options),
      published_at: record.published_at,
      time_source: record.time_source,
      recovered: Boolean(record.recovered),
      body_missing: Boolean(record.body_missing),
      year: yearKey(record.published_at),
      like_count: Number(record.like_count ?? 0),
      comment_count: Number(record.comment_count ?? (record.comments ?? []).length),
      forward_count: Number(record.forward_count ?? 0),
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// L2 年度画像（纯统计，无需 LLM）
// ---------------------------------------------------------------------------
const STOPWORDS = new Set(
  ('的了是我你他她它们在有和就都而及与也很到说要去会着没看好自己这那什么怎么一个没有我们你们他们她们真的因为所以但是如果还是已经可以哈哈哈哈哈嗯啊哦呀吧呢的话一下时候现在今天昨天明天感觉觉得')
    .split(''),
);

function ngrams(text) {
  const tokens = [];
  for (const run of text.match(/[一-鿿]{2,}/g) ?? []) {
    for (let size = 2; size <= 4; size += 1) {
      for (let i = 0; i + size <= run.length; i += 1) tokens.push(run.slice(i, i + size));
    }
  }
  for (const word of text.match(/[A-Za-z]{3,}/g) ?? []) tokens.push(word.toLowerCase());
  return tokens;
}

export function extractKeywords(texts, limit = 12) {
  const counter = new Map();
  for (const text of texts) {
    for (const token of ngrams(text)) {
      if (STOPWORDS.has(token)) continue;
      if ([...token].some((ch) => STOPWORDS.has(ch))) continue;
      counter.set(token, (counter.get(token) ?? 0) + 1);
    }
  }
  if (texts.length < 4) return { keywords: [], confident: false };
  const candidates = [...counter.entries()].filter(([, count]) => count >= 2);
  candidates.sort((a, b) => b[0].length - a[0].length || b[1] - a[1]);
  const picked = [];
  for (const [token] of candidates) {
    if (picked.some((kept) => token.includes(kept))) continue;
    for (let i = picked.length - 1; i >= 0; i -= 1) {
      if (token.includes(picked[i])) picked.splice(i, 1);
    }
    picked.push(token);
    if (picked.length >= limit) break;
  }
  return { keywords: picked, confident: true };
}

/** 朋友圈卡片类型的人读标签。 */
const WX_CARD_LABEL = {
  link: '链接',
  music: '音乐',
  note: '笔记',
  finder: '视频号',
  finder_live: '直播',
};

function avgContentLength(records) {
  const lengths = records
    .map((r) => String(r.content ?? '').trim())
    .filter((t) => t.length)
    .map((t) => t.length);
  if (!lengths.length) return 0;
  return Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
}

function imageRatio(records) {
  if (!records.length) return 0;
  const withImage = records.filter((r) => (r.images ?? []).length).length;
  return Math.round((withImage / records.length) * 100);
}

/**
 * 朋友圈专属画像维度（2.0）。
 *
 * 朋友圈和 QQ 空间是**两个不同的表达场域**：发圈频率、发布时段、常去的地方、
 * 配图习惯、互动的人是两套分布。混在一起统计会互相稀释——
 * 「最爱去的城市」被两个平台的记录平均掉，就谁也说不准了。
 * 所以朋友圈单独出一组维度，最后补一条「两个平台的表达差」，
 * 让模型能说出「你在朋友圈话更短、但更爱配图」这种只有双源才看得到的结论。
 *
 * 纯 QQ 空间数据时返回空数组——调用方原样拼进去，输出与 1.0 逐字节一致。
 */
export function buildWxDimensions(wxRecords = [], qqRecords = []) {
  const lines = [];
  if (!wxRecords.length) return lines;

  const times = wxRecords.map((r) => r.published_at).filter((t) => t > 0).sort((a, b) => a - b);
  const from = times.length ? formatTimestamp(times[0], false) : '未知';
  const to = times.length ? formatTimestamp(times[times.length - 1], false) : '未知';
  lines.push(`[朋友圈] 共 ${wxRecords.length} 条，跨度 ${from} → ${to}`);

  // 发圈节奏：逐年条数 + 平均频率
  const yearCount = new Map();
  const monthCount = new Map();
  const hourCount = new Map();
  for (const record of wxRecords) {
    if (!record.published_at) continue;
    const y = yearKey(record.published_at);
    yearCount.set(y, (yearCount.get(y) ?? 0) + 1);
    const m = monthKey(record.published_at);
    monthCount.set(m, (monthCount.get(m) ?? 0) + 1);
    const hour = new Date(record.published_at * 1000).getHours();
    const bucket = hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour < 14 ? '中午'
      : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
    hourCount.set(bucket, (hourCount.get(bucket) ?? 0) + 1);
  }
  const yearEntries = [...yearCount.entries()].sort();
  if (yearEntries.length) {
    const perYear = (wxRecords.length / yearEntries.length).toFixed(1);
    lines.push(
      `[朋友圈·发圈节奏] ${yearEntries.map(([y, n]) => `${y} 年 ${n} 条`).join('、')}；平均每年 ${perYear} 条`,
    );
  }
  const peakMonth = [...monthCount.entries()].sort((a, b) => b[1] - a[1])[0];
  if (peakMonth) lines.push(`[朋友圈·最密集的月份] ${peakMonth[0]}（${peakMonth[1]} 条）`);
  const peakHour = [...hourCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const hourTotal = [...hourCount.values()].reduce((a, b) => a + b, 0);
  if (peakHour && hourTotal) {
    lines.push(
      `[朋友圈·发布时段] 最常在${peakHour[0]}发（${peakHour[1]} 条，占 ${Math.round((peakHour[1] / hourTotal) * 100)}%）`,
    );
  }

  // 常出现的位置
  const locationCount = new Map();
  for (const record of wxRecords) {
    if (record.location) locationCount.set(record.location, (locationCount.get(record.location) ?? 0) + 1);
  }
  const topLocations = [...locationCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topLocations.length) {
    lines.push(`[朋友圈·常出现的位置] ${topLocations.map(([loc, n]) => `${loc}(${n}次)`).join('、')}`);
  }

  // 媒体偏好：配图率、带视频率、每条平均几张
  const withImage = wxRecords.filter((r) => (r.images ?? []).length).length;
  const withVideo = wxRecords.filter((r) => (r.videos ?? []).length).length;
  const imageTotal = wxRecords.reduce((sum, r) => sum + (r.images ?? []).length, 0);
  if (withImage || withVideo) {
    const parts = [];
    if (withImage) parts.push(`${Math.round((withImage / wxRecords.length) * 100)}% 配了图`);
    if (withVideo) parts.push(`${Math.round((withVideo / wxRecords.length) * 100)}% 带视频`);
    const extra = withImage ? `，平均每条 ${(imageTotal / withImage).toFixed(1)} 张图` : '';
    lines.push(`[朋友圈·媒体偏好] ${parts.join('、')}${extra}`);
  }

  // 内容类型分布
  const kindCount = new Map();
  for (const record of wxRecords) {
    const cardKind = record.raw?.card_kind ?? '';
    let label = WX_CARD_LABEL[cardKind] ?? '';
    if (!label) {
      if ((record.videos ?? []).length) label = '视频';
      else if ((record.images ?? []).length) label = '图片';
      else label = '文字';
    }
    kindCount.set(label, (kindCount.get(label) ?? 0) + 1);
  }
  const topKinds = [...kindCount.entries()].sort((a, b) => b[1] - a[1]);
  if (topKinds.length) {
    lines.push(
      `[朋友圈·内容类型] ${topKinds.map(([label, n]) => `${label} ${n} 条`).join('、')}`,
    );
  }

  // 互动最多的人（赞 + 评论都算）
  const personCount = new Map();
  for (const record of wxRecords) {
    for (const comment of record.comments ?? []) {
      if (comment.nick) personCount.set(comment.nick, (personCount.get(comment.nick) ?? 0) + 1);
    }
    for (const like of record.like_users ?? []) {
      if (like.nick) personCount.set(like.nick, (personCount.get(like.nick) ?? 0) + 1);
    }
  }
  const topPeople = [...personCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (topPeople.length) {
    lines.push(`[朋友圈·互动最多的人] ${topPeople.map(([name, count]) => `${name}(${count}次)`).join('、')}`);
  }

  // 两个平台的表达差——只有双源才看得到的结论
  if (qqRecords.length) {
    const wxLen = avgContentLength(wxRecords);
    const qqLen = avgContentLength(qqRecords);
    lines.push(
      `[两个平台的表达差] 朋友圈平均 ${wxLen} 字、${imageRatio(wxRecords)}% 配图；`
      + `QQ 空间平均 ${qqLen} 字、${imageRatio(qqRecords)}% 配图`,
    );
  }

  return lines;
}

/**
 * 人物画像（确定性基线）。
 * 完全由全量记录统计得出，不含任何模型生成内容——即使不接大模型，画像层也能用。
 * 作用是给「泛化」一个底座：bot 需要清楚这个人整体是谁，
 * 而不是只能复述检索到的那一两条。
 */
export function buildProfile(records, summaries = []) {
  // 全部说说（含正文未恢复的痕迹）都算数。
  //
  // 踩过的坑：早先只统计「有正文」的记录，于是画像写着「共 40 条说说」「已删除后恢复 1 条」，
  // 而页面上明明显示 85 条、恢复 44 条。模型拿着这份画像说话，自然会跟页面打架。
  const all = records.filter((r) => r.kind !== 'guestbook');
  const posts = all.filter((r) => (r.content ?? '').trim());
  const traces = all.filter((r) => !(r.content ?? '').trim());
  if (!all.length) return null;

  const timestamps = all.map((r) => r.published_at).filter((t) => t > 0).sort((a, b) => a - b);
  const from = timestamps.length ? formatTimestamp(timestamps[0], false) : '未知';
  const to = timestamps.length ? formatTimestamp(timestamps[timestamps.length - 1], false) : '未知';

  const yearCount = new Map();
  for (const record of all) {
    const year = record.published_at ? yearKey(record.published_at) : '时间未知';
    yearCount.set(year, (yearCount.get(year) ?? 0) + 1);
  }
  const ranked = [...yearCount.entries()].sort((a, b) => b[1] - a[1]);
  const peak = ranked[0];

  const locationCount = new Map();
  for (const record of all) {
    if (record.location) locationCount.set(record.location, (locationCount.get(record.location) ?? 0) + 1);
  }
  const topLocations = [...locationCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const personCount = new Map();
  for (const record of all) {
    for (const comment of record.comments ?? []) {
      if (comment.nick) personCount.set(comment.nick, (personCount.get(comment.nick) ?? 0) + 1);
    }
  }
  const topPeople = [...personCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const { keywords } = extractKeywords(posts.map((r) => r.content ?? ''));

  const lengths = posts.map((r) => (r.content ?? '').length).sort((a, b) => a - b);
  const average = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;
  const likeTotal = all.reduce((sum, r) => sum + Number(r.like_count ?? 0), 0);
  const commentTotal = all.reduce(
    (sum, r) => sum + Math.max(Number(r.comment_count ?? 0), (r.comments ?? []).length),
    0,
  );
  const forwardTotal = all.reduce((sum, r) => sum + Number(r.forward_count ?? 0), 0);
  const topPost = posts.reduce(
    (best, r) => (Number(r.like_count ?? 0) > Number(best.like_count ?? 0) ? r : best),
    posts[0],
  );

  const lines = [];
  // 2.0：朋友圈与 QQ 空间是**两种来源**。口径必须条件化——
  // 纯 QQ 空间数据时，这里的输出与 1.0 逐字节一致；
  // 只有朋友圈数据进来，才切到双源说法。
  const wxRecords = all.filter(isWxRecord);
  const qqRecords = all.filter((r) => !isWxRecord(r));
  const hasWx = wxRecords.length > 0;
  // 条数要说清楚「有正文多少」和「只有痕迹多少」，别只报一个有正文的口径。
  const traceNote = traces.length ? `，另有 ${traces.length} 条已删除、正文未恢复` : '';
  if (hasWx) {
    lines.push(
      `[跨度] ${from} → ${to}，共 ${all.length} 条动态（QQ 空间 ${qqRecords.length} 条，微信朋友圈 ${wxRecords.length} 条；其中有正文 ${posts.length} 条${traceNote}）`,
    );
  } else {
    lines.push(`[跨度] ${from} → ${to}，共 ${all.length} 条说说（有正文 ${posts.length} 条${traceNote}）`);
  }
  lines.push(`[年份分布] ${[...yearCount.entries()].sort().map(([y, n]) => `${y} 年 ${n} 条`).join('、')}`);
  if (peak) lines.push(`[最活跃的时期] ${peak[0]} 年，共 ${peak[1]} 条`);
  if (topLocations.length) {
    lines.push(`[常出现的位置] ${topLocations.map(([loc, n]) => `${loc}(${n}次)`).join('、')}`);
  }
  if (topPeople.length) {
    lines.push(`[互动最多的人] ${topPeople.map(([name, count]) => `${name}(${count}次)`).join('、')}`);
  }
  if (keywords.length) lines.push(`[反复出现的话题] ${keywords.join('、')}`);
  if (lengths.length) lines.push(`[表达习惯] 平均每条 ${average} 字，最长 ${lengths[lengths.length - 1]} 字`);
  const interactionParts = [];
  if (likeTotal) interactionParts.push(`${likeTotal} 个赞`);
  if (commentTotal) interactionParts.push(`${commentTotal} 条评论`);
  if (forwardTotal) interactionParts.push(`${forwardTotal} 次转发`);
  if (interactionParts.length) lines.push(`[互动总量] ${interactionParts.join('、')}`);
  // 2.0：朋友圈专属维度。纯 QQ 空间数据时这里是空数组，输出与 1.0 逐字节一致。
  lines.push(...buildWxDimensions(wxRecords, qqRecords));
  if (topPost) {
    lines.push(`[最受欢迎的一条] ${truncate(topPost.content, 40)}（${topPost.like_count} 赞）`);
  }
  // 代表性原文：画像里必须带真话。
  // 一是模型得照着本人原话说话才像本人，二是接地校验靠的是措辞重合——
  // 画像里只有统计数字的话，模型转述出来的话会在校验里被判成「没落在资料里」。
  // 沿时间轴均匀取样，避免全是同一年。
  const samples = [];
  const seenSample = new Set();
  const step = Math.max(1, Math.floor(posts.length / 8));
  for (let i = 0; i < posts.length && samples.length < 8; i += step) {
    const text = (posts[i].content ?? '').trim();
    if (!text || text.length < 4) continue;
    const key = text.slice(0, 12);
    if (seenSample.has(key)) continue;
    seenSample.add(key);
    samples.push(truncate(text, 30));
  }
  if (samples.length) {
    lines.push(`[代表性原文] ${samples.map((s) => `「${s}」`).join('；')}`);
  }
  // 各年代表原文：用户可能问任意一年，画像得让他照着**那一年的原话**回答，
  // 而不是照着别的年份。同时这也让接地校验有据可依——
  // 模型照抄原话时，措辞重合度自然就上去了，不会被误判成「没落在资料里」。
  const byYear = new Map();
  for (const record of posts) {
    const y = yearKey(record.published_at);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(record);
  }
  const yearSamples = [];
  for (const [y, list] of [...byYear.entries()].sort()) {
    const best = list.reduce(
      (b, r) => (Number(r.like_count ?? 0) > Number(b.like_count ?? 0) ? r : b),
      list[0],
    );
    const text = (best.content ?? '').trim();
    if (text.length >= 4) yearSamples.push(`${y} 年：「${truncate(text, 26)}」`);
  }
  if (yearSamples.length) {
    lines.push(`[各年代表原文] ${yearSamples.join('；')}`);
  }
  const recovered = all.filter((r) => r.recovered).length;
  if (recovered) {
    const recoveredNoBody = all.filter((r) => r.recovered && !(r.content ?? '').trim()).length;
    lines.push(
      recoveredNoBody
        ? `[已删除后恢复] ${recovered} 条，其中 ${recoveredNoBody} 条正文未能恢复（只留下发布时间和互动痕迹）`
        : `[已删除后恢复] ${recovered} 条`,
    );
  }
  const undated = all.filter((r) => !r.published_at).length;
  if (undated) lines.push(`[时间不可考] ${undated} 条`);

  const facts = lines.join('\n');
  return {
    id: 'profile',
    year: '',
    text: `[类型] 人物画像（由全量说说统计归纳）\n\n${facts}\n`,
    facts,
    narrative: '',
    source: 'facts',
  };
}

/**
 * 洗掉叙述里含资料外事实的句子。
 * 大模型写人物档案时容易顺手加一个年份或数字，这一步把不成立的句子剔除，
 * 剩下的拼回正文——保住文笔，不让编造混进去。
 */
export function sanitizeNarrative(narrative, sourceText) {
  const sentences = String(narrative ?? '')
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sentences.length) return { text: '', kept: 0, total: 0 };
  const kept = sentences.filter((sentence) => factualTokensGrounded(sentence, sourceText));
  return { text: kept.join('\n').trim(), kept: kept.length, total: sentences.length };
}

export function buildYearSummaries(records) {
  const groups = new Map();
  const undated = [];
  for (const record of records) {
    if (record.kind === 'guestbook') continue;
    if (!record.published_at) {
      undated.push(record);
      continue;
    }
    const key = yearKey(record.published_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  if (undated.length) groups.set('时间未知', undated);

  const summaries = [];
  for (const [key, group] of [...groups.entries()].sort()) {
    const texts = group.map((r) => r.content ?? '');
    const { keywords, confident } = extractKeywords(texts);
    const locationCount = new Map();
    const personCount = new Map();
    let totalLikes = 0;
    let totalComments = 0;
    let totalForwards = 0;
    let recovered = 0;
    let bodyMissing = 0;
    for (const record of group) {
      if (record.location) locationCount.set(record.location, (locationCount.get(record.location) ?? 0) + 1);
      for (const comment of record.comments ?? []) {
        if (comment.nick) personCount.set(comment.nick, (personCount.get(comment.nick) ?? 0) + 1);
      }
      totalLikes += Number(record.like_count ?? 0);
      // 评论正文不一定抓到了，但条数是准的——取两者的较大值。
      totalComments += Math.max(Number(record.comment_count ?? 0), (record.comments ?? []).length);
      totalForwards += Number(record.forward_count ?? 0);
      if (record.recovered) recovered += 1;
      if (record.body_missing) bodyMissing += 1;
    }
    const topLocations = [...locationCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topPeople = [...personCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const groupWx = group.filter(isWxRecord).length;
    const groupQq = group.length - groupWx;
    // 2.0：这一组里混了朋友圈时说「动态」并拆来源；纯 QQ 空间时保持 1.0 原话。
    const title = key === '时间未知'
      ? (groupWx ? '发布时间未知的一组动态' : '发布时间未知的一组说说')
      : `${key} 年`;
    const countText = groupWx
      ? `共留下 ${group.length} 条动态（QQ 空间 ${groupQq} 条，微信朋友圈 ${groupWx} 条）`
      : `共留下 ${group.length} 条说说`;

    const interactionParts = [];
    if (totalLikes) interactionParts.push(`${totalLikes} 个赞`);
    if (totalComments) interactionParts.push(`${totalComments} 条评论`);
    if (totalForwards) interactionParts.push(`${totalForwards} 次转发`);
    let body = `${title}${countText}`
      + (interactionParts.length ? `，累计 ${interactionParts.join('、')}。` : '。');
    if (keywords.length) {
      body += `反复出现的话题关键词：${keywords.join('、')}。`;
    } else if (!confident) {
      body += '该组样本较少，话题分布不易归纳，以下以代表性内容为主。';
    }
    if (topLocations.length) {
      body += `常出现的位置：${topLocations.map(([loc, n]) => `${loc}(${n}次)`).join('、')}。`;
    }
    if (topPeople.length) {
      body += `互动最频繁的人：${topPeople.map(([n, c]) => `${n}(${c}次)`).join('、')}。`;
    }
    if (recovered) body += `其中 ${recovered} 条为已删除后从互动残留恢复的内容。`;
    if (bodyMissing) body += `其中 ${bodyMissing} 条正文未能恢复，只留下了发布时间和互动痕迹。`;
    const samples = texts.filter((t) => t.trim()).slice(0, 3);
    if (samples.length) {
      body += `代表性内容：${samples.map((t) => `「${truncate(t, 30)}」`).join('；')}。`;
    }

    summaries.push({
      id: `summary-${key}`,
      text: `[时间范围] ${title}\n[条数] ${group.length}\n[类型] 年度画像摘要\n\n${body}\n`,
      year: key,
      count: group.length,
    });
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// 检索：中文友好的 BM25
// ---------------------------------------------------------------------------

/**
 * 全库速览：每条记录一行（日期 + 正文摘录）。
 *
 * 检索落空时用它把整个知识库摊给模型——「我是个什么样的人」这种问题
 * 检索不到任何具体说说，但只要把全库摆出来，模型自己就能答。
 * 早先的闸门是「检索不到就拒答」，问法一变就答不上，灵活度全丢在这。
 */
export function buildKbDigest(records, { maxChars = 60 } = {}) {
  const lines = [];
  const sorted = [...records].sort((a, b) => (b.published_at || 0) - (a.published_at || 0));
  for (const record of sorted) {
    if (record.kind === 'guestbook') continue;
    const date = record.published_at ? formatTimestamp(record.published_at, false) : '时间未知';
    const body = (record.content ?? '').trim();
    const text = body ? truncate(body, maxChars) : '（已删除，正文未恢复）';
    const flag = record.recovered ? ' · 已删除后恢复' : '';
    lines.push(`${date}${flag} · ${text}`);
  }
  return lines.join('\n');
}

/**
 * 接地校验的对照文本：**整个知识库**。
 *
 * 早先只拿「本轮检索到的那几块」当对照，于是模型提到知识库里真实存在、
 * 但这轮没检索到的东西（比如 2022 年）时会被误判成编造——
 * 看起来像「知识库里没有」，其实是有。
 * 事实红线的标准应该是「在知识库里能查到出处」，不是「在这几块里出现过」。
 */
export function buildGroundingText(records, summaries = [], profileText = '') {
  const parts = [];
  if (profileText) parts.push(String(profileText));
  for (const summary of summaries) {
    if (summary?.text) parts.push(String(summary.text));
  }
  for (const record of records) {
    if (record.kind === 'guestbook') continue;
    const date = record.published_at ? formatTimestamp(record.published_at, false) : '时间未知';
    const body = (record.content ?? '').trim() || '（已删除，正文未恢复）';
    const bits = [date, body];
    if (record.location) bits.push(String(record.location));
    if (record.like_count) bits.push(`${record.like_count} 个赞`);
    if (record.comment_count) bits.push(`${record.comment_count} 条评论`);
    if (record.forward_count) bits.push(`${record.forward_count} 次转发`);
    for (const comment of record.comments ?? []) {
      if (comment.content) bits.push(`${comment.nick || '匿名'}：${comment.content}`);
    }
    parts.push(bits.join(' '));
  }
  return parts.join('\n');
}

export function tokenize(text) {
  const tokens = [];
  const lower = String(text ?? '').toLowerCase();
  for (const run of lower.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.push(run.slice(i, i + 2));
    if (run.length <= 4) tokens.push(run);
  }
  for (const word of lower.match(/[a-z0-9]{2,}/g) ?? []) tokens.push(word);
  return tokens;
}

export function buildIndex(chunks) {
  const documents = chunks.map((chunk, id) => {
    const tokens = tokenize(chunk.text);
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { id, tokens, counts, length: tokens.length, chunk };
  });
  const df = new Map();
  for (const doc of documents) {
    for (const token of doc.counts.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  }
  return { documents, df, avgLength: documents.length ? documents.reduce((s, d) => s + d.length, 0) / documents.length : 0 };
}

/** BM25 检索。返回 [{ chunk, score }]，按分数降序。 */
const QUERY_STOPWORDS = new Set(
  ('什么怎么哪吗呢吧啊哦嗯呀我你他她它们的是了在有和就都而及与也很到说要去会着没看好这那一个下么时候现今天昨明感觉觉得忙干做事情年')
    .split(''),
);

/**
 * 从问句里剥掉问法词，只留实义内容。
 * 「2018 年我在忙什么」去掉问法词后只剩「2018」——不去掉的话，
 * 「我在忙」这些通用词会稀释 BM25 分数，把明明存在的年份记录判成查不到。
 */
export function normalizeQuery(query) {
  const src = String(query ?? '');
  const parts = [];
  for (const run of src.match(/[一-鿿]+/g) ?? []) {
    const stripped = [...run].filter((ch) => !QUERY_STOPWORDS.has(ch)).join('');
    if (stripped.length >= 2) parts.push(stripped);
  }
  for (const word of src.match(/[a-z0-9][a-z0-9._-]*/gi) ?? []) parts.push(word);
  return parts.join(' ');
}

export function search(index, query, topK = 6) {
  if (!index.documents.length) return [];
  const queryTokens = [...new Set(tokenize(normalizeQuery(query)))];
  if (!queryTokens.length) return [];
  const N = index.documents.length;
  const k1 = 1.5;
  const b = 0.75;
  const results = [];
  for (const doc of index.documents) {
    let score = 0;
    let matched = 0;
    for (const token of queryTokens) {
      const tf = doc.counts.get(token) ?? 0;
      if (!tf) continue;
      matched += 1;
      const df = index.df.get(token) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * (doc.length / (index.avgLength || 1))));
      score += idf * norm;
    }
    if (!matched) continue;
    // 命中查询词的比例参与排序，覆盖"部分命中"的块
    const coverage = matched / queryTokens.length;
    results.push({ chunk: doc.chunk, score: score * (0.5 + 0.5 * coverage), matched, coverage });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

/**
 * 检索置信度：低于阈值认为"知识库里没有"，直接走固定话术。
 * 阈值同时考虑绝对分数与查询词覆盖率，避免长查询被少数高频词撑起来。
 */
export function isConfident(hits, query) {
  if (!hits.length) return false;
  const top = hits[0];
  const queryTokens = new Set(tokenize(normalizeQuery(query)));
  if (queryTokens.size === 0) return false;
  const hitTokens = new Set(tokenize(top.chunk.text));
  let overlap = 0;
  for (const token of queryTokens) if (hitTokens.has(token)) overlap += 1;
  const coverage = overlap / queryTokens.size;
  if (top.score >= 2.0 && (coverage >= 0.25 || top.coverage >= 0.6)) return true;

  // 纯年份直问：剥掉问法词后只剩年份（如「2018 年我在忙什么」）。
  // 年份是强检索信号，但只命中一个词时 BM25 分数天然偏低，所以按年份直接定位。
  // 注意这里要求归一化后**只剩**年份——「2019 年特斯拉续航」还带着别的内容，
  // 走上面的常规判定，查不到就回固定话术。
  const yearOnly = normalizeQuery(query).match(/^(\d{4})$/);
  if (yearOnly) {
    const year = yearOnly[1];
    if (hits.some((hit) => String(hit.chunk.year ?? '') === year)) return true;
  }
  return false;
}

/**
 * 「我是什么样的人」这类问法的识别。
 *
 * 这类问题问不出任何实义词——「我是个什么样的人」剥掉问法词只剩「个什么样人」，
 * BM25 命中不了任何一条具体说说，于是被检索闸门挡在外面，bot 只能回固定话术，
 * 看起来就「不会泛化」。
 *
 * 但它们的答案就在人物画像里：画像本来就是从全量说说归纳出来的，
 * 是知识库的一部分，只是走的不是逐条检索这条路。所以单独识别出来，交给画像回答。
 *
 * 判定刻意保守：必须同时出现「自指」和「性格/生活类」特征，
 * 避免把「我昨天吃饭了吗」这种也放进画像回答通道。
 */
const SELF_QUESTION_PATTERNS = [
  /什么样的人/,
  /我是谁/,
  /我(?:这人|是(?:个|一个)怎样|算(?:个|一个)什么)/,
  /我(?:的)?(?:性格|个性|脾气|心思)/,
  /我(?:说话|讲话)(?:方式|习惯|风格|语气)/,
  /我(?:过得|过的是|的日子|的生活|的状态)/,
  /我(?:的)?(?:那几年|这几年|那会儿)(?:过得|是什么样|怎么样|如何)/,
  /(?:你)?(?:了解|认识|记得)我/,
  /我(?:喜欢|讨厌|爱|恨)(?:什么|啥|哪些)/,
  /说说(?:我的|我)/,
  /(?:概括|总结|评价)(?:一下)?我/,
];

export function isSelfCharacterQuestion(query) {
  const text = String(query ?? '').trim();
  if (!text) return false;
  if (!text.includes('我')) return false;
  return SELF_QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// 接地校验
// ---------------------------------------------------------------------------
/**
 * 检查答案里的内容词是否落在检索上下文中。
 * 命中不足说明模型在编造，调用方应改用固定话术。
 */
export function groundingRatio(answer, context) {
  const answerTokens = new Set(
    tokenize(answer).filter((token) => token.length >= 2 && !STOPWORDS.has(token)),
  );
  if (!answerTokens.size) return 0;
  const contextTokens = new Set(tokenize(context));
  let hit = 0;
  for (const token of answerTokens) if (contextTokens.has(token)) hit += 1;
  return hit / answerTokens.size;
}

const CN_DIGITS = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字转阿拉伯数字（支持 十/百/千/万 组合），转不了返回 null。 */
function chineseToNumber(text) {
  let total = 0;
  let section = 0;
  let current = 0;
  let matched = false;
  for (const ch of String(text ?? '')) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch];
      matched = true;
    } else if (ch === '十') {
      section += (current || 1) * 10;
      current = 0;
      matched = true;
    } else if (ch === '百') {
      section += (current || 1) * 100;
      current = 0;
      matched = true;
    } else if (ch === '千') {
      section += (current || 1) * 1000;
      current = 0;
      matched = true;
    } else if (ch === '万') {
      total += (section + current || 1) * 10000;
      section = 0;
      current = 0;
      matched = true;
    } else {
      return null;
    }
  }
  if (!matched) return null;
  return total + section + current;
}

function pad2(value) {
  return String(Number(value)).padStart(2, '0');
}

/**
 * 「X 多」型模糊量。
 *
 * 中文里「五十多万」说的是一个**区间**（50 万到 60 万之间），不是 500000 这个点。
 * 模型用它描述 543000 是**准确**的，拿点值去比会误杀一条有据的回答；
 * 按区间比才对。实测：库里 543000，回答「五十多万」——点值判不过，区间判得过。
 */
const VAGUE_DIGIT_RE = /(\d+(?:\.\d+)?)\s*(万|亿|千|[kKwWmM])\s*多/g;
const VAGUE_CHINESE_RE = /([零一二两三四五六七八九十百千万]+)多/g;

function maskRange(text, start, end) {
  return text.slice(0, start) + ' '.repeat(Math.max(0, end - start)) + text.slice(end);
}

/**
 * 文本里的数字事实。只保留量级 ≥ 10 的：个位数噪声太大，
 * 「第 3 条」「一次」「一起」之类不该被判成编造。
 *
 * 同时识别「X 多」型模糊量。模糊量按**区间**判，
 * 并且从点值里抹掉——同一个词既当点又当区间会被判两次。
 */
function extractNumberFacts(text) {
  const values = new Set();
  const ranges = [];
  // 先剥掉 URL 和「含字母的长 hex 串」（cell_id 之类）。
  // 不剥的话，cell_id「…3c0500」里的「500」会被当成资料里出现过的数字事实，
  // 于是「我欠了同学 500 块」这种编造能蒙混过关——红线就漏了。
  // 纯数字的长串（手机号之类）保留，它们同样是可验证的事实。
  const src = String(text ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[0-9a-f]{12,}/gi, (m) => (/[a-f]/i.test(m) ? ' ' : m))
    .replace(/[,，]/g, '');

  // 模糊量先摘出来，并把对应片段从正文里抹掉（留同长空格，位置不变）。
  let masked = src;
  for (const match of src.matchAll(VAGUE_DIGIT_RE)) {
    const scale = NUMBER_UNIT_SCALE[match[2]] ?? NUMBER_UNIT_SCALE[match[2].toLowerCase()];
    if (!scale) continue;
    const value = Number(match[1]) * scale;
    if (!Number.isFinite(value) || value < 10) continue;
    ranges.push([value, value + scale]);
    masked = maskRange(masked, match.index, match.index + match[0].length);
  }
  for (const match of src.matchAll(VAGUE_CHINESE_RE)) {
    const raw = match[1];
    const value = chineseToNumber(raw);
    if (value === null || value < 10) continue;
    const last = raw[raw.length - 1];
    const unitSize = last === '亿' ? 1e8 : last === '万' ? 1e4 : last === '千' ? 1e3 : last === '百' ? 1e2 : 10;
    ranges.push([value, value + unitSize]);
    masked = maskRange(masked, match.index, match.index + match[0].length);
  }

  // 带单位的先算成基准值：「326 万」→ 3260000。
  // 模型很自然会把 3261887 写成「326 万」，这不是编造，是四舍五入。
  for (const match of masked.matchAll(/(\d+(?:\.\d+)?)\s*(万|亿|千|[kKwWmM])/g)) {
    const raw = Number(match[1]);
    const scale = NUMBER_UNIT_SCALE[match[2]] ?? NUMBER_UNIT_SCALE[match[2].toLowerCase()];
    if (!scale) continue;
    const value = raw * scale;
    if (Number.isFinite(value) && value >= 10) values.add(value);
  }
  for (const match of masked.matchAll(/\d+(?:\.\d+)?/g)) {
    const value = Number(match[0]);
    if (Number.isFinite(value) && value >= 10) values.add(value);
  }
  for (const match of masked.matchAll(/[零一二两三四五六七八九十百千万]+/g)) {
    // 只认带量级的：「一万」「两千」有效；「一」「一起」「十分」不算。
    if (match[0].length < 2 || !/[十百千万]/.test(match[0])) continue;
    const value = chineseToNumber(match[0]);
    if (value !== null && value >= 10) values.add(value);
  }
  return { values, ranges };
}

// 数字单位换算表。模型写「326 万」和资料里的「3261887」指的是同一个数。
const NUMBER_UNIT_SCALE = {
  万: 1e4,
  亿: 1e8,
  千: 1e3,
  k: 1e3,
  w: 1e4,
  m: 1e6,
};

// 换算后的容差：模型四舍五入到「326 万」，和 3261887 差 0.06%。
// 2% 覆盖的是「同一个数的粗写」，不是「差一个量级」——
// 「32 万」和 3261887 差 90%，那是另一个数，该拦。
const NUMBER_EQUIV_TOLERANCE = 0.02;

/**
 * 一个已知数字能撑起哪些「同一个数的不同写法」。
 *
 * 只有**本身就不小的**已知数才允许再放大一档：
 * 否则资料里随便一个「50」都会让「50 万」蒙混过关——
 * 实测就是踩过这个坑：库里有个孤零零的 50，50×1e4=500000，
 * 于是「五十万」靠它蒙混过关了。规则要严，
 * 宁可漏放一次巧合，也不能让红线形同虚设。
 */
function scaleCandidates(known) {
  const candidates = [known];
  if (known >= 1000) candidates.push(known * 1e4, known * 1e8);
  if (known >= 1e5) candidates.push(known / 1e4);
  if (known >= 1e9) candidates.push(known / 1e8);
  return candidates.filter((value) => Number.isFinite(value) && value >= 10);
}

/**
 * 回答里的这个数字，在资料里有出处吗？
 *
 * 逐字比对太死：「3261887」写成「326 万」会被判成编造，
 * 于是有据可依的回答被拦下——看起来像「知识库里没有」，其实是有。
 * 所以按「同一个数的不同写法」来判：单位换算 + 2% 的四舍五入容差。
 */
export function numberGrounded(value, ctxNumbers) {
  if (!Number.isFinite(value)) return true;
  if (ctxNumbers.has(value)) return true;
  for (const known of ctxNumbers) {
    if (!Number.isFinite(known) || known <= 0) continue;
    for (const candidate of scaleCandidates(known)) {
      if (Math.abs(value - candidate) / candidate <= NUMBER_EQUIV_TOLERANCE) return true;
    }
  }
  return false;
}

/**
 * 模糊量区间在资料里有出处吗？
 *
 * 「五十多万」= [500000, 600000)，只要资料里有一个数落在这个区间就算有据。
 * 库里有 543000 → 「五十多万」准确，成立。
 * 库里有 39 → 「五十多万」不成立，拦。
 */
export function rangeGrounded(min, max, ctxNumbers) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return true;
  for (const known of ctxNumbers) {
    if (!Number.isFinite(known) || known <= 0) continue;
    for (const candidate of scaleCandidates(known)) {
      if (candidate >= min && candidate < max) return true;
    }
  }
  return false;
}

/**
 * 文本里的日期事实。资料侧的时间是 "2015-11-20"，回答侧常写成 "2015 年 11 月 20 日"，
 * 两种写法必须归一化成同一件事，否则会把完全合规的回答误杀。
 */
function extractDateFacts(text) {
  const src = String(text ?? '');
  const years = new Set();
  const yearMonths = new Set();
  const yearMonthDays = new Set();
  const months = new Set();
  const days = new Set();

  // 完整日期：2015年11月20日 / 2015-11-20 / 2015/11/20
  for (const match of src.matchAll(/(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/g)) {
    const year = match[1];
    const month = pad2(match[2]);
    const day = pad2(match[3]);
    years.add(year);
    months.add(month);
    days.add(day);
    yearMonths.add(`${year}-${month}`);
    yearMonthDays.add(`${year}-${month}-${day}`);
  }
  // 年 + 月：2015年11月
  for (const match of src.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月/g)) {
    const year = match[1];
    const month = pad2(match[2]);
    years.add(year);
    months.add(month);
    yearMonths.add(`${year}-${month}`);
  }
  // 年：2015年
  for (const match of src.matchAll(/(\d{4})\s*年/g)) years.add(match[1]);
  // 月 + 日：11月20日
  for (const match of src.matchAll(/(?<![0-9])(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    months.add(pad2(match[1]));
    days.add(pad2(match[2]));
  }
  // 单独的月 / 日
  for (const match of src.matchAll(/(?<![0-9])(\d{1,2})\s*月/g)) months.add(pad2(match[1]));
  for (const match of src.matchAll(/(?<![0-9])(\d{1,2})\s*日/g)) days.add(pad2(match[1]));

  return { years, yearMonths, yearMonthDays, months, days };
}

/**
 * 英文虚词：不是专有名词，不该被当成「编造的证据」。
 */
const ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'was', 'were', 'are', 'but', 'not', 'with', 'that', 'this',
  'from', 'have', 'has', 'had', 'his', 'her', 'she', 'him', 'they', 'them', 'their', 'its', 'out',
  'got', 'get', 'one', 'two', 'say', 'said', 'like', 'just', 'also', 'very', 'much', 'many', 'can',
  'will', 'would', 'could', 'should', 'been', 'being', 'than', 'then', 'into', 'over', 'some',
  'such', 'only', 'other', 'more', 'most', 'what', 'when', 'where', 'which', 'who', 'whom', 'how',
  'why', 'all', 'any', 'both', 'each', 'few', 'own', 'same', 'too', 'because', 'before', 'after',
  'above', 'below', 'between', 'during', 'through', 'while', 'against', 'about', 'under', 'again',
  'once', 'here', 'there', 'yes', 'okay', 'yeah', 'hey', 'hello', 'thanks', 'thank', 'please',
  'sorry', 'and', 'the', 'not', 'never', 'always', 'maybe', 'sure', 'well', 'still', 'even',
]);

/**
 * 文本里的外文词（专有名词候选）。
 * iPhone / Tesla / Instagram 这类具体事物，资料里没有就是编的。
 */
function extractLatinFacts(text) {
  const words = new Set();
  const src = String(text ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[0-9a-f]{12,}/gi, ' ');
  for (const match of src.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) {
    words.add(match[0].toLowerCase());
  }
  return words;
}

/**
 * 答案里的疑似外文专名（保留原始大小写）。
 *
 * 判据是「**含大写字母**」而不是「首字母大写」——
 * iPhone 的首字母 i 是小写，按首字母判会漏掉它。
 * 而顺手带出来的普通词（busy、sure、very）全小写，不会被当成编造的证据。
 */
function extractLatinProperNouns(text) {
  const words = new Set();
  const src = String(text ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[0-9a-f]{12,}/gi, ' ');
  for (const match of src.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) {
    if (/[A-Z]/.test(match[0])) words.add(match[0]);
  }
  return words;
}

/**
 * 资料里的中文 n-gram（2 字 / 3 字）。
 * 用来判断答案里提到的人名是不是资料里真有其人。
 */
function contextNgrams(text) {
  const grams = new Set();
  for (const run of String(text ?? '').match(/[一-鿿]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) grams.add(run.slice(i, i + 2));
    for (let i = 0; i + 3 <= run.length; i += 1) grams.add(run.slice(i, i + 3));
  }
  return grams;
}

/**
 * 答案里的时间/数字是否都能在资料里找到，防止编造具体日期、金额、人数。
 * 分级判定：年 / 年月 / 年月日 / 月 / 日 / 数字，逐级对齐，格式差异不误杀。
 */
export function factualTokensGrounded(answer, context) {
  const claim = String(answer ?? '');
  const ctxFacts = extractNumberFacts(context);
  const ctxDates = extractDateFacts(context);
  const ctxNumbers = ctxFacts.values;
  const ctxWords = extractLatinFacts(context);

  // 完整日期必须逐字对上
  for (const match of claim.matchAll(/(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/g)) {
    const year = match[1];
    const month = pad2(match[2]);
    const day = pad2(match[3]);
    if (ctxDates.yearMonthDays.has(`${year}-${month}-${day}`)) continue;
    if (ctxDates.years.has(year) && ctxDates.months.has(month) && ctxDates.days.has(day)) continue;
    return false;
  }
  // 年 + 月
  for (const match of claim.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月/g)) {
    if (ctxDates.yearMonths.has(`${match[1]}-${pad2(match[2])}`)) continue;
    if (ctxDates.years.has(match[1]) && ctxDates.months.has(pad2(match[2]))) continue;
    return false;
  }
  // 年
  for (const match of claim.matchAll(/(\d{4})\s*年/g)) {
    if (!ctxDates.years.has(match[1])) return false;
  }
  // 月 + 日
  for (const match of claim.matchAll(/(?<![0-9])(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    if (!ctxDates.months.has(pad2(match[1])) || !ctxDates.days.has(pad2(match[2]))) return false;
  }
  // 单独的月 / 日
  for (const match of claim.matchAll(/(?<![0-9])(\d{1,2})\s*月/g)) {
    if (!ctxDates.months.has(pad2(match[1]))) return false;
  }
  for (const match of claim.matchAll(/(?<![0-9])(\d{1,2})\s*日/g)) {
    if (!ctxDates.days.has(pad2(match[1]))) return false;
  }
  // 数字（金额、人数、点赞数……）
  const claimFacts = extractNumberFacts(claim);
  for (const value of claimFacts.values) {
    if (!numberGrounded(value, ctxNumbers)) return false;
  }
  // 模糊量按区间判：「五十多万」只要库里有个数落在 50 万到 60 万之间就算有据。
  for (const [min, max] of claimFacts.ranges) {
    if (!rangeGrounded(min, max, ctxNumbers)) return false;
  }
  // 外文专名：iPhone、Tesla、Instagram 这类具体事物，资料里没出现过就是编的
  for (const raw of extractLatinProperNouns(claim)) {
    const word = raw.toLowerCase();
    if (ENGLISH_STOPWORDS.has(word)) continue;
    if (ctxWords.has(word)) continue;
    // 资料里出现过同源的长词也算有据：资料写 "eme123"，回答写 "eme"
    let found = false;
    for (const known of ctxWords) {
      if (known.includes(word) || word.includes(known)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  // 带引介词的人名：「认识了一个叫小美的朋友」——小美得是资料里真有其人。
  // 中文没有词边界，没法穷举所有专名，但引介结构是明确的，就查这一类。
  const ctxGrams = contextNgrams(context);
  for (const match of claim.matchAll(/(?:叫|名叫|认识(?:了)?(?:一)?个|认识(?:了)?(?:一)?位)\s*([一-鿿]{2,4})/g)) {
    const name = match[1];
    let known = false;
    for (let size = name.length; size >= 2 && !known; size -= 1) {
      for (let i = 0; i + size <= name.length; i += 1) {
        if (ctxGrams.has(name.slice(i, i + size))) {
          known = true;
          break;
        }
      }
    }
    if (!known) return false;
  }
  return true;
}
