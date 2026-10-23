#!/bin/bash
# 朋友圈本地窗口体检 + 增量检测
#
# 用途：验证「在微信客户端里往回翻朋友圈」之后，本地 sns.db 到底有没有多出更早的记录。
#
# 用法：
#   bash tools/wx-window-check.sh            # 体检（先跑一次作为基线）
#   bash tools/wx-window-check.sh --sync     # 顺便跑一次全量同步再体检
#
# 原理：朋友圈历史存在微信服务端，本地 sns.db 只保留一个滑动的缓存窗口。
# 客户端往回翻会把更早的数据拉下来写进本地库 —— 这个脚本用两次体检的差值来验证。

set -uo pipefail

API="${WECHAT_TOOL_API:-http://127.0.0.1:10392}"
ACCOUNT="${WECHAT_TOOL_ACCOUNT:-}"
SNAP_ROOT="${SNAP_ROOT:-$HOME/Library/Application Support/wechat-data-analysis-desktop/output/databases}"
PY="${PY:-$HOME/.local/bin/python3.11}"
[ -x "$PY" ] || PY=python3

if [ -z "$ACCOUNT" ]; then
  ACCOUNT=$(ls -1 "$SNAP_ROOT" 2>/dev/null | head -1)
fi
if [ -z "$ACCOUNT" ]; then
  echo "找不到账号目录。在 $SNAP_ROOT 下没找到任何账号，先跑一次 full_sync 或问工具要 account。" >&2
  exit 1
fi

SNAP="$SNAP_ROOT/$ACCOUNT/sns.db"
echo "账号: $ACCOUNT"

if [ "${1:-}" = "--sync" ]; then
  echo "== 跑全量同步 =="
  curl -s -X POST "$API/api/sns/realtime/full_sync?account=$ACCOUNT" -m 30 | head -c 200
  echo
  for _ in $(seq 1 60); do
    ST=$(curl -s "$API/api/sns/realtime/full_sync/status?account=$ACCOUNT" -m 20 \
         | "$PY" -c "import json,sys; print((json.load(sys.stdin).get('job') or {}).get('status','none'))" 2>/dev/null)
    [ "$ST" = "running" ] || break
    sleep 3
  done
  echo "全量同步结束 (status=$ST)"
fi

if [ ! -f "$SNAP" ]; then
  echo "快照不存在: $SNAP" >&2
  exit 1
fi

"$PY" - "$SNAP" "$ACCOUNT" <<'PY'
import sqlite3, re, sys, datetime, collections
db, account = sys.argv[1], sys.argv[2]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
rows = con.execute("SELECT tid,user_name,content FROM SnsTimeLine").fetchall()

mine, byyear = [], collections.Counter()
for tid, un, content in rows:
    m = re.search(r"<createTime>(\d+)</createTime>", content or "")
    if not m:
        continue
    dt = datetime.datetime.fromtimestamp(int(m.group(1)))
    byyear[dt.year] += 1
    if un == account:
        mine.append((dt, tid, content or ""))

mine.sort()
print(f"\n=== 本地缓存窗口体检 ===")
print(f"快照总行数        : {len(rows)}")
print(f"全库年份分布      : " + " / ".join(f"{y}:{byyear[y]}" for y in sorted(byyear)))
if mine:
    print(f"本人名下行数      : {len(mine)}")
    print(f"本人最早一条      : {mine[0][0].strftime('%Y-%m-%d')}")
    print(f"本人最晚一条      : {mine[-1][0].strftime('%Y-%m-%d')}")
    empt = [d for d, _, c in mine if len(re.search(r'<contentDesc>(.*?)</contentDesc>', c, re.S).group(1).strip()) == 0
            if re.search(r'<contentDesc>(.*?)</contentDesc>', c, re.S)]
    print(f"其中无正文行      : {len(empt)}")
else:
    print("本人名下行数      : 0")
print("\n对比上一次体检：若「本人最早一条」变早、或行数变多，说明往回翻确实把更早的历史拉进了本地库。")
PY
