// QQ 空间说说知识库 · MCP stdio 服务器
//
// 零第三方依赖，只用 Node 内置模块。
//
// 设计原则：**这个服务器不调大模型**。
// 检索、统计、接地校验全是确定性计算，交给代码做；措辞生成交给宿主 Agent。
// 这样「知识库外的问题不许编」这条硬规则由代码兜底，而不是靠提示词自觉——
// 提示词会漏，校验器不会。
//
// 知识库数据目录的定位顺序：
//   1. 环境变量 QQ_SPACE_KB_DATA_DIR（显式覆盖，给测试或多份数据用）
//   2. 插件安装布局：<dataDir>/plugins/<pluginId> → <dataDir>/v2/plugin-data/liveboards/<pluginId>
//   3. 兜底扫描 <dataDir>/v*/plugin-data/liveboards/<pluginId>，取最新可用的一份
//
// 注意：MCP 协议规定 stdout 只能写 JSON-RPC 消息，所有日志一律走 stderr。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FALLBACK_ANSWER,
  buildIndex,
  factualTokensGrounded,
  groundingRatio,
  isConfident,
  isSelfCharacterQuestion,
  search,
} from '../miniapp/node/kb.mjs';

const PLUGIN_ID = 'qq-space-kb';
const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER_NAME = 'qq-space-kb';
const SERVER_VERSION = '1.4.0';

// 单次工具返回的文本上限。知识库原文可能很长，截断后必须说明，
// 否则调用方会以为资料到此为止。
const MAX_TEXT = 24000;

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

// ---------------------------------------------------------------------------
// 数据目录定位
// ---------------------------------------------------------------------------
function hasKnowledgeBase(dir) {
  try {
    return existsSync(join(dir, 'kb', 'unified.jsonl'));
  } catch {
    return false;
  }
}

function resolveDataDir() {
  const override = process.env.QQ_SPACE_KB_DATA_DIR;
  if (override && hasKnowledgeBase(override)) return override;

  // 插件安装布局：<dataDir>/plugins/<pluginId>
  const dataDir = resolve(PLUGIN_ROOT, '..', '..');
  const byLayout = join(dataDir, 'v2', 'plugin-data', 'liveboards', PLUGIN_ID);
  if (hasKnowledgeBase(byLayout)) return byLayout;

  // 兜底：扫 <dataDir>/v*/plugin-data/liveboards/<pluginId>，取 mtime 最新的
  try {
    const candidates = readdirSync(dataDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
      .map((entry) => join(dataDir, entry.name, 'plugin-data', 'liveboards', PLUGIN_ID))
      .filter((dir) => hasKnowledgeBase(dir))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  } catch {
    // 目录不存在就往下走
  }

  return byLayout;
}

const DATA_DIR = resolveDataDir();
const KB_DIR = join(DATA_DIR, 'kb');
const STATE_PATH = join(DATA_DIR, 'state.json');

// ---------------------------------------------------------------------------
// 知识库加载
// ---------------------------------------------------------------------------
function parseJsonl(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // 单行坏掉不该让整库读不出来
    }
  }
  return rows;
}

async function readJsonl(name) {
  try {
    return parseJsonl(await readFile(join(KB_DIR, name), 'utf8'));
  } catch {
    return [];
  }
}

async function readJson(name) {
  try {
    return JSON.parse(await readFile(join(KB_DIR, name), 'utf8'));
  } catch {
    return null;
  }
}

