"""qq-kb-pipeline 公共模块。

统一两路数据源（ShunCai/QZoneExport 的 JSON + xiaosu19/QQ-Zone-Restore-Archive 的
SQLite）到同一套 schema，并提供 QQ 空间说说 ID → 发布时间的解码能力。
"""

from __future__ import annotations

import json
import re
import struct
import time
from typing import Any, Iterable

# QQ 空间 2005-01-01 UTC 上线时间，早于此值的时间戳一定是占位/损坏数据
QZONE_LAUNCH_TS = 1_104_537_600

# 归档工具用到的互动事件类型
EVENT_TYPE_LIKE = 217
EVENT_TYPE_COMMENT = (2, 311)
EVENT_TYPE_GUESTBOOK = 334

# 历史残留标记：archive_feeds.feed_key 以此前缀开头的记录来自"旧历史消息"扫描
HISTORY_FEED_PREFIX = "history-v2-event:"
# 归档工具给"无法验证原始发布时间"的哈希型历史卡片用的 cell_id 前缀
HISTORY_CELL_PREFIX = "history-v2:"
HISTORY_GUESTBOOK_PREFIX = "history-guestbook:"

TIME_SOURCE_EXACT = "exact"                    # 源数据直接给出的发布时间
TIME_SOURCE_FROM_ID = "from-mood-id"           # 由说说 ID 反解出
TIME_SOURCE_INTERACTION = "interaction-approx"  # 只能拿到互动发生时间（近似）
TIME_SOURCE_UNKNOWN = "unknown"                # 未知


# ---------------------------------------------------------------------------
# 说说 ID → 发布时间
# ---------------------------------------------------------------------------
def mood_cell_id_published_at(cell_id: str, owner_uin: str, event_time: int = 0) -> int | None:
    """从 QQ 空间标准说说 ID 反解原始发布时间。

    ID 前 8 位十六进制 = 小端 u32 = 空间主人 QQ 号；后 8 位 = 小端 u32 = 发布时间。
    算法与 xiaosu19/QQ-Zone-Restore-Archive 的 `mood_cell_id_published_at` 一致。

    返回 unix 秒；无法校验（QQ 号不匹配 / 时间早于 QQ 空间上线 / 晚于互动时间）时返回 None。
    """
    if not cell_id or len(cell_id) < 16:
        return None
    try:
        raw = bytes.fromhex(cell_id[:16])
    except ValueError:
        return None
    encoded_owner = struct.unpack("<I", raw[0:4])[0]
    published_at = struct.unpack("<I", raw[4:8])[0]
    if str(encoded_owner) != str(owner_uin):
        return None
    if published_at < QZONE_LAUNCH_TS:
        return None
    if event_time > 0 and published_at > event_time:
        return None
    return published_at


# ---------------------------------------------------------------------------
# 文本清洗
# ---------------------------------------------------------------------------
_TAG_RE = re.compile(r"<[^>]+>")
_BB_RE = re.compile(r"\[([^\[\]]{1,12})\]")
_WS_RE = re.compile(r"\s+")
_ENTITIES = {
    "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
    "&quot;": '"', "&#39;": "'", "&apos;": "'",
}


def clean_text(value: Any) -> str:
    """把 HTML / BBCode / 实体字符压成纯文本单行。"""
    if value is None:
        return ""
    text = str(value)
    for entity, char in _ENTITIES.items():
        text = text.replace(entity, char)
    text = _TAG_RE.sub("", text)
    text = _BB_RE.sub(r"\1", text)
    text = text.replace("", "").replace("﻿", "")
    return _WS_RE.sub(" ", text).strip()


