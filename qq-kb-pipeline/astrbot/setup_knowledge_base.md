# AstrBot 接入指南：把 QQ 空间说说变成会说话的 bot

> 前提：`qq-kb-pipeline` 已经跑完，产出 `L1/` 与 `L2/` 两个目录的 Markdown 知识块。

---

## 0. 整体结构

```
QQ空间
  ├─ QZoneExport            → messages.json      ──┐
  └─ QQ-Zone-Restore-Archive→ qzone-archive.sqlite3 ──┤
                                                    ↓
                                          merge_sources.py
                                                    ↓
                                              unified.jsonl
                                                    ↓
                       ┌────────────────────────────┴────────────────────┐
                       ↓                                                 ↓
                 build_chunks.py                                  build_summaries.py
                L1 明细块（1 说说 = 1 块）                       L2 年度画像块
                       └────────────────────────────┬────────────────────┘
                                                    ↓
                                        AstrBot 知识库（bge-m3 + rerank）
                                                    ↓
                              AstrBot + 人设 + astrbot_plugin_qzone
                                                    ↓
                                          QQ / 飞书 / TG 上的 bot
```

---

## 1. 部署 AstrBot

```bash
git clone https://github.com/AstrBotDevs/AstrBot && cd AstrBot
docker compose up -d
# 打开 http://localhost:6185
```

首次进入先设置管理员密码，然后到「服务提供商」页配置。

---

## 2. 配置嵌入模型（关键，选完就别改）

AstrBot 4.5.0+ 原生支持知识库。嵌入模型一旦绑定到某个知识库，
**再改模型名或向量维度会严重破坏召回率甚至直接报错**，所以这里先定死。

### 2.1 添加 Embedding 服务商

「服务提供商」→ 新增 → 选择 **Embedding** → 选 **OpenAI** 类型，填：

| 字段 | 值 | 说明 |
|---|---|---|
| API Key | 你的 key | PPIO / 硅基流动 / OpenAI 都行 |
| api_base | `https://api.ppinfra.com/v3/openai` | PPIO 示例；硅基流动是 `https://api.siliconflow.cn/v1` |
| model | `baai/bge-m3` | 中文语义检索首选，1024 维 |
| embedding dimension | `1024` | **必须与模型实际维度一致** |

> PPIO 平台上 `BAAI/bge-m3` 曾长期免费，新用户还有代金券，是低成本起步的选择。

### 2.2 可选：重排序模型

Rerank 能明显提升召回精度，对"能答对细节问题"帮助很大。

「服务提供商」→ 新增 → **重排序** → OpenAI 兼容类型，model 用 `BAAI/bge-reranker-v2-m3`（或 `bce-reranker-base_v1`）。

### 2.3 本地部署（不想花钱）

```bash
# 嵌入模型
ollama pull bge-m3
# 或用 Xinference / TEI 起服务，然后 OpenAI 兼容方式接入
```

---

## 3. 创建知识库并上传

「知识库」→ 创建知识库：

- 名称：`QQ空间说说`
- 嵌入模型：选上一步配好的 `bge-m3`
- 重排序模型：选上一步配好的 reranker（没有就留空）

### 3.1 分两个库还是合一个库？

**建议分两个库**：

| 知识库 | 内容 | 用途 |
|---|---|---|
| `QQ空间说说-明细` | `L1/` 下的所有 md | 细节问答："我什么时候说过 XX" |
| `QQ空间说说-画像` | `L2/` 下的所有 md | 宏观问答："2013 年我都在干嘛" |

好处：画像块只有几十条，和几千条明细混在一起会稀释向量检索的注意力。
分库后可以在不同场景分别指定（AstrBot 支持在配置里按 profile 绑定不同知识库）。

### 3.2 上传

- 每次最多 10 个文件，单文件 ≤ 128 MB
- 明细库文件多，建议**按年分批上传**（`by_year/2018.md` 这类合并不是给模型用的，
  是给人看的；给模型上传的是 `L1/` 下的单条 md）
- 明细库文件多时，逐个上传很累 —— 见下面「4. 批量上传脚本」