/** 运行时状态：人设、阶段、统计。人设是用户自己写的，属于可信事实。 */
async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function yearOf(record) {
  const ts = Number(record.published_at ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const date = new Date(ts * 1000);
  return String(date.getUTCFullYear());
}

function dateText(ts) {
  const value = Number(ts ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

const TIME_SOURCE_LABEL = {
  exact: '精确',
  'interaction-approx': '互动时间近似',
  unknown: '未知',
};

let cache = null;

async function loadKnowledgeBase() {
  if (cache) return cache;
  const [chunks, records, summaries, profile] = await Promise.all([
    readJsonl('chunks.jsonl'),
    readJsonl('unified.jsonl'),
    readJsonl('summaries.jsonl'),
    readJson('profile.json'),
  ]);
  const index = buildIndex(chunks);
  cache = { chunks, records, summaries, profile, index };
  return cache;
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------
const tools = [
  {
    name: 'kb_stats',
    description:
      '读取 QQ 空间说说知识库的总体统计：说说条数、已删除后恢复的条数、正文未能恢复的条数、覆盖年份、知识块数量、人物画像来源，以及按年份的构成明细 yearDistribution（每年条数 / 恢复数 / 正文缺失数）。回答「我的知识库有多少条」「覆盖哪些年」「哪几年数据最多」这类问题时先调它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const kb = await loadKnowledgeBase();
      const state = await readState();
      const years = new Set();
      const buckets = new Map();
      let recovered = 0;
      let bodyMissing = 0;
      let withoutYear = 0;
      for (const record of kb.records) {
        const year = yearOf(record);
        if (!year) {
          withoutYear += 1;
        } else {
          years.add(year);
          const bucket = buckets.get(year) ?? { year, count: 0, recovered: 0, bodyMissing: 0 };
          bucket.count += 1;
          if (record.recovered) bucket.recovered += 1;
          if (record.body_missing) bucket.bodyMissing += 1;
          buckets.set(year, bucket);
        }
        if (record.recovered) recovered += 1;
        if (record.body_missing) bodyMissing += 1;
      }
      const yearList = [...years].sort();
      // 按年份的构成明细：可视化与盘点都直接用它，不必再逐条翻记录。
      const yearDistribution = [...buckets.values()]
        .sort((a, b) => a.year.localeCompare(b.year))
        .map((bucket) => ({
          year: bucket.year,
          count: bucket.count,
          recovered: bucket.recovered,
          bodyMissing: bucket.bodyMissing,
          withBody: bucket.count - bucket.bodyMissing,
        }));
      return {
        knowledgeBaseExists: kb.records.length > 0,
        dataDir: DATA_DIR,
        phase: state.phase ?? '',
        ownerUin: state.ownerUin ?? '',
        persona: state.persona ?? '',
        totalRecords: kb.records.length,
        recoveredRecords: recovered,
        recoveredBodyMissing: bodyMissing,
        recordsWithoutYear: withoutYear,
        chunkCount: kb.chunks.length,
        summaryCount: kb.summaries.length,
        yearFrom: yearList[0] ?? '',
        yearTo: yearList[yearList.length - 1] ?? '',
        years: yearList,
        yearDistribution,
        profileSource: kb.profile?.source ?? '',
        hasProfile: Boolean(kb.profile),
        fallbackAnswer: FALLBACK_ANSWER,
      };
    },
  },
  {
    name: 'kb_search',
    description:
      '在 QQ 空间说说知识库里检索与问题相关的原始记录，返回命中的原文块、年份、分数，并判断检索是否置信（confident=false 说明知识库里查不到，应当直接回固定话术「当时的我还不知道这是什么意思」，不要编造）。还会在返回里带上人物画像（profileText），用于回答「我是个什么样的人」这类泛化问题。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言问题或关键词，例如「2015 年我在忙什么」' },
        topK: { type: 'integer', description: '返回条数，默认 6，最大 20', minimum: 1, maximum: 20 },
        includeProfile: {
          type: 'boolean',
          description: '是否返回人物画像全文，默认 true（泛化问题需要它）',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const kb = await loadKnowledgeBase();
      if (!kb.chunks.length) {
        return {
          knowledgeBaseEmpty: true,
          confident: false,
          selfCharacterQuestion: false,
          hits: [],
          profileText: '',
          note: '知识库是空的，先在 Mini App 里导出说说并建库。',
        };
      }
      const topK = Math.min(Math.max(Number(args.topK ?? 6) || 6, 1), 20);
      const hits = search(kb.index, args.query, topK);
      const state = await readState();
      const profileText = args.includeProfile === false ? '' : kb.profile?.narrative || kb.profile?.facts || '';
      const selfQuestion = isSelfCharacterQuestion(args.query);
      const confident = isConfident(hits, args.query);
      return {
        confident,
        selfCharacterQuestion: selfQuestion,
        // 自指类问题走画像通道，检索命中不了不代表知识库里没有
        shouldUseProfile: selfQuestion && Boolean(profileText),
        hits: hits.map((hit) => ({
          id: hit.chunk.id,
          year: hit.chunk.year ?? yearOf(hit.chunk),
          date: dateText(hit.chunk.published_at),
          timeSource: hit.chunk.time_source ?? '',
          timeSourceLabel: TIME_SOURCE_LABEL[hit.chunk.time_source] ?? hit.chunk.time_source ?? '',
          recovered: Boolean(hit.chunk.recovered),
          bodyMissing: Boolean(hit.chunk.body_missing),
          score: Number(Number(hit.score ?? 0).toFixed(3)),
          text: hit.chunk.text,
        })),
        profileText,
        // 人设是用户自己写的，属于可信事实，同样要纳入接地上下文
        persona: state.persona ?? '',
        note: confident
          ? '检索有据，回答只能使用 hits 里的原文、profileText 与 persona。'
          : '检索不置信，按固定话术回答，不要编造。',
      };
    },
  },
  {
    name: 'kb_records',
    description:
      '按年份 / 恢复状态 / 正文状态筛选 QQ 空间说说原始记录，返回结构化字段（时间、正文、地点、点赞数、评论、原文链接）。用于「2019 年有哪些说说」「哪些是已删除后恢复的」这类盘点式问题。',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'string', description: '年份，例如 "2015"；不填表示全部' },
        recovered: { type: 'boolean', description: 'true 只看已删除后恢复的，false 只看现有的' },
        bodyMissing: { type: 'boolean', description: 'true 只看正文没能恢复的' },
        keyword: { type: 'string', description: '正文 / 地点关键词过滤' },
        limit: { type: 'integer', description: '返回条数，默认 20，最大 100', minimum: 1, maximum: 100 },
        offset: { type: 'integer', description: '偏移量，默认 0', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const kb = await loadKnowledgeBase();
      const keyword = String(args.keyword ?? '').trim();
      let rows = kb.records.slice();
      if (args.year) rows = rows.filter((row) => yearOf(row) === String(args.year));
      if (typeof args.recovered === 'boolean') rows = rows.filter((row) => Boolean(row.recovered) === args.recovered);
      if (typeof args.bodyMissing === 'boolean') rows = rows.filter((row) => Boolean(row.body_missing) === args.bodyMissing);
      if (keyword) {
        rows = rows.filter((row) => `${row.content ?? ''} ${row.location ?? ''} ${row.forward_from ?? ''}`.includes(keyword));
      }
      rows.sort((a, b) => Number(b.published_at ?? 0) - Number(a.published_at ?? 0));
      const total = rows.length;
      const offset = Math.max(Number(args.offset ?? 0) || 0, 0);
      const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
      return {
        total,
        offset,
        limit,
        records: rows.slice(offset, offset + limit).map((row) => ({
          id: row.id,
          date: dateText(row.published_at),
          year: yearOf(row),
          timeSource: row.time_source ?? '',
          timeSourceLabel: TIME_SOURCE_LABEL[row.time_source] ?? row.time_source ?? '',
          content: row.body_missing ? '' : row.content ?? '',
          bodyMissing: Boolean(row.body_missing),
          recovered: Boolean(row.recovered),
          location: row.location ?? '',
          likeCount: Number(row.like_count ?? 0),
          commentCount: Array.isArray(row.comments) ? row.comments.length : 0,
          forwardFrom: row.forward_from ?? '',
          postUrl: row.post_url ?? '',
        })),
      };
    },
  },
  {
    name: 'kb_profile',
    description:
      '读取从全量说说归纳出来的人物画像（性格、时间线、各年代表原文）。回答「我是个什么样的人」「那几年我过得怎么样」这类泛化问题时使用。source 为 facts 表示统计底座版，llm 表示大模型润色版。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const kb = await loadKnowledgeBase();
      if (!kb.profile) {
        return { hasProfile: false, note: '还没有人物画像，先在 Mini App 里生成一次，或重建知识库。' };
      }
      return {
        hasProfile: true,
        source: kb.profile.source ?? '',
        narrative: kb.profile.narrative ?? '',
        facts: kb.profile.facts ?? '',
        updatedAt: kb.profile.updatedAt ?? '',
        yearlySummaries: kb.summaries.map((row) => ({
          year: row.year ?? '',
          count: Number(row.count ?? 0),
          text: row.text ?? '',
        })),
      };
    },
  },
  {
    name: 'kb_ground_check',
    description:
      '接地校验：把准备回答用户的文本丢进来，检查它是否完全落在知识库资料范围内。返回 ok=true 才能回答；ok=false 时必须改用固定话术「当时的我还不知道这是什么意思」。这条工具是硬红线：编造的日期、金额、外文专名、引介人名都会被判不合格。',
    inputSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: '准备发给用户的回答原文' },
        context: {
          type: 'string',
          description: '回答所依据的资料文本；不填则用整个知识库做校验',
        },
      },
      required: ['answer'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const kb = await loadKnowledgeBase();
      const answer = String(args.answer ?? '').trim();
      if (!answer) {
        return { ok: false, reason: 'empty_answer', ratio: 0, factsOk: false, fallbackAnswer: FALLBACK_ANSWER };
      }
      const context = String(args.context ?? '')
        || kb.chunks.map((chunk) => chunk.text).join('\n');
      const ratio = groundingRatio(answer, context);
      const factsOk = factualTokensGrounded(answer, context);
      const ok = ratio >= 0.27 && factsOk;
      return {
        ok,
        ratio: Number(ratio.toFixed(3)),
        ratioMin: 0.27,
        factsOk,
        reason: ok ? '' : factsOk ? 'low_grounding_ratio' : 'ungrounded_factual_claim',
        fallbackAnswer: FALLBACK_ANSWER,
        note: ok
          ? '有据，可以回答。'
          : '没落在资料里，必须改用固定话术。',
      };
    },
  },
];

