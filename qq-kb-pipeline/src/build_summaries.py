#!/usr/bin/env python3
"""统一 JSONL → L2 摘要知识块（年度 / 月度画像）。

L1 明细层能回答"我什么时候说过某某"，但回答不了"2013 年我都在干什么"。
L2 摘要层用 LLM 把一整年的说说压缩成一段第三人称画像，
再作为独立知识块入库，让 bot 能答宏观问题、也能学到用户的语气和性格。

LLM 后端可插拔：
  --backend openai     任意 OpenAI 兼容端点（读 KB_LLM_BASE_URL / KB_LLM_API_KEY / KB_LLM_MODEL）
  --backend llm-call   复用本机 llm_call.py（uv run --with httpx --with pyyaml）
  --backend none       纯统计摘要，不需要任何 LLM（降级方案，始终可用）
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import kb_common as kb  # noqa: E402

STOPWORDS = set(
    "的了是我你他她它们在有和就都而及与也很到说要去会着没看好自己这那什么怎么"
    "一个 没有 我们 你们 他们 她们 真的 因为 所以 但是 如果 还是 已经 可以 "
    "哈哈 哈哈哈 嗯 啊 哦 呀 吧 呢 的话 一下 时候 现在 今天 昨天 明天 感觉 觉得"
)

LLM_CALL_SCRIPT = Path(
    os.environ.get(
        "KB_LLM_CALL_SCRIPT",
        str(Path.home() / ".minimax/.builtin-skills/llm-call/scripts/llm_call.py"),
    )
)

SYSTEM_PROMPT = (
    "你是用户个人数字档案的分析助手。用户会给你他/她某一年的 QQ 空间说说全文。"
    "请用第三人称写一段 150-300 字的年度画像，包含："
    "1) 这一年的主要事件与生活阶段；2) 出现过的地点、人物类型、反复出现的主题；"
    "3) 情绪基调与性格特征（用平实克制的描述，不要美化也不要贬低）；"
    "4) 说话风格特征（常用词、句式、口头禅、是否爱用表情/网络用语）。"
    "只输出画像正文，不要标题、不要列表、不要客套话。"
)


# ---------------------------------------------------------------------------
# 关键词提取（无 LLM 降级时使用）
# ---------------------------------------------------------------------------
def _chinese_ngrams(text: str) -> list[str]:
    tokens: list[str] = []
    for run in re.findall(r"[一-鿿]{2,}", text):
        for size in (2, 3, 4):
            for i in range(len(run) - size + 1):
                tokens.append(run[i:i + size])
    for word in re.findall(r"[A-Za-z]{3,}", text):
        tokens.append(word.lower())
    return tokens


def extract_keywords(texts: list[str], limit: int = 12) -> tuple[list[str], bool]:
    """抽取高频话题词。

    返回 (关键词列表, 是否有足够置信度)。

    置信度判定：话题词必须**重复出现**才算数。单条长文里每个位置都会切出 n-gram，
    "整理成离/理成离线/成离线网"这类碎片就是没做频次过滤的产物。
    样本太少时宁可不给关键词，也不给噪声。
    """
    counter: Counter[str] = Counter()
    for text in texts:
        for token in _chinese_ngrams(text):
            if token in STOPWORDS or any(ch in STOPWORDS for ch in token):
                continue
            counter[token] += 1

    # 样本量足够时才要求重复出现
    min_count = 2 if len(texts) >= 4 else 0
    if min_count == 0:
        return [], False

    candidates = [(token, count) for token, count in counter.items() if count >= min_count]
    # 长词优先：能完整覆盖"南京西路"而不是"南京/京西/西路"
    candidates.sort(key=lambda kv: (-len(kv[0]), -kv[1]))
    picked: list[str] = []
    for token, _ in candidates:
        if any(token in kept for kept in picked):
            continue
        picked = [kept for kept in picked if kept not in token]
        picked.append(token)
        if len(picked) >= limit:
            break
    return picked, True


# ---------------------------------------------------------------------------
# LLM 后端
# ---------------------------------------------------------------------------
def call_openai(prompt: str, model: str, base_url: str, api_key: str,
                timeout: int = 180, max_tokens: int = 1200) -> str:
    url = base_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url += "/v1/chat/completions" if "/v1" not in url else "/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.6,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers=headers, method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = json.loads(response.read().decode("utf-8"))
    return body["choices"][0]["message"]["content"].strip()


def call_llm_call(prompt: str, model: str, timeout: int = 300) -> str:
    if not LLM_CALL_SCRIPT.exists():
        raise FileNotFoundError(f"找不到 llm_call.py：{LLM_CALL_SCRIPT}")
    command = [sys.executable, str(LLM_CALL_SCRIPT), "--model", model,
               "--max-tokens", "1200", "--prompt", prompt]
    if shutil.which("uv"):
        command = ["uv", "run", "--quiet", "--with", "httpx", "--with", "pyyaml"] + command
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "llm_call 调用失败")
    return result.stdout.strip()


def statistical_summary(records: list[dict], title: str) -> str:
    texts = [r.get("content", "") for r in records]
    keywords, confident = extract_keywords(texts)
    locations = Counter(
        r.get("location", "").strip() for r in records if (r.get("location") or "").strip()
    )
    top_locs = "、".join(f"{loc}({cnt}次)" for loc, cnt in locations.most_common(5))
    commenters = Counter()
    for record in records:
        for comment in record.get("comments") or []:
            nick = (comment.get("nick") or "").strip()
            if nick:
                commenters[nick] += 1
    top_people = "、".join(f"{nick}({cnt}次)" for nick, cnt in commenters.most_common(5))
    total_likes = sum(int(r.get("like_count") or 0) for r in records)
    total_comments = sum(len(r.get("comments") or []) for r in records)
    recovered = sum(1 for r in records if r.get("recovered"))

    lines = [
        f"{title}共留下 {len(records)} 条说说，"
        f"累计 {total_likes} 个赞、{total_comments} 条评论。",
    ]
    if keywords:
        lines.append(f"反复出现的话题关键词：{'、'.join(keywords)}。")
    elif not confident:
        lines.append("该组样本较少，话题分布不易归纳，以下以代表性内容为主。")
    if top_locs:
        lines.append(f"常出现的位置：{top_locs}。")
    if top_people:
        lines.append(f"互动最频繁的人：{top_people}。")
    if recovered:
        lines.append(f"其中 {recovered} 条为已删除后从互动残留恢复的内容。")
    samples = [r.get("content", "").strip() for r in records if r.get("content", "").strip()]
    if samples:
        quotes = "；".join(f"「{kb.truncate(text, 30)}」" for text in samples[:3])
        lines.append(f"代表性内容：{quotes}。")
    return "".join(lines)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def build_prompt(records: list[dict], title: str) -> str:
    lines = [f"以下是 {title} 的 QQ 空间说说全文：", ""]
    for record in records:
        stamp = kb.format_ts(int(record.get("published_at") or 0), "%Y-%m-%d %H:%M")
        if not stamp:
            stamp = "时间未知"
        content = record.get("content", "")
        location = record.get("location", "")
        suffix = f"（{location}）" if location else ""
        lines.append(f"- [{stamp}]{suffix} {content}")
    lines += ["", "请基于以上全部说说写这一年的画像。"]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 L2 年/月摘要知识块")
    parser.add_argument("--input", type=Path, required=True, help="unified.jsonl")
    parser.add_argument("--out", type=Path, required=True, help="输出目录")
    parser.add_argument("--granularity", choices=["year", "month"], default="year",
                        help="摘要粒度：年 / 月")
    parser.add_argument("--backend", choices=["openai", "llm-call", "none"], default="none")
    parser.add_argument("--model", default=None, help="模型名（openai/llm-call 后端必填）")
    parser.add_argument("--base-url", default=os.environ.get("KB_LLM_BASE_URL"))
    parser.add_argument("--api-key", default=os.environ.get("KB_LLM_API_KEY"))
    parser.add_argument("--max-records", type=int, default=400,
                        help="单个摘要块最多纳入多少条说说")
    parser.add_argument("--only-empty", action="store_true",
                        help="跳过已经存在摘要文件的分组（增量更新用）")
    args = parser.parse_args()

    records = kb.read_jsonl(args.input)
    l2_dir = args.out / "L2"
    l2_dir.mkdir(parents=True, exist_ok=True)

    groups: dict[str, list[dict]] = {}
    undated: list[dict] = []
    for record in records:
        if record.get("kind") == "guestbook":
            continue
        published_at = int(record.get("published_at") or 0)
        if not published_at:
            undated.append(record)
            continue
        key = kb.year_key(published_at) if args.granularity == "year" else kb.month_key(published_at)
        groups.setdefault(key, []).append(record)

    # 时间未知的记录单独成组，否则在摘要层会彻底隐身
    if undated:
        groups["时间未知"] = undated

    if args.backend != "none" and not args.model:
        raise SystemExit(f"--backend {args.backend} 需要同时指定 --model")

    written = skipped = failed = 0
    for key in sorted(groups):
        target = l2_dir / f"{kb.safe_filename(key, 20)}.md"
        if args.only_empty and target.exists():
            skipped += 1
            continue
        group = groups[key]
        if len(group) > args.max_records:
            # 条数过多时按时间均匀抽样，避免单次 prompt 过长
            step = len(group) / args.max_records
            group = [group[int(i * step)] for i in range(args.max_records)]

        title = f"{key} 年" if args.granularity == "year" else f"{key} 月"
        if key == "时间未知":
            title = "发布时间未知的一组说说"
        if args.backend == "none":
            summary = statistical_summary(group, title)
        else:
            try:
                prompt = build_prompt(group, title)
                if args.backend == "openai":
                    summary = call_openai(prompt, args.model, args.base_url or "", args.api_key or "")
                else:
                    summary = call_llm_call(prompt, args.model)
            except (urllib.error.URLError, RuntimeError, FileNotFoundError, KeyError) as error:
                print(f"⚠️  {key} 摘要生成失败（{error}），降级为统计摘要")
                summary = statistical_summary(group, title)
                failed += 1
            summary = summary.strip() or statistical_summary(group, title)

        body = (
            f"[时间范围] {title}\n"
            f"[条数] {len(group)}\n"
            f"[类型] 年度画像摘要\n\n"
            f"{summary}\n"
        )
        target.write_text(body, encoding="utf-8")
        written += 1
        print(f"  ✍️  {key} → {target.name}（{len(group)} 条）")

    print(f"\n✅ L2 摘要块：{written} 个 → {l2_dir}")
    if skipped:
        print(f"   跳过已存在：{skipped} 个")
    if failed:
        print(f"   降级为统计摘要：{failed} 个")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
