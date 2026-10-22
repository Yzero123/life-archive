# qq-kb-pipeline

把 QQ 空间的历史说说（含**已删除后恢复的内容**）打包成可用于 RAG 的知识块，接进 AstrBot 聊天 bot。

```
ShunCai/QZoneExport  ──messages.json──┐
                                       ├─→ merge_sources.py ─→ unified.jsonl ─┬─→ build_chunks.py    ─→ L1/ 明细块
xiaosu19/QQ-Zone-Restore-Archive ─.sqlite3─┘                                     └─→ build_summaries.py ─→ L2/ 年度画像
                                                                                        ↓
                                                                          AstrBot 知识库 (bge-m3 + rerank)
                                                                                        ↓
                                                            AstrBot + 人设 + astrbot_plugin_qzone
```

**核心依赖：零。** 合并 / 切块 / 统计摘要全用 Python 标准库（实测 3.9.6 与 3.13 均可跑）。
只有 LLM 摘要后端需要网络。

---

## 快速开始

```bash
cd qq-kb-pipeline

# 一键跑通（先用 --backend none，不需要任何 API Key）
./run_pipeline.sh \
  --qzoneexport  /path/to/QZoneExport/Messages/json/messages.json \
  --archive-db   /path/to/qzone-archive.sqlite3 \
  --owner-uin    你的QQ号 \
  --out out/kb
```

产出：

| 目录 | 内容 | 用途 |
|---|---|---|
| `out/kb/L1/` | 每条说说一个 md | 上传到「明细」知识库 |
| `out/kb/L2/` | 每个年度一个 md | 上传到「画像」知识库 |
| `out/kb/by_year/` | 按年合并的浏览版 | 人工核查 |
| `out/kb/manifest.jsonl` | 每块的溯源信息 | 增量去重 |
| `out/kb/unified.jsonl` | 合并后的结构化数据 | 二开 |

---

## 第一步：准备两路数据

### 1.1 QZoneExport（主力，字段最全）

