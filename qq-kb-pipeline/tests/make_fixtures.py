#!/usr/bin/env python3
"""生成合成测试数据：QZoneExport JSON + QQ-Zone-Restore-Archive SQLite。

SQLite 表结构与 xiaosu19/QQ-Zone-Restore-Archive 的 archive.rs 保持一致，
用于验证合并器对真实库的兼容性（不依赖真实 QQ 账号数据）。
"""

from __future__ import annotations

import json
import sqlite3
import struct
from pathlib import Path

OWNER_UIN = "1927686067"

# 与 Rust 侧一致的建表语句
SCHEMA = """
CREATE TABLE IF NOT EXISTS archive_feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_uin TEXT NOT NULL,
  feed_key TEXT NOT NULL,
  cell_id TEXT,
  event_type INTEGER NOT NULL DEFAULT 0,
  event_time INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  content TEXT,
  event_summary TEXT,
  actor_uin TEXT,
  actor_name TEXT,
  original_author_uin TEXT,
  original_author_name TEXT,
  picture_count INTEGER NOT NULL DEFAULT 0,
  pictures_json TEXT,
  video_json TEXT,
  comments_json TEXT,
  raw_json TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  UNIQUE(owner_uin, feed_key)
);
CREATE TABLE IF NOT EXISTS archive_dynamics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_uin TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  published_at INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  author_uin TEXT,
  author_name TEXT,
  category TEXT NOT NULL DEFAULT '',
  pictures_json TEXT,
  video_json TEXT,
  raw_original_json TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  UNIQUE(owner_uin, cell_id)
);
CREATE TABLE IF NOT EXISTS archive_library_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_uin TEXT NOT NULL,
  module TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '',
  item_key TEXT NOT NULL,
  parent_key TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  author_uin TEXT,
  author_name TEXT,
  cover_url TEXT,
  media_json TEXT NOT NULL DEFAULT '[]',
  raw_json TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  UNIQUE(owner_uin,module,scope_key,item_key)
);
"""


def mood_id(owner_uin: str, published_at: int, suffix: str = "00000000") -> str:
    """构造一个合法的 QQ 空间说说 ID（前 8 位=QQ号，后 8 位=发布时间）。"""
    owner_hex = struct.pack("<I", int(owner_uin)).hex()
    time_hex = struct.pack("<I", int(published_at)).hex()
    return owner_hex + time_hex + suffix


