#!/usr/bin/env python3
"""合并两路 QQ 空间说说数据源，产出统一 JSONL。

数据源 A：ShunCai/QZoneExport 的 `Messages/json/messages.json`
    字段最全（含评论正文、点赞用户、定位、媒体），但拿不到已删除的旧说说。

数据源 B：xiaosu19/QQ-Zone-Restore-Archive 的 `qzone-archive.sqlite3`
    能从"旧历史消息残留 + 移动端互动通知"里恢复已删除的说说。

两路以 QQ 空间标准说说 ID（mood id）为同一主键做并集：
  - A 独有的 → 直接收
  - B 独有的 → 收，并标记 recovered=True
  - 两边都有  → 字段互补，A 优先，B 补空
另外独立用说说 ID 反解发布时间，对 B 给出的时间做交叉校验（发现 B 的时间有偏差时以 ID 反解为准）。
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import kb_common as kb  # noqa: E402

SRC_QZONEEXPORT = "qzoneexport"
SRC_QZONE_ARCHIVE = "qzone-archive"


# ---------------------------------------------------------------------------
# 数据源 A：QZoneExport JSON
# ---------------------------------------------------------------------------
def _qze_comments(item: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("custom_comments", "commentlist", "conlist"):
        raw = item.get(key)
        if not isinstance(raw, list) or not raw:
            continue
        comments = []
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            content = kb.clean_text(entry.get("content"))
            if not content:
                continue
            user = entry.get("user") if isinstance(entry.get("user"), dict) else {}
            nick = entry.get("nick") or user.get("nick") or "匿名"
            replies = []
            for reply in entry.get("replys") or entry.get("replies") or []:
                if not isinstance(reply, dict):
                    continue
                reply_text = kb.clean_text(reply.get("content"))
                if not reply_text:
                    continue
                replies.append({
                    "nick": reply.get("nick") or user.get("nick") or "匿名",
                    "content": reply_text,
                    "created_at": kb.to_ts(reply.get("createTime") or reply.get("date")),
                })
            comments.append({
                "nick": nick,
                "content": content,
                "created_at": kb.to_ts(entry.get("createTime") or entry.get("date")),
                "replies": replies,
            })
        if comments:
            return comments
    return []


def _qze_likes(item: dict[str, Any]) -> list[dict[str, Any]]:
    likes = []
    for entry in item.get("likes") or []:
        if not isinstance(entry, dict):
            continue
        user = entry.get("user") if isinstance(entry.get("user"), dict) else {}
        likes.append({
            "uin": str(entry.get("fuin") or user.get("uin") or ""),
            "nick": entry.get("nick") or user.get("nick") or "",
        })
    return likes


def _qze_location(item: dict[str, Any]) -> str:
    lbs = item.get("lbs")
    if isinstance(lbs, dict):
        parts = [lbs.get("address"), lbs.get("name"), lbs.get("idname")]
        joined = " ".join(kb.clean_text(p) for p in parts if p)
        if joined.strip():
            return joined.strip()
    return kb.clean_text(item.get("location"))


def _qze_media(items: Any, url_keys: tuple[str, ...]) -> list[str]:
    urls: list[str] = []
    if not isinstance(items, list):
        return urls
    for entry in items:
        if not isinstance(entry, dict):
            continue
        for key in url_keys:
            url = entry.get(key)
            if isinstance(url, str) and url.strip():
                if url.startswith("//"):
                    url = "https:" + url
                if url not in urls:
                    urls.append(url)
                break
    return urls


def load_qzoneexport(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        for key in ("messages", "data", "items", "list"):
            if isinstance(payload.get(key), list):
                payload = payload[key]
                break
        else:
            payload = []
    if not isinstance(payload, list):
        raise SystemExit(f"无法解析 {path}：期望顶层是数组或含 messages/data 数组的对象")

    records: list[dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        tid = str(item.get("tid") or "").strip()
        content = kb.clean_text(item.get("custom_content") or item.get("content") or "")
        if not tid and not content:
            continue

        published_at = kb.to_ts(item.get("created_time"))
        if not published_at:
            published_at = kb.to_ts(item.get("custom_create_time"))
        if published_at:
            time_source = kb.TIME_SOURCE_EXACT
        else:
            time_source = kb.TIME_SOURCE_UNKNOWN

        record = kb.empty_record()
        comments = _qze_comments(item)
        interaction_times = [c["created_at"] for c in comments if c.get("created_at")]
        record.update({
            "id": tid,
            "ids": [tid] if tid else [],
            "sources": [SRC_QZONEEXPORT],
            "kind": "shuoshuo",
            "recovered": False,
            "published_at": published_at,
            "time_source": time_source,
            "first_interaction_at": min(interaction_times) if interaction_times else 0,
            "content": content,
            "images": _qze_media(item.get("pic"), ("hd_url", "b_url", "url", "origin_url")),
            "videos": _qze_media(item.get("video"), ("play_url", "url", "video_url")),
            "location": _qze_location(item),
            "like_count": int(item.get("likeTotal") or item.get("like_count") or 0),
            "like_users": _qze_likes(item),
            "comments": comments,
            "post_url": kb.clean_text(item.get("post_url")),
            "forward_from": kb.clean_text(item.get("rt_uinname")),
            "raw": {"tid": tid},
        })
        records.append(record)
    return records


# ---------------------------------------------------------------------------
# 数据源 B：QQ-Zone-Restore-Archive SQLite
# ---------------------------------------------------------------------------
def _archive_pictures(pictures_json: str | None) -> list[str]:
    if not pictures_json:
        return []
    try:
        value = json.loads(pictures_json)
    except (TypeError, ValueError):
        return []
    urls: list[str] = []
    pics = (value or {}).get("picdata", {}).get("pic")
    if isinstance(pics, list):
        for pic in pics:
            if not isinstance(pic, dict):
                continue
            photourl = pic.get("photourl")
            candidates: list[str] = []
            if isinstance(photourl, list):
                candidates += [str(x) for x in photourl if isinstance(x, str)]
            elif isinstance(photourl, dict):
                candidates += [str(x) for x in photourl.values() if isinstance(x, str)]
            for name in ("rawUrl", "origin_url", "url3", "url2", "url1", "url", "smallurl"):
                value_ = pic.get(name)
                if isinstance(value_, str) and value_.strip():
                    candidates.append(value_.strip())
            for url in candidates:
                if url.startswith("//"):
                    url = "https:" + url
                if url and url not in urls:
                    urls.append(url)
                    break
    return urls


def _archive_videos(video_json: str | None) -> list[str]:
    if not video_json:
        return []
    try:
        value = json.loads(video_json)
    except (TypeError, ValueError):
        return []
    urls: list[str] = []

    def collect(node: Any) -> None:
        if isinstance(node, dict):
            for name in ("videourl", "url3", "url2", "actionurl", "playurl", "url"):
                raw = node.get(name)
                if isinstance(raw, str) and raw.strip():
                    url = raw.strip()
                    if url.startswith("//"):
                        url = "https:" + url
                    if url not in urls:
                        urls.append(url)
            for value_ in node.values():
                collect(value_)
        elif isinstance(node, list):
            for value_ in node:
                collect(value_)

    collect(value)
    return urls


def _archive_comments(comments_json: str | None, fallback_nick: str,
                      fallback_uin: str, fallback_time: int) -> list[dict[str, Any]]:
    if not comments_json:
        return []
    try:
        value = json.loads(comments_json)
    except (TypeError, ValueError):
        return []
    if not isinstance(value, dict):
        return []

    def build(entry: Any) -> dict[str, Any] | None:
        if not isinstance(entry, dict):
            return None
        content = kb.clean_text(entry.get("content"))
        if not content:
            return None
        user = entry.get("user") if isinstance(entry.get("user"), dict) else {}
        replies = []
        for reply in entry.get("replys") or []:
            reply_item = build(reply)
            if reply_item:
                replies.append(reply_item)
        return {
            "nick": kb.clean_text(user.get("nickname")) or fallback_nick or "匿名",
            "uin": str(user.get("uin") or fallback_uin or ""),
            "content": content,
            "created_at": kb.to_ts(entry.get("date")) or fallback_time,
            "replies": replies,
        }

    main = value.get("main_comment")
    comments = []
    if isinstance(main, dict):
        item = build(main)
        if item:
            comments.append(item)
    for entry in value.get("comments") or []:
        item = build(entry)
        if item and not any(
            c["content"] == item["content"] and c["nick"] == item["nick"] for c in comments
        ):
            comments.append(item)
    return comments


def load_qzone_archive(db_path: Path, owner_uin: str | None = None) -> list[dict[str, Any]]:
    if not db_path.exists():
        raise SystemExit(f"找不到归档数据库：{db_path}")
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        tables = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        if "archive_dynamics" not in tables:
            raise SystemExit(f"{db_path} 不是 QQ-Zone-Restore-Archive 的数据库（缺 archive_dynamics）")

        if owner_uin is None:
            row = connection.execute(
                "SELECT owner_uin FROM archive_dynamics GROUP BY owner_uin "
                "ORDER BY COUNT(*) DESC LIMIT 1"
            ).fetchone()
            owner_uin = row["owner_uin"] if row else ""

        dynamics = connection.execute(
            "SELECT d.cell_id, d.published_at, d.content, d.author_uin, d.author_name, "
            "       d.category, d.pictures_json, d.video_json, "
            "       EXISTS(SELECT 1 FROM archive_feeds f "
            "              WHERE f.owner_uin=d.owner_uin AND f.cell_id=d.cell_id "
            "                AND f.feed_key LIKE ?) AS is_history_residue "
            "FROM archive_dynamics d WHERE d.owner_uin=? "
            "  AND d.category IN ('self','guestbook')",
            (kb.HISTORY_FEED_PREFIX + "%", owner_uin),
        ).fetchall()

        # 互动记录：评论 / 点赞
        interactions: dict[str, dict[str, Any]] = {}
        if "archive_feeds" in tables:
            for row in connection.execute(
                "SELECT cell_id, event_type, event_time, actor_uin, actor_name, "
                "       comments_json, event_summary, content "
                "FROM archive_feeds WHERE owner_uin=? AND cell_id IS NOT NULL",
                (owner_uin,),
            ):
                cell_id = row["cell_id"]
                if not cell_id:
                    continue
                bucket = interactions.setdefault(
                    cell_id, {"comments": [], "like_users": [], "times": []}
                )
                event_time = int(row["event_time"] or 0)
                if event_time:
                    bucket["times"].append(event_time)
                event_type = row["event_type"]
                if event_type in kb.EVENT_TYPE_COMMENT:
                    comments = _archive_comments(
                        row["comments_json"], row["actor_name"] or "",
                        row["actor_uin"] or "", row["event_time"] or 0,
                    )
                    for comment in comments:
                        if not comment["content"] and row["event_summary"]:
                            comment["content"] = kb.clean_text(row["event_summary"])
                        if comment["content"]:
                            bucket["comments"].append(comment)
                elif event_type == kb.EVENT_TYPE_LIKE:
                    bucket["like_users"].append({
                        "uin": str(row["actor_uin"] or ""),
                        "nick": kb.clean_text(row["actor_name"] or ""),
                    })
    finally:
        connection.close()

    records: list[dict[str, Any]] = []
    for row in dynamics:
        cell_id = row["cell_id"] or ""
        content = kb.clean_text(row["content"])
        if not content and not cell_id:
            continue

        published_at = int(row["published_at"] or 0)
        time_source = kb.TIME_SOURCE_EXACT if published_at else kb.TIME_SOURCE_UNKNOWN
        recovered = bool(row["is_history_residue"]) or cell_id.startswith(kb.HISTORY_CELL_PREFIX)

        # 交叉校验：用说说 ID 反解原始发布时间，优先于库内已有时间
        decoded = kb.mood_cell_id_published_at(cell_id, owner_uin, published_at)
        if decoded:
            if published_at and published_at != decoded:
                time_source = kb.TIME_SOURCE_FROM_ID
            elif not published_at:
                time_source = kb.TIME_SOURCE_FROM_ID
            published_at = decoded
        elif cell_id.startswith(kb.HISTORY_CELL_PREFIX) and published_at:
            # 哈希型历史卡片：库里的时间是互动发生时间，只能当近似
            time_source = kb.TIME_SOURCE_INTERACTION

        bucket = interactions.get(cell_id, {"comments": [], "like_users": [], "times": []})
        record = kb.empty_record()
        record.update({
            "id": cell_id,
            "ids": [cell_id] if cell_id else [],
            "sources": [SRC_QZONE_ARCHIVE],
            "kind": "guestbook" if row["category"] == "guestbook" else "shuoshuo",
            "recovered": recovered,
            "published_at": published_at,
            "time_source": time_source,
            "first_interaction_at": min(bucket["times"]) if bucket["times"] else 0,
            "content": content,
            "images": _archive_pictures(row["pictures_json"]),
            "videos": _archive_videos(row["video_json"]),
            "location": "",
            "like_count": len(bucket["like_users"]),
            "like_users": bucket["like_users"],
            "comments": bucket["comments"],
            "post_url": (
                f"https://user.qzone.qq.com/{owner_uin}/mood/{cell_id}"
                if cell_id and not cell_id.startswith((kb.HISTORY_CELL_PREFIX, kb.HISTORY_GUESTBOOK_PREFIX))
                else ""
            ),
            "forward_from": "",
            "raw": {
                "cell_id": cell_id,
                "owner_uin": owner_uin,
                "author_uin": row["author_uin"],
                "author_name": row["author_name"],
                "category": row["category"],
            },
        })
        records.append(record)
    return records


# ---------------------------------------------------------------------------
# 合并
# ---------------------------------------------------------------------------
def merge_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    anonymous: list[dict[str, Any]] = []

    for record in records:
        key = record.get("id") or ""
        if not key:
            anonymous.append(record)
            continue
        if key not in merged:
            merged[key] = record
            order.append(key)
        else:
            kb.merge_record(merged[key], record)

    result = [merged[key] for key in order] + anonymous
    # 内容为空的记录没有知识库价值
    result = [r for r in result if r.get("content")]
    result.sort(key=lambda r: (r.get("published_at") or 0, r.get("id") or ""))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="合并 QQ 空间说说两路数据源")
    parser.add_argument("--qzoneexport", type=Path,
                        help="QZoneExport 的 Messages/json/messages.json")
    parser.add_argument("--archive-db", type=Path,
                        help="QQ-Zone-Restore-Archive 的 qzone-archive.sqlite3")
    parser.add_argument("--owner-uin", default=None,
                        help="空间主人 QQ 号（用于从说说 ID 反解发布时间）")
    parser.add_argument("--out", type=Path, required=True, help="输出 unified.jsonl")
    parser.add_argument("--report", action="store_true", help="打印统计报告")
    args = parser.parse_args()

    if not args.qzoneexport and not args.archive_db:
        raise SystemExit("至少需要提供 --qzoneexport 或 --archive-db 其中之一")

    records: list[dict[str, Any]] = []
    if args.qzoneexport:
        a_records = load_qzoneexport(args.qzoneexport)
        print(f"✅ QZoneExport：{len(a_records)} 条")
        records += a_records
    if args.archive_db:
        b_records = load_qzone_archive(args.archive_db, args.owner_uin)
        print(f"✅ QQ-Zone-Restore-Archive：{len(b_records)} 条")
        records += b_records

    merged = merge_records(records)

    both = sum(1 for r in merged if len(r["sources"]) > 1)
    recovered = sum(1 for r in merged if r["recovered"])
    unknown_time = sum(1 for r in merged if not r["published_at"])
    by_source = Counter(s for r in merged for s in r["sources"])
    by_time = Counter(r["time_source"] for r in merged)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    kb.write_jsonl(args.out, merged)

    print(f"\n📊 合并结果：{len(merged)} 条 → {args.out}")
    print(f"   两源命中同一说说：{both} 条")
    print(f"   已删除后恢复：    {recovered} 条")
    print(f"   发布时间未知：   {unknown_time} 条")
    print(f"   来源分布：       {dict(by_source)}")
    print(f"   时间精度分布：   {dict(by_time)}")
    if args.report:
        by_year = Counter(kb.year_key(r["published_at"]) for r in merged if r["published_at"])
        print("   年份分布：      ", dict(sorted(by_year.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
