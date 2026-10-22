#!/usr/bin/env python3
"""统一 JSONL → L1 明细知识块（Markdown）。

说说是超短文本，直接"一条 = 一块"丢进向量库召回会飘。
本脚本把元数据拼进被嵌入的文本，让"2015 年我在上海做什么"这类问题也能命中。

输出：
  <out>/L1/<id>.md        每条说说一个 Markdown 文件（AstrBot 可直接批量上传）
  <out>/by_year/<year>.md 按年合并的浏览版（人工核查用）
  <out>/manifest.jsonl   每块的溯源信息
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import kb_common as kb  # noqa: E402

TIME_SOURCE_LABEL = {
    kb.TIME_SOURCE_EXACT: "精确",
    kb.TIME_SOURCE_FROM_ID: "由说说ID反解",
    kb.TIME_SOURCE_INTERACTION: "互动时间近似",
    kb.TIME_SOURCE_UNKNOWN: "未知",
}


def render_time_line(record: dict) -> str:
    published_at = int(record.get("published_at") or 0)
    source = record.get("time_source") or kb.TIME_SOURCE_UNKNOWN
    if published_at:
        stamp = kb.format_ts(published_at)
        return f"[时间] {stamp}（{TIME_SOURCE_LABEL.get(source, source)}）"
    interaction = int(record.get("first_interaction_at") or 0)
    if interaction:
        return (f"[时间] 未知（发布于 {kb.format_ts(interaction, '%Y-%m')} 之前，"
                f"最早可见互动 {kb.format_ts(interaction)}）")
    return "[时间] 未知"


def render_chunk(record: dict, max_comments: int = 3, max_comment_len: int = 40,
                 max_chars: int = 900) -> str:
    """渲染一个 L1 知识块。

    `max_chars` 必须小于 AstrBot Markdown 分块器的 chunk_size（默认 1024），
    否则超长说说会被切开，切开后第二块会丢失 [时间]/[位置] 这类关键前缀，
    召回质量直接崩掉。这里主动截断，保证一条说说 = 一个完整 chunk。
    """
    content = record.get("content", "")
    comments = list(record.get("comments") or [])

    def build(comment_slice: list[dict], body: str) -> str:
        lines: list[str] = []
        lines.append(render_time_line(record))

        if record.get("recovered"):
            lines.append("[来源] 已删除后从互动残留恢复")

        location = (record.get("location") or "").strip()
        if location:
            lines.append(f"[位置] {location}")

        like_count = int(record.get("like_count") or 0)
        if comment_slice or like_count:
            lines.append(f"[互动] {len(comment_slice)}条评论 / {like_count}个赞")

        lines.append(f"[正文] {body}")

        if comment_slice:
            excerpt = " | ".join(
                f"{c.get('nick') or '匿名'}: {kb.truncate(c.get('content', ''), max_comment_len)}"
                for c in comment_slice
            )
            lines.append(f"[评论摘录] {excerpt}")

        if record.get("forward_from"):
            lines.append(f"[转发自] {record['forward_from']}")

        if record.get("post_url"):
            lines.append(f"[原文] {record['post_url']}")

        return "\n".join(lines) + "\n"

    # 逐步削减：先砍评论条数，再砍评论长度，最后才截正文（正文是信息密度最高的部分）
    for count in range(max_comments, 0, -1):
        for comment_limit in (max_comment_len, 20, 10):
            body = content
            candidate = build(comments[:count], body)
            if len(candidate) <= max_chars:
                return candidate
    # 仍然超长：截正文，保留元数据前缀
    overflow = len(build([], content)) - max_chars
    body = kb.truncate(content, max(20, len(content) - overflow - 10))
    result = build([], body)
    while len(result) > max_chars and len(body) > 20:
        body = body[: int(len(body) * 0.8)]
        result = build([], body)
    return result


def chunk_id(record: dict) -> str:
    raw = record.get("id") or ""
    if raw:
        return kb.safe_filename(raw, 60)
    return kb.safe_filename(f"noid-{abs(hash(record.get('content', ''))) % 10**8}", 60)


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 L1 明细知识块")
    parser.add_argument("--input", type=Path, required=True, help="unified.jsonl")
    parser.add_argument("--out", type=Path, required=True, help="输出目录")
    parser.add_argument("--max-comments", type=int, default=3, help="每块最多摘录几条评论")
    parser.add_argument("--max-chars", type=int, default=900,
                        help="单块最大字符数，必须小于 AstrBot 分块器的 chunk_size（默认 1024）")
    parser.add_argument("--include-guestbook", action="store_true",
                        help="同时把留言板内容也作为知识块输出")
    args = parser.parse_args()

    records = kb.read_jsonl(args.input)
    l1_dir = args.out / "L1"
    by_year_dir = args.out / "by_year"
    l1_dir.mkdir(parents=True, exist_ok=True)
    by_year_dir.mkdir(parents=True, exist_ok=True)

    manifest = []
    year_buckets: dict[str, list[str]] = {}
    skipped = 0

    for record in records:
        if record.get("kind") == "guestbook" and not args.include_guestbook:
            skipped += 1
            continue
        content = (record.get("content") or "").strip()
        if not content:
            skipped += 1
            continue

        identifier = chunk_id(record)
        body = render_chunk(record, max_comments=args.max_comments, max_chars=args.max_chars)
        (l1_dir / f"{identifier}.md").write_text(body, encoding="utf-8")

        year = kb.year_key(int(record.get("published_at") or 0))
        year_buckets.setdefault(year, []).append(body)

        manifest.append({
            "file": f"L1/{identifier}.md",
            "id": record.get("id"),
            "sources": record.get("sources"),
            "recovered": bool(record.get("recovered")),
            "published_at": int(record.get("published_at") or 0),
            "time_source": record.get("time_source"),
            "like_count": int(record.get("like_count") or 0),
            "comment_count": len(record.get("comments") or []),
        })

    for year, bodies in year_buckets.items():
        header = f"# {year} 年说说（{len(bodies)} 条）\n\n"
        (by_year_dir / f"{kb.safe_filename(year, 20)}.md").write_text(
            header + "\n---\n\n".join(bodies), encoding="utf-8"
        )

    with open(args.out / "manifest.jsonl", "w", encoding="utf-8") as handle:
        for item in manifest:
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")

    recovered = sum(1 for m in manifest if m["recovered"])
    unknown = sum(1 for m in manifest if not m["published_at"])
    print(f"✅ L1 知识块：{len(manifest)} 个 → {l1_dir}")
    print(f"   其中已删除恢复：{recovered} 个")
    print(f"   发布时间未知：  {unknown} 个")
    print(f"   跳过（空内容/留言板）：{skipped} 条")
    print(f"   按年浏览版：    {by_year_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