[ShunCai/QZoneExport](https://github.com/ShunCai/QZoneExport) —— Chrome 扩展，1.9k star，Apache-2.0。

装好扩展后登录 QQ 空间 → 点扩展图标 → 勾选「说说」→ 开始备份。
产物在备份目录的 `Messages/json/messages.json`。

**为什么必须用它**：只有它能拿到评论正文、点赞用户、定位。
`Ritori2022/qq-space-export` 虽然更轻，但时间字段是 `"30分钟前"` 这种相对值，做时间轴等于废。

### 1.2 QQ-Zone-Restore-Archive（补全已删除的说说）

[xiaosu19/QQ-Zone-Restore-Archive](https://github.com/xiaosu19/QQ-Zone-Restore-Archive) —— Rust/Tauri 桌面端，GPL-3.0。

**为什么必须用它**：QQ 空间没有官方导出工具，删掉的说说正文虽然没了，
但**点赞和评论的残留还在**。这个工具会扫旧历史消息 + 移动端互动通知，
把还能捞到的正文、媒体、互动关系还原出来。

产物是 SQLite，位置：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/top.ehre.qzonearchive/qzone-archive.sqlite3` |
| Windows | `%APPDATA%\top.ehre.qzonearchive\qzone-archive.sqlite3` |
| Linux | `~/.local/share/top.ehre.qzonearchive/qzone-archive.sqlite3` |

> 找不到就启动一次归档工具，它会自己建库；或者在工具里执行一次"深度扫描"。

### 1.3 为什么两个都要

| | QZoneExport | Restore-Archive |
|---|---|---|
| 可见说说 | ✅ | ✅ |
| 评论正文 / 点赞用户 / 定位 | ✅ | 部分 |
| **已删除的说说** | ❌ | ✅ |
| 已删说说的真实发布时间 | — | ✅（从说说 ID 反解） |
| 互动关系还原 | ❌ | ✅ |

两路以**说说 ID** 为主键取并集，互补成完整历史。

---

## 第二步：合并

```bash
python3 src/merge_sources.py \
  --qzoneexport /path/to/messages.json \
  --archive-db  /path/to/qzone-archive.sqlite3 \
  --owner-uin   你的QQ号 \
  --out out/kb/unified.jsonl --report
```

**`--owner-uin` 强烈建议填上**。合并器会用它做两件事：

1. 校验归档库里的说说 ID 是不是属于你（防止把别人的记录混进来）；
2. **从说说 ID 反解原始发布时间**。

### 说说 ID 反解原理

QQ 空间标准说说 ID 前 16 位十六进制里藏着两个 u32（小端）：

```
b327e672 e295585b b4ceb0500
└─ 小端u32 = 空间主人QQ号 ─┘ └─ 小端u32 = 发布时间戳 ─┘
```

```python
owner    = struct.unpack("<I", bytes.fromhex(cell_id[:8]))[0]
published = struct.unpack("<I", bytes.fromhex(cell_id[8:16]))[0]
```

校验规则：QQ 号必须匹配；时间必须晚于 QQ 空间上线（2005-01-01）且不晚于互动发生时间。

这意味着**即使一条说说的正文只在互动残留里存在，发布时间依然能精确还原**——
时间轴不会因为删除而断裂。算法与 Rust 侧 `mood_cell_id_published_at` 完全一致。

### 时间精度标记

每条记录都带 `time_source`，**不会假装知道不确定的时间**：

| 值 | 含义 |
|---|---|
| `exact` | 源数据直接给出的发布时间 |
| `from-mood-id` | 由说说 ID 反解得出 |
| `interaction-approx` | 只能拿到互动发生时间，是近似值（哈希型历史卡片） |
| `unknown` | 完全不可考 |

---

## 第三步：切知识块

```bash
python3 src/build_chunks.py --input out/kb/unified.jsonl --out out/kb
```

产出块长这样：

```markdown
[时间] 2018-07-25 23:23（精确）
[位置] 上海市静安区 静安寺
[互动] 2条评论 / 18个赞
[正文] 今天把 QQ 空间历史说说整理成离线网页了，翻旧内容终于不再费劲。
[评论摘录] 小明: 牛啊 | 小红: 这事儿你干了多久了
[原文] https://user.qzone.qq.com/12345678/mood/b327e672...
```

**为什么把元数据拼进正文**：说说是超短文本（几十字），纯正文嵌入召回会飘。
带上时间、地点、互动量后，"2015 年我在上海做什么"这类问题才命得中。

已删除恢复的块会额外带一行：

```markdown
[来源] 已删除后从互动残留恢复
```

---

## 第四步：生成年度画像

```bash
# 方式 A：纯统计，不需要 LLM（始终可用）
python3 src/build_summaries.py --input out/kb/unified.jsonl --out out/kb --backend none

# 方式 B：任意 OpenAI 兼容端点
export KB_LLM_BASE_URL=https://api.ppinfra.com/v3/openai
export KB_LLM_API_KEY=你的key
export KB_LLM_MODEL=MiniMax-M3
python3 src/build_summaries.py --input out/kb/unified.jsonl --out out/kb --backend openai

# 方式 C：复用本机 llm_call.py
python3 src/build_summaries.py --input out/kb/unified.jsonl --out out/kb \
  --backend llm-call --model minimax/MiniMax-M3.1-Flash
```

L2 块是"这一年我是什么样的人"的第三人称画像，用来回答宏观问题，
也用来让 bot 学到你的语气。LLM 失败会自动降级为统计摘要，不会中断流程。

> 统计摘要的关键词按**重复频次**过滤。单条长文里每个位置都会切出 n-gram，
> 没做频次过滤就会得到"整理成离/理成离线/成离线网"这种碎片。
> 样本太少时宁可不给关键词，也不给噪声。

---

## 第五步：接入 AstrBot

见 [`astrbot/setup_knowledge_base.md`](astrbot/setup_knowledge_base.md)，要点：

1. 配 Embedding（`bge-m3`）和可选的 Rerank
2. 建**两个**知识库：`QQ空间说说-明细`（L1）、`QQ空间说说-画像`（L2）
3. 批量上传：

```bash
export ASTRBOT_URL=http://localhost:6185
export ASTRBOT_TOKEN=你的api_key
export KB_ID=明细库ID

python3 astrbot/upload_to_astrbot.py out/kb/L1 --kb-id "$KB_ID"
python3 astrbot/upload_to_astrbot.py out/kb/L2 --kb-id "$画像库ID"
```

4. 设人设：见 [`astrbot/persona_prompt.md`](astrbot/persona_prompt.md)

**人设里最重要的一条**：所有历史内容一律用过去时态。
否则 bot 会说出"我现在还在静安寺附近上班"这种荒谬的话。

---

## 增量更新

每周跑一次即可，合并是幂等的（按说说 ID 去重）：

```bash
./run_pipeline.sh --qzoneexport ... --archive-db ... --out out/kb

python3 astrbot/upload_to_astrbot.py out/kb/L1 --kb-id "$KB_ID" --only-new \
  --state out/kb/.uploaded_L1.json
```

`--only-new` 靠 `manifest.jsonl` 里的说说 ID 比对，只上传没传过的块。

---

## 跑测试

```bash
python3 tests/test_pipeline.py
```

42 项断言，覆盖：ID 解码算法、两路合并与去重、已恢复标记、时间精度判定、
L1 块结构与长度上限、L2 摘要生成、LLM 后端链路与失败降级、上传脚本 dry-run。
全程用合成数据，**不碰你的真实 QQ 数据**。

> 其中「AstrBot 分块器下仍为单块」这项需要 AstrBot 源码。
> 没克隆时会自动跳过；想启用：
> ```bash
> git clone --depth 1 --filter=blob:none --sparse \
>   https://github.com/AstrBotDevs/AstrBot.git astrbot-src
> cd astrbot-src && git sparse-checkout set astrbot/core/knowledge_base
> ```

---

## 目录结构

```
qq-kb-pipeline/
├── README.md
├── run_pipeline.sh              一键串联
├── requirements.txt             仅 jieba 为可选依赖
├── src/
│   ├── kb_common.py             统一 schema / ID 解码 / 时间 / 清洗
│   ├── merge_sources.py         两路合并
│   ├── build_chunks.py          L1 明细块
│   └── build_summaries.py       L2 画像块
├── astrbot/
│   ├── setup_knowledge_base.md  接入指南
│   ├── persona_prompt.md        人设模板
│   ├── upload_to_astrbot.py     批量上传
│   └── docker-compose.yml
└── tests/
    ├── make_fixtures.py         合成数据生成
    ├── mock_openai_server.py    LLM 后端 mock
    └── test_pipeline.py         回归测试
```

---

## 风险提示

- **账号风控**：归档时把间隔调大（`--page-wait-ms 20000 --segment-pause-ms 180000`），
  归档期间别切换 QQ 客户端账号，否则有冻结风险。
- **隐私**：说说含位置、关系链、情绪等敏感信息。全流程本地跑，
  知识库别对外暴露，嵌入模型优先用本地或可信厂商。
- **协议**：Restore-Archive 是 GPL-3.0，QZoneExport 是 Apache-2.0。
  纯自用无碍，若要分发二进制需遵守 GPL。
- **完整性**：**没有被点赞或评论过、已被服务端彻底清除的内容无法恢复。**
  管线会诚实地把这类标成"时间未知"，而不是编一个日期。