---

## 4. 批量上传（可选，省时间）

AstrBot 的知识库接口可以脚本化。启动服务后：

```bash
# 先在 WebUI 建好知识库并拿到 knowledge base id
export ASTRBOT_URL=http://localhost:6185
export ASTRBOT_TOKEN=你的管理员token
export KB_ID=知识库ID

python3 astrbot/upload_to_astrbot.py out/kb/L1 --kb-id "$KB_ID"
```

脚本会走 AstrBot 的知识库文件上传接口批量灌入。接口随版本变动，
若失效请以 `astrbot/app/core/knowledge/...` 的实际实现为准调整。

---

## 5. 装 QZone 插件（让 bot 能直接读写空间）

```bash
cd AstrBot/data/plugins
git clone https://github.com/Zhalslar/astrbot_plugin_qzone
# 控制台重启 AstrBot
```

插件能力：看说说 / 评说说 / 赞说说 / 发说说 / 写说说（AI 生成草稿）/ 投稿审核。
装完在插件配置面板里填 QQ 号并扫码授权。

配合知识库就有意思了——用户问"我当年在外滩发过什么"，
bot 先从知识库检索，再用插件去实时拉那条说说的原帖。

---

## 6. 人设：让 bot 像本人

人设是「塑造形象」的关键，光有知识库只能做到"知道发生过什么"，
做不到"用他的语气说话"。

### 6.1 从数据里提炼人设要素

用 L2 摘要块反推。示例：

```text
【基本信息】
- 昵称：XXX
- 说话习惯：短句多，常用「哈哈哈」和「…」，不爱用感叹号
- 常用词：折腾、绝了、还行、真的
- 情绪基调：偏克制自嘲，不矫情

【时间线】
- 2015-2017 大学阶段：社交密度最高，天天发
- 2018-2019 工作阶段：内容转向项目和生活，偶尔emo
- 2020 之后：明显变少，最后一条在 2021 年

【关系网】
- 提及最多的朋友：ABC、DEF
- 常去的地点：静安寺、南京西路、公司附近
```

### 6.2 人设提示词模板

见 `astrbot/persona_prompt.md`，直接改成你的即可。

### 6.3 三个容易踩的坑

1. **别让 bot 声称这些事还在发生**。2016 年的"今天加班"如果被当成当下，
   bot 会说出"我今天还在那个公司加班"这种荒谬的话。
   人设里必须写死时间锚点规则：**所有历史内容一律用过去时态叙述**。

2. **别把已删除恢复的内容当成"我删掉的"**。恢复出来的说说在知识块里标了
   `[来源] 已删除后从互动残留恢复`，bot 提到时应当自然带过，不要主动强调"这条我删过"。

3. **保留不确定性**。时间未知的条目标了 `[时间] 未知`，bot 不该编造具体日期。

---

## 7. 知识库不生效时的排查清单

| 症状 | 检查 |
|---|---|
| bot 完全不引用知识库 | 知识库是否绑定到了当前 profile / 会话 |
| 检索到了但答案不对 | 嵌入模型是否被改过（改了就重建知识库）；Rerank 是否配错 |
| 召回为空 | Markdown 是否为空文件；中文内容是否被正确编码 |
| 答案泛泛而谈 | L2 画像块是否入库；人设里是否给了明确的行为指令 |
| 提到未来时态 | 人设里缺"过去时态"约束 |

---

## 8. 增量更新

说说是持续生产的，建议每周跑一次：

```bash
# 1. 重新导出（QZoneExport 支持增量；Rust 工具支持断点续传）
# 2. 重新合并 —— merge_sources.py 是幂等的，按说说 ID 去重
./run_pipeline.sh --qzoneexport ... --archive-db ... --out out/kb

# 3. 只把新增的块灌进知识库
python3 astrbot/upload_to_astrbot.py out/kb/L1 --kb-id "$KB_ID" --only-new \
  --state out/kb/.uploaded.json
```

`--only-new` 用 `manifest.jsonl` 里的 `id` 比对本地状态文件，只上传没传过的。