def truncate(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


# ---------------------------------------------------------------------------
# 时间
# ---------------------------------------------------------------------------
def to_ts(value: Any) -> int:
    """把各种时间表达统一成 unix 秒；无法解析返回 0。"""
    if value is None or value == "":
        return 0
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        ts = int(value)
        # 毫秒时间戳
        if ts > 10_000_000_000:
            ts //= 1000
        return ts if ts >= QZONE_LAUNCH_TS else 0
    text = str(value).strip()
    if not text:
        return 0
    if text.isdigit():
        return to_ts(int(text))
    # "2021年01月08日" / "2021-01-08 21:08" / "2021/01/08"
    normalized = text.replace("年", "-").replace("月", "-").replace("日", "")
    normalized = normalized.replace("/", "-").replace(".", "-")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y-%m"):
        try:
            return int(time.mktime(time.strptime(normalized.strip(), fmt)))
        except ValueError:
            continue
    return 0


def format_ts(ts: int, fmt: str = "%Y-%m-%d %H:%M") -> str:
    if not ts:
        return ""
    try:
        return time.strftime(fmt, time.localtime(ts))
    except (OverflowError, ValueError):
        return ""


def year_of(ts: int) -> int:
    return time.localtime(ts).tm_year if ts else 0


def month_key(ts: int) -> str:
    return time.strftime("%Y-%m", time.localtime(ts)) if ts else "unknown"


def year_key(ts: int) -> str:
    return time.strftime("%Y", time.localtime(ts)) if ts else "unknown"


# ---------------------------------------------------------------------------
# 统一记录
# ---------------------------------------------------------------------------
def empty_record() -> dict[str, Any]:
    return {
        "id": "",
        "ids": [],
        "sources": [],
        "kind": "shuoshuo",
        "recovered": False,
        "published_at": 0,
        "time_source": TIME_SOURCE_UNKNOWN,
        "first_interaction_at": 0,
        "content": "",
        "images": [],
        "videos": [],
        "location": "",
        "like_count": 0,
        "like_users": [],
        "comments": [],
        "post_url": "",
        "forward_from": "",
        "raw": {},
    }


def merge_record(base: dict[str, Any], other: dict[str, Any]) -> dict[str, Any]:
    """把 other 合并进 base：非空补齐、集合取并集、计数取大值。"""
    if not other:
        return base
    for key in ("id",):
        if not base.get(key) and other.get(key):
            base[key] = other[key]
    for key in ("ids", "sources", "images", "videos"):
        merged = list(base.get(key) or [])
        for item in other.get(key) or []:
            if item not in merged:
                merged.append(item)
        base[key] = merged
    for key in ("content", "location", "post_url", "forward_from"):
        if not base.get(key) and other.get(key):
            base[key] = other[key]
    base["like_count"] = max(int(base.get("like_count") or 0), int(other.get("like_count") or 0))
    base["recovered"] = bool(base.get("recovered")) or bool(other.get("recovered"))
    base["published_at"] = max(int(base.get("published_at") or 0), int(other.get("published_at") or 0))
    base["first_interaction_at"] = min(
        [int(v) for v in (base.get("first_interaction_at"), other.get("first_interaction_at")) if v] or [0]
    )
    if base.get("time_source") == TIME_SOURCE_UNKNOWN and other.get("time_source"):
        base["time_source"] = other["time_source"]

    seen = {(c.get("nick"), c.get("content")) for c in base.get("comments") or []}
    for comment in other.get("comments") or []:
        key = (comment.get("nick"), comment.get("content"))
        if key not in seen:
            seen.add(key)
            base.setdefault("comments", []).append(comment)
    seen_users = {(u.get("uin"), u.get("nick")) for u in base.get("like_users") or []}
    for user in other.get("like_users") or []:
        key = (user.get("uin"), user.get("nick"))
        if key not in seen_users:
            seen_users.add(key)
            base.setdefault("like_users", []).append(user)
    return base


def write_jsonl(path, records: Iterable[dict[str, Any]]) -> int:
    count = 0
    with open(path, "w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            count += 1
    return count


def read_jsonl(path) -> list[dict[str, Any]]:
    records = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def safe_filename(text: str, limit: int = 80) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z一-鿿_-]", "_", text or "")
    return cleaned[:limit] or "untitled"