// ---------------------------------------------------------------------------
// MCP stdio 传输：按行分隔的 JSON-RPC 2.0
// ---------------------------------------------------------------------------
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(payload, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  const clipped = text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}\n…（内容过长已截断，完整内容请分页查询）`
    : text;
  return { content: [{ type: 'text', text: clipped }], isError };
}

async function callTool(name, args) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    return toolResult({ error: 'unknown_tool', name, available: tools.map((item) => item.name) }, true);
  }
  try {
    const payload = await tool.handler(args ?? {});
    return toolResult(payload);
  } catch (error) {
    return toolResult({ error: 'tool_failed', message: String(error?.message ?? error) }, true);
  }
}

async function handle(message) {
  const { id, method, params } = message ?? {};
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      if (!isNotification) reply(id, {});
      return;
    case 'tools/list':
      reply(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;
    case 'tools/call':
      reply(id, await callTool(params?.name, params?.arguments));
      return;
    case 'resources/list':
      reply(id, { resources: [] });
      return;
    case 'prompts/list':
      reply(id, { prompts: [] });
      return;
    default:
      if (!isNotification) fail(id, -32601, `method not found: ${method}`);
  }
}

function start() {
  log(`启动，数据目录 ${DATA_DIR}`);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        let message = null;
        try {
          message = JSON.parse(line);
        } catch (error) {
          log(`解析失败：${String(error?.message ?? error)}`);
          message = null;
        }
        if (message) {
          void handle(message).catch((error) => {
            log(`处理失败：${String(error?.message ?? error)}`);
            if (message.id !== undefined && message.id !== null) {
              fail(message.id, -32603, String(error?.message ?? error));
            }
          });
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  // stdin 关闭时**不能**直接 exit：正在处理中的工具调用会被就地砍掉，
  // 客户端收到的是半个响应。改成只记日志，让事件循环自己排空——
  // stdout 的待写数据会把进程留到写完为止。
  process.stdin.on('end', () => {
    log('stdin 已关闭，等待在途响应写完');
  });
}

start();
