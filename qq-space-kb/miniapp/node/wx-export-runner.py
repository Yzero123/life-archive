#!/usr/bin/env python3
"""微信朋友圈取数工具（2.0）。

只做一件事：**把朋友圈动态读出来，导成一份 JSON**。
解密不归它管——解密是外部能力（方式 B 用现成工具，方式 A 由二期补上），
本工具只认**已经解开的 sns.db**。

与 1.0 的关系：和 QQ 空间的导出器同构——外部工具产出 raw JSON，
Node 侧只负责解析入库。这样解密能力可以随时替换/降级，入库逻辑始终在我们手里。

用法：
    # 1. 指定已解密的 sns.db
    python3 wx-export-runner.py parse --db <path/to/sns.db> --out <path/to/wechat_sns.json>

    # 2. 不指定 --db，自动找（已解密的优先）
    python3 wx-export-runner.py parse --out <path/to/wechat_sns.json>

    # 3. 看看本机有什么
    python3 wx-export-runner.py discover

只取**本人**发的动态：按发布者 wxid 过滤（--owner，默认自动取账号基名）。
好友发的朋友圈不是「我发的」，放进知识库等于让 bot 替别人说话——
和 1.0 的作者归属过滤是同一套思路。

输出形状（契约）与 SIWX 的 JSON 导出**完全一致**：``{"meta": {...}, "posts": [...]}``。
于是同一份解析器能吃两种来源：SIWX 导出来的直接能用，本工具导出来的也能用，
中间不需要任何转换。

只依赖 Python 标准库。
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

# 说说 ID 的位布局（实测规律）：
#   snsId = (createTime_ms << 23) | random(23 bit)
SNS_ID_SHIFT = 23
SNS_ID_MASK = 0xFFFFFFFFFFFFFFFF

# ContentObject/type 的实测枚举。注意：这些名字是**按实际字段反推**的，
# 早期按外部资料推断的名字有偏差（type 42/47 其实是音乐分享，26 是笔记），
# 所以这里只用作**人读标签**，机器判断一律看实际字段。
CONTENT_TYPES = {
    1: "文字", 2: "图片", 3: "链接", 7: "音乐", 15: "视频",
    26: "笔记", 28: "视频号", 34: "视频号直播", 42: "音乐分享",
    47: "笔记", 54: "公众号文章",
}

# 微信把「没有这个值」写成 "0" 而不是省略属性。
# 只能按**字符串语义**判断：Python 里 "0" 是真值，用 `or` 串起来会当成有效值。
_NULL_ATTRS = frozenset({"", "0", "none", "null"})

SQLITE_MAGIC = b"SQLite format 3\x00"


def _int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _meta_attr(*values) -> str | None:
    """取第一个「有效」的值；"" / "0" / "none" 一律视为缺失。"""
    for value in values:
        if value is None:
            continue
        text = value.strip() if isinstance(value, str) else str(value).strip()
        if text and text.lower() not in _NULL_ATTRS:
            return text
    return None


def _txt(el, tag: str) -> str:
    if el is None:
        return ""
    return (el.findtext(tag) or "").strip()


# ---------------------------------------------------------------------------
# 说说 ID ↔ 时间
# ---------------------------------------------------------------------------

def sns_id_to_ms(sns_id: int) -> int:
    """snsId → 毫秒时间戳。

    SQLite 把 snsId 存成**有符号 int64**，读出来常是负数，
    要先按无符号 64 位还原再右移。
    """
    if sns_id < 0:
        sns_id += 1 << 64
    return sns_id >> SNS_ID_SHIFT


def sns_id_to_seconds(sns_id: int) -> int:
    return sns_id_to_ms(sns_id) // 1000


# ---------------------------------------------------------------------------
# XML → 结构化动态
# ---------------------------------------------------------------------------

def _parse_media(el) -> dict:
    """解析一个媒体元素（mediaList/media / imageinfo / liveMedia 同构）。

    **只取链接与描述，不下载**（2.0 的决定）：图片视频走 CDN + ISAAC64，
    工程量大且微信 CDN 上约 58% 的旧图已失效，对 bot 画像收益有限。
    保留 url / 描述 / 尺寸 / md5，够模型说清「这条配了几张图、什么内容」。
    """
    url_el = el.find("url")
    sz = el.find("size")
    width = height = 0
    if sz is not None:
        width = _int(sz.get("width"))
        height = _int(sz.get("height"))
    if not (width or height):
        width = _int(el.findtext("width"))
        height = _int(el.findtext("height"))
    if not (width or height):
        vs = el.find("videoSize")
        if vs is not None:
            width = _int(vs.get("width"))
            height = _int(vs.get("height"))
    thumb_el = el.find("thumb")
    return {
        "type": _int(el.findtext("type")),
        "width": width,
        "height": height,
        "url": (url_el.text or "").strip() if url_el is not None else "",
        "thumb_url": (el.findtext("thumb_url") or el.findtext("thumb") or "").strip(),
        "md5": (url_el.get("md5") if url_el is not None else None) or el.findtext("md5") or "",
        "description": el.findtext("description") or "",
        "title": el.findtext("title") or "",
        "duration": el.findtext("videoDuration") or "",
    }


def _parse_card(co, to) -> dict | None:
    """从实际存在的字段推导卡片类型（不靠 type 编号猜）。"""
    if co is None:
        return None

    link = co.find("linkArticle") or co.find("link_item")
    if link is not None:
        return {
            "kind": "link",
            "title": _txt(link, "title"),
            "desc": _txt(link, "desc"),
            "url": _txt(link, "url"),
        }

    music = co.find("musicShareItem")
    if music is not None:
        return {
            "kind": "music",
            "title": _txt(music, "title"),
            "desc": _txt(music, "desc"),
            "singer": _txt(music, "singer"),
            "album": _txt(music, "album"),
            "url": _txt(music, "url"),
        }

    finder = co.find("finderFeed")
    if finder is not None:
        return {
            "kind": "finder_feed",
            "nickname": _txt(finder, "nickname"),
            "desc": _txt(finder, "desc"),
            "title": _txt(finder, "title"),
        }

    live = co.find("finderLive") or co.find("live")
    if live is not None:
        return {
            "kind": "finder_live",
            "nickname": _txt(live, "nickname"),
            "desc": _txt(live, "desc"),
        }

    note = co.find("noteinfo") or co.find("noteInfo")
    if note is not None:
        return {
            "kind": "note",
            "title": _txt(note, "title"),
            "desc": _txt(note, "desc"),
            "text": _txt(note, "text"),
        }
    return None


_BARE_AMP = re.compile(rb"&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)")


def _fix_bare_amp(raw: bytes) -> bytes:
    """微信生成的 XML **不转义裸 &**。

    公众号文章链接里全是 ``&mid=`` ``&idx=`` ``&sn=``，标准 XML 解析器看到
    裸 ``&`` 会直接判 not well-formed 然后整条丢掉。
    实测 1067 行里有 378 行栽在这上面——而且几乎全是带公众号链接的动态，
    恰恰是内容最值得留的那些。

    只补真正的裸 ``&``，已经转义过的（``&amp;`` ``&#38;`` 等）不动。
    """
    return _BARE_AMP.sub(b"&amp;", raw)


def parse_timeline(content) -> dict | None:
    """解析 ``SnsTimeLine.content`` 的 XML → 结构化动态。

    容错：先补裸 ``&`` 再解析；实在解析不了就返回 None 让调用方记账，别静默丢。
    """
    if isinstance(content, str):
        content = content.encode("utf-8", "ignore")
    if not content:
        return None
    try:
        root = ET.fromstring(_fix_bare_amp(content))
    except ET.ParseError:
        return None

    to = root.find("TimelineObject")
    if to is None:
        return None

    co = to.find("ContentObject")
    ctype = _int(co.findtext("type")) if co is not None else 0

    medias = []
    if co is not None:
        ml = co.find("mediaList")
        if ml is not None:
            for m in ml.findall("media"):
                item = _parse_media(m)
                if item.get("url") or item.get("thumb_url") or item.get("description"):
                    medias.append(item)

    # 互动：LocalExtraInfo 里点赞和评论混在一起，用「有没有内容」区分
    likes, comments = [], []
    author_name = ""
    extra = root.find("LocalExtraInfo")
    if extra is not None:
        # LocalExtraInfo.nickname 是**这条动态的作者**的昵称
        author_name = extra.findtext("nickname") or ""
        for uc in extra.iter("user_comment"):
            item = {
                "username": uc.findtext("username") or "",
                "nickname": uc.findtext("nickname") or "",
                "content": uc.findtext("content") or "",
                "create_time": _int(uc.findtext("create_time")),
                "type": _int(uc.findtext("type")),
                "deleted": _int(uc.findtext("b_deleted")),
                "has_emoji": uc.find("emojiinfo") is not None,
                "has_image": uc.find("imageinfo") is not None,
            }
            # 有内容 / 表情 / 图片 / type=2 → 评论，否则点赞
            if item["content"] or item["type"] == 2 or item["has_emoji"] or item["has_image"]:
                comments.append(item)
            else:
                likes.append(item)

    loc = to.find("location")
    location = None
    if loc is not None and loc.attrib:
        name = loc.get("poiName") or ""
        address = loc.get("poiAddress") or ""
        lat = loc.get("latitude") or ""
        lng = loc.get("longitude") or ""
        # 多数动态的坐标是 0,0 占位，没有名字/地址就不算「有位置」
        has_coord = bool(lat and lng and (lat != "0" or lng != "0"))
        if name or address or has_coord:
            location = {"name": name, "address": address}

    tid = to.findtext("id") or ""
    try:
        tid_int = int(tid)
    except (TypeError, ValueError):
        tid_int = 0

    create_time = _int(to.findtext("createTime"))
    if not create_time and tid_int:
        create_time = sns_id_to_seconds(tid_int)

    return {
        "tid": tid,
        "username": to.findtext("username") or "",
        "author_name": author_name,
        "source_username": to.findtext("sourceUserName") or "",
        "create_time": create_time,
        "content": to.findtext("contentDesc") or "",
        "content_type": ctype,
        "content_kind": CONTENT_TYPES.get(ctype, f"类型{ctype}"),
        "private": _int(to.findtext("private")),
        "is_top": _int(to.findtext("isTop")),
        "location": location,
        "media": medias,
        "card": _parse_card(co, to),
        "likes": likes,
        "comments": comments,
    }


# ---------------------------------------------------------------------------
# 找库
# ---------------------------------------------------------------------------

def _wechat_roots() -> list[Path]:
    roots = []
    home = Path.home()
    mac = home / "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files"
    if mac.is_dir():
        roots.append(mac)
    win = home / "Documents/WeChat Files"
    if win.is_dir():
        roots.append(win)
    return roots


def _is_decrypted(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(16) == SQLITE_MAGIC
    except OSError:
        return False


def discover() -> list[dict]:
    """列出本机所有候选 sns.db，标出哪些已解密。"""
    found = []
    for root in _wechat_roots():
        for path in sorted(root.glob("*/db_storage/sns/sns.db")):
            found.append({
                "path": str(path),
                "account": path.parents[2].name,
                "decrypted": _is_decrypted(path),
                "size": path.stat().st_size,
            })
    # 外部工具（方式 B）解出来的库通常放在工作目录下的 output/
    cwd = Path.cwd()
    for path in sorted(cwd.glob("output/*/sns/sns.db")):
        found.append({
            "path": str(path),
            "account": path.parents[1].name,
            "decrypted": _is_decrypted(path),
            "size": path.stat().st_size,
        })
    return found


def pick_db(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit).expanduser()
        if not path.exists():
            raise SystemExit(f"指定的文件不存在：{path}")
        return path
    candidates = [item for item in discover() if item["decrypted"]]
    if not candidates:
        raise SystemExit(
            "没有找到**已解密**的 sns.db。\n"
            "朋友圈库是 SQLCipher 加密的，原始文件不能直接读。\n"
            "请先用外部工具把 sns.db 解开（方式 B），再指向解出来的那个文件。\n"
            "可以先跑 `python3 wx-export-runner.py discover` 看看本机有什么。"
        )
    return Path(candidates[0]["path"])


def pick_owner(db_path: Path, explicit: str | None) -> str:
    """账号 wxid 基名。目录名常带设备后缀（_4160），要剥掉。"""
    if explicit:
        return explicit
    account = db_path.parents[2].name if len(db_path.parents) > 2 else db_path.parent.name
    return account.split("_")[0]


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def _public_card(card: dict | None) -> dict | None:
    """卡片 → 对外形状。

    对齐 SIWX 的 ``public_card``：``desc`` 叫 ``description``，
    音乐/视频号/直播/笔记的子结构单独挂到 ``music`` / ``finder`` / ``live`` / ``note``。
    插件侧的解析器认的是这套形状——**一个契约、两个生产者**，
    SIWX 导出来的 JSON 可以直接喂进插件，不用转格式。
    """
    if not card:
        return None
    kind = card.get("kind")
    out = {
        "kind": kind,
        "title": card.get("title") or "",
        "description": card.get("desc") or "",
        "url": card.get("url") or "",
        "source": card.get("source") or "",
    }
    if kind == "music":
        out["music"] = {"singer": card.get("singer") or "", "album": card.get("album") or ""}
    elif kind == "finder_feed":
        out["kind"] = "finder"
        out["finder"] = {"nickname": card.get("nickname") or ""}
    elif kind == "finder_live":
        out["kind"] = "live"
        out["live"] = {"nickname": card.get("nickname") or ""}
    elif kind == "note":
        out["note"] = {"text": card.get("text") or ""}
    return out


def _public_media(media: dict, index: int) -> dict:
    """媒体 → 对外形状。``type`` 用 ``image`` / ``video`` 字符串。"""
    duration = media.get("duration") or ""
    is_video = media.get("type") == 6 or (duration and float(duration) > 0)
    return {
        "index": index,
        "type": "video" if is_video else "image",
        "width": media.get("width") or 0,
        "height": media.get("height") or 0,
        "url": media.get("url") or "",
        "thumb": media.get("thumb_url") or "",
        "md5": media.get("md5") or "",
    }


def _time_text(ts: int) -> str:
    if not ts:
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))


def parse(db_path: Path, owner: str, out_path: Path, scope: str = "mine") -> dict:
    """把已解密的 sns.db 导成 JSON。

    scope="mine"：只导本人发的朋友圈（2.0 的原始行为，输出形状不变）。
    scope="all" ：导全部作者的动态，并额外标出**我**在别人朋友圈下的
                  评论（myComments）和点赞（myLike）。好友的原文只是
                  上下文，真正进知识库的是「我」说过的话。
    """
    if not _is_decrypted(db_path):
        raise SystemExit(
            f"{db_path} 还是加密的（文件头不是 SQLite）。\n"
            "请先用外部工具解密，再指向解密后的文件。"
        )
    # 微信在线时 db 正在写；只读打开 + WAL 让 sqlite 自己合并。
    uri = f"file:{db_path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    try:
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if "SnsTimeLine" not in tables:
            raise SystemExit(
                f"{db_path} 里没有 SnsTimeLine 表（现有表：{sorted(tables)[:10]}）。\n"
                "这可能不是朋友圈库，或者微信版本结构变了。"
            )
        rows = conn.execute("SELECT tid, user_name, content FROM SnsTimeLine").fetchall()
    finally:
        conn.close()

    posts, not_mine, failed = [], 0, 0
    my_comment_total, my_like_total = 0, 0
    for tid, user_name, content in rows:
        feed = parse_timeline(content)
        if feed is None:
            failed += 1
            continue
        created = feed.get("create_time") or 0
        likes = feed.get("likes", [])
        comments = feed.get("comments", [])

        if scope == "mine" and owner and user_name != owner:
            not_mine += 1
            continue

        post = {
            "tid": str(tid),
            "id": str(feed.get("tid") or tid),
            "time": created,
            "timeText": _time_text(created),
            "author": feed.get("username") or user_name or "",
            "text": feed.get("content") or "",
            "kind": feed.get("content_type") or 0,
            "card": _public_card(feed.get("card")),
            "private": bool(feed.get("private")),
            "location": feed.get("location"),
            "likes": [
                {"name": item.get("nickname") or item.get("username") or "",
                 "username": item.get("username") or "",
                 "time": item.get("create_time") or 0}
                for item in likes
            ],
            "comments": [
                {"name": item.get("nickname") or item.get("username") or "",
                 "username": item.get("username") or "",
                 "text": item.get("content") or "",
                 "time": item.get("create_time") or 0}
                for item in comments
            ],
            "media": [
                _public_media(item, index)
                for index, item in enumerate(feed.get("media", []))
            ],
        }

        if scope == "all":
            mine_comments = [
                {"name": item.get("nickname") or item.get("username") or "",
                 # 保留 username：插件要**自己再核对一次**归属，
                 # 不能全信外部数据里的「这是我的」标记。
                 "username": item.get("username") or "",
                 "text": item.get("content") or "",
                 "time": item.get("create_time") or 0}
                for item in comments
                if owner and item.get("username") == owner
            ]
            mine_likes = [
                item for item in likes if owner and item.get("username") == owner
            ]
            post["authorName"] = feed.get("author_name") or ""
            post["myLike"] = bool(mine_likes)
            # 点赞时间（like_user_list 里带 create_time）
            post["myLikeTime"] = (mine_likes[0].get("create_time") or 0) if mine_likes else 0
            post["myComments"] = mine_comments
            my_comment_total += len(mine_comments)
            my_like_total += 1 if mine_likes else 0

        posts.append(post)

    posts.sort(key=lambda item: item.get("time") or 0)

    times = [item["time"] for item in posts if item.get("time")]
    payload = {
        "meta": {
            "account": owner,
            "exportedAt": _time_text(int(time.time())),
            "count": len(posts),
            "format": "json",
            # 标明生产者：插件解析器不挑，但排查问题时得知道这份 JSON 是谁产的
            "source": "qq-space-kb-wx-runner",
            "scope": scope,
            "range": {
                "start": min(times) if times else 0,
                "end": max(times) if times else 0,
            },
            "stats": {
                "rows_in_table": len(rows),
                "kept": len(posts),
                "not_mine": not_mine,
                "parse_failed": failed,
            },
        },
        "posts": posts,
    }
    if scope == "all":
        payload["meta"]["myComments"] = my_comment_total
        payload["meta"]["myLikes"] = my_like_total
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="微信朋友圈取数工具（2.0）")
    sub = parser.add_subparsers(dest="command", required=True)

    p_parse = sub.add_parser("parse", help="把已解密的 sns.db 导成 JSON")
    p_parse.add_argument("--db", default="", help="已解密的 sns.db 路径（不给就自动找）")
    p_parse.add_argument("--owner", default="", help="账号 wxid（不给就按目录名推断）")
    p_parse.add_argument("--out", default="", help="输出 JSON 路径")
    p_parse.add_argument(
        "--scope", default="mine", choices=["mine", "all"],
        help="mine=只导本人发的（默认）；all=导全部作者，并标出我在别人朋友圈下的评论与点赞",
    )

    p_discover = sub.add_parser("discover", help="列出本机候选的 sns.db")
    p_discover.add_argument("--json", action="store_true", help="按 JSON 输出")

    args = parser.parse_args(argv)

    if args.command == "discover":
        items = discover()
        if args.json:
            print(json.dumps(items, ensure_ascii=False, indent=2))
        else:
            if not items:
                print("本机没找到 sns.db。")
            for item in items:
                state = "已解密" if item["decrypted"] else "加密（需先解密）"
                print(f"  {state:16} {item['size'] / 1048576:6.1f} MB  {item['path']}")
        return 0

    out = Path(args.out).expanduser() if args.out else Path.cwd() / "wechat_sns.json"
    db_path = pick_db(args.db or None)
    owner = pick_owner(db_path, args.owner or None)
    payload = parse(db_path, owner, out, scope=args.scope)
    stats = payload["meta"]["stats"]
    print(f"✅ 导出 {stats['kept']} 条朋友圈 → {out}")
    print(f"   表内共 {stats['rows_in_table']} 条；不是我的 {stats['not_mine']} 条；"
          f"解析失败 {stats['parse_failed']} 条")
    if args.scope == "all":
        print(f"   其中我在别人朋友圈下评论 {payload['meta'].get('myComments', 0)} 条、"
              f"点赞 {payload['meta'].get('myLikes', 0)} 次")
    print("   把这个文件交给插件的「微信朋友圈」面板导入即可。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