def build(out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "messages.json"
    db_path = out_dir / "qzone-archive.sqlite3"

    ts_shared = 1532532194          # 2018-07-25 23:23:14，两源共有
    ts_qze_only = 1451606400       # 2016-01-01 00:00:00，仅 QZoneExport
    ts_recovered = 1490000000      # 2017-03-20 07:33:20，已删但可由 ID 反解
    ts_interaction = 1520000000    # 2018-03-02 18:26:40，仅互动时间

    id_shared = mood_id(OWNER_UIN, ts_shared, "aaaabbbb")
    id_recovered = mood_id(OWNER_UIN, ts_recovered, "ccccdddd")
    id_qze_only = mood_id(OWNER_UIN, ts_qze_only, "eeeeffff")
    id_hash_only = "history-v2:" + "a" * 32
    id_guestbook = "history-guestbook:" + "b" * 32

    # ---------------- QZoneExport JSON ----------------
    messages = [
        {
            "tid": id_shared,
            "content": "<p>今天把 QQ 空间历史说说整理成离线网页了，翻旧内容终于不再费劲。</p>",
            "custom_content": "今天把 QQ 空间历史说说整理成离线网页了，翻旧内容终于不再费劲。",
            "created_time": ts_shared,
            "custom_create_time": "2018-07-25 23:23:14",
            "commentlist": [
                {"content": "牛啊", "nick": "小明", "createTime": "2018年07月26日"},
                {"content": "这事儿你干了多久了", "nick": "小红", "createTime": ts_shared + 3600},
            ],
            "likeTotal": 18,
            "likes": [{"fuin": 10001, "nick": "小刚"}, {"fuin": 10002, "nick": "小丽"}],
            "lbs": {"address": "上海市静安区", "name": "静安寺", "pos_x": 121.44, "pos_y": 31.22},
            "pic": [{"hd_url": "https://photo.example.com/a1.jpg"}],
            "video": [],
            "post_url": f"https://user.qzone.qq.com/{OWNER_UIN}/mood/{id_shared}",
            "rt_uinname": "",
        },
        {
            "tid": id_qze_only,
            "content": "换了新工作，搬到南京西路了。",
            "custom_content": "换了新工作，搬到南京西路了。",
            "created_time": ts_qze_only,
            "custom_create_time": "2016-01-01 00:00:00",
            "commentlist": [],
            "likeTotal": 3,
            "likes": [],
            "lbs": {"address": "上海市静安区", "name": "南京西路"},
            "pic": [],
            "video": [],
            "post_url": f"https://user.qzone.qq.com/{OWNER_UIN}/mood/{id_qze_only}",
        },
        {
            "tid": "no-time-record",
            "content": "这条没有绝对时间戳，知识库应当跳过它。",
            "custom_content": "这条没有绝对时间戳，知识库应当跳过它。",
            "created_time": 0,
            "commentlist": [],
            "likeTotal": 0,
            "likes": [],
            "pic": [],
            "video": [],
        },
    ]
    json_path.write_text(json.dumps(messages, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---------------- Rust 归档 SQLite ----------------
    if db_path.exists():
        db_path.unlink()
    connection = sqlite3.connect(db_path)
    connection.executescript(SCHEMA)

    def add_dynamic(cell_id, published_at, content, category="self"):
        connection.execute(
            "INSERT INTO archive_dynamics (owner_uin,cell_id,published_at,content,author_uin,"
            "author_name,category,pictures_json,video_json,raw_original_json,archived_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (OWNER_UIN, cell_id, published_at, content, OWNER_UIN, "示例账号", category,
             None, None, "{}", 1700000000),
        )

    def add_feed(feed_key, cell_id, event_type, event_time, actor_uin, actor_name,
                 comments_json=None, summary=None):
        connection.execute(
            "INSERT INTO archive_feeds (owner_uin,feed_key,cell_id,event_type,event_time,title,"
            "content,event_summary,actor_uin,actor_name,original_author_uin,original_author_name,"
            "picture_count,pictures_json,video_json,comments_json,raw_json,archived_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (OWNER_UIN, feed_key, cell_id, event_type, event_time, None, None, summary,
             actor_uin, actor_name, OWNER_UIN, "示例账号", 0, None, None, comments_json,
             "{}", 1700000000),
        )

    # 1) 两源共有：可见说说 + 评论 + 点赞
    add_dynamic(id_shared, ts_shared, "今天把 QQ 空间历史说说整理成离线网页了，翻旧内容终于不再费劲。")
    add_feed(f"217:{id_shared}:{ts_shared}:10001", id_shared, 217, ts_shared + 600, "10001", "小刚")
    add_feed(f"217:{id_shared}:{ts_shared}:10002", id_shared, 217, ts_shared + 900, "10002", "小丽")
    add_feed(
        f"2:{id_shared}:{ts_shared + 3600}:10003", id_shared, 2, ts_shared + 3600, "10003", "小明",
        comments_json=json.dumps({
            "main_comment": {
                "commentid": "c1", "user": {"uin": "10003", "nickname": "小明"},
                "content": "牛啊", "date": ts_shared + 3600,
                "replys": [{"user": {"uin": OWNER_UIN, "nickname": "示例账号"},
                            "content": "折腾了大半年", "date": ts_shared + 7200}],
            }
        }, ensure_ascii=False),
        summary="牛啊",
    )

    # 2) 仅归档库有：已删除说说，但保留了标准说说 ID → 可反解真实发布时间
    add_dynamic(id_recovered, ts_recovered, "当年最后一次跨年是在外滩，人很多。")
    add_feed(f"history-v2-event:217:{id_recovered}:{ts_recovered + 86400}", id_recovered, 217,
             ts_recovered + 86400, "20001", "好友甲")
    add_feed(
        f"history-v2-event:2:{id_recovered}:{ts_recovered + 90000}", id_recovered, 2,
        ts_recovered + 90000, "20002", "好友乙",
        comments_json=json.dumps({
            "main_comment": {
                "commentid": "c2", "user": {"uin": "20002", "nickname": "好友乙"},
                "content": "外滩我记着呢", "date": ts_recovered + 90000,
            }
        }, ensure_ascii=False),
        summary="外滩我记着呢",
    )

    # 3) 仅归档库有：哈希型历史卡片 → 发布时间不可考，只能用互动时间近似
    add_dynamic(id_hash_only, ts_interaction, "那年冬天在南方过了第一个春节。")
    add_feed(f"history-v2-event:2:{id_hash_only}:{ts_interaction}", id_hash_only, 2,
             ts_interaction, "20003", "好友丙",
             comments_json=json.dumps({
                 "main_comment": {
                     "commentid": "c3", "user": {"uin": "20003", "nickname": "好友丙"},
                     "content": "新年快乐", "date": ts_interaction,
                 }
             }, ensure_ascii=False),
             summary="新年快乐")

    # 4) 留言板
    add_dynamic(id_guestbook, ts_shared, "愿你快乐", category="guestbook")
    add_feed(f"history-v2-event:334:{id_guestbook}:{ts_shared}", id_guestbook, 334,
             ts_shared, "20004", "留言好友", summary="愿你快乐")

    connection.commit()
    connection.close()
    return json_path, db_path


if __name__ == "__main__":
    import sys
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures")
    json_out, db_out = build(target)
    print(f"✅ 合成数据：\n   {json_out}\n   {db_out}")
