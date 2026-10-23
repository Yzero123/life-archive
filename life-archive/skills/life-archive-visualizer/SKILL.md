---
name: life-archive-visualizer
description: 把 人生档案的年份分布画成看板。当用户问「我的说说是哪几年发的」「哪一年最密」「哪几年只剩回溯痕迹」「知识库整体覆盖情况」时使用。数据来自 MCP 工具 kb_stats 的确定性统计，不调大模型、不取新数据。配套组件配方、数据契约与完整样例见本技能的 references 目录。
---

# 人生档案 · 年份分布可视化

本技能是 `life-archive` 业务技能的**可视化分支**。它不重新实现业务逻辑，
只把业务流已经算好的结构化结果画出来。

## 前置：先有业务结果，再有图

**先跑业务流，再决定要不要画。** 本技能不发起任何业务调用。

1. 调用 MCP 工具 `kb_stats`（server `life-archive`），拿到知识库统计。
2. 按 `references/data-schema.json` 校验结果结构：字段齐不齐、`yearDistribution` 的
   派生字段自洽（`withBody === count - bodyMissing`）。
3. 结果不合法或工具失败 → **走文字兜底**，不要画半截图。
4. 结果合法 → 按下面的规则决定画不画。

> 数据来源只有一处：本地知识库的确定性统计。没有远程数据源，
> 也没有「模型觉得有多少条」这种说法。**图上每个数字都必须来自 `kb_stats`。**

## 什么时候画

用 `references/components.md` 的**配方 A：年份分布看板**。

| 情况 | 动作 |
|---|---|
| 问年份分布、哪年最密、回溯集中在哪几年、整体覆盖情况 | 画看板 |
| 问某一年具体发生了什么 | **不画**，走 `kb_records` + `kb_search` 回文字 |
| 问「我是个什么样的人」 | **不画**，走 `kb_profile` |
| `yearDistribution` 长度 ≤ 5 | 降级为 `kind="chart"` 单序列柱状图 |
| `yearDistribution` 长度为 0 | 不画，走空态文字 |

**可视化不是绕过接地规则的出口。** 业务技能判定「知识库里没有这条」时，
答案必须是固定话术，不能配一张图。

## 写图之前必须先读

- `references/genui-widget/SKILL.md` —— 完整基础契约（DSL、主题、安全、数据、兜底、交互）
- `references/genui-widget/references/color-system.md` —— `--mw-*` token 与 Chart.js 配色
- `references/genui-widget/references/visual-rules.md` —— 排版、留白、状态、深浅色
- `references/genui-widget/references/widget-patterns.md` —— 渲染器选型、Chart.js 护栏
- `references/genui-widget/references/widget-recipes.md` —— 脚手架与交互模式
- `references/components.md` —— 本业务的组件配方与状态定义
- `references/data-schema.json` —— 数据契约
- `references/examples.md` —— 一个完整可运行的样例，照它改

## 输出要求

**默认只输出一个最终 `<mavis-widget>`**，放在**最后一条**助手消息里。
所有取数、校验、写文件都要在它之前完成——**输出 Widget 之后不能再调用任何工具**。

- 信封顺序固定：`mavis-meta` → `mavis-style` → `mavis-html` → `mavis-data` → `mavis-script` → `mavis-fallback`
- `mavis-data` 放原始 `yearDistribution`；派生序列在前端算，不要另存一份
- 脚本只从 `window.__mavisData` 读数据，不从 DOM 反推
- 主题敏感颜色只走 `var(--mw-*)` 与 `window.mavisTheme.tokens`，Chart.js 要监听 `mavis:theme-change`
- 6 个以上同类数据点用 Chart.js（`kind="dashboard"` 或 `kind="chart"` 才注入 Chart.js）
- `<canvas>` 必须包在有显式高度的容器里
- 交互用 `addEventListener` 绑定，不写行内 `onclick`
- 追问只用 `window.mavis.sendPrompt(text, metadata)`，**不生成也不宣传 `submitForm`**

### 追问的语言

`text` 与 `userIntent` **都用对话语言**（用户用中文就用中文）。
这不是风格偏好，是硬要求：这两个值是用户要读到的内容。

### 追问的载荷纪律

`selectedData` 只放 `yearDistribution` 里真实存在的字段与值。
不放 QQ 号、不放 `dataDir` 路径、不放原始报错、不放任何凭证。
`year` 是稳定标识符，下钻就靠它。

## 状态处理

| 状态 | 表现 |
|---|---|
| 正常 | KPI 四卡 + 逐年构成图 + 紧凑明细表 + 行动条，全部填真实值 |
| 加载中 | 先出结构：KPI 数值 `—`，图表容器底色占位，明细表空行；不出图例 |
| 空 | 保留框架，居中一行「知识库还没有数据，先导出说说并建库」；**不渲染行动条** |
| 错误 | 保留布局，内联一行短提示；不展示半截数据，不贴原始报错栈 |
| 权限 | 本技能不发起鉴权型调用；宿主未授予 MCP 权限时直接走文字兜底 |

## 文字兜底

不出图时的完整替代：按年份列出「年份 · 条数 · 回溯 · 正文缺失」的 Markdown 表，
加一句结论（最密的一年、回溯集中的区间）。

**兜底不是失败降级，是另一种正确输出。** 数据少、用户要纯文字、或工具失败时，
文字版往往比图更好用。

## 边界

- 本技能不调大模型，不新增业务调用，不补数据。
- 图上的每个数字都必须能在 `kb_stats` 的返回里找到出处。
- 知识库内容只在本机。**不要把 `dataDir` 路径、QQ 号、原始说说正文画进组件**。
