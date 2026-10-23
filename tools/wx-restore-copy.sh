#!/bin/bash
# 还原原版微信（把 tools/wx-prepare-copy.sh 换上去的副本换回来）。
#
# 用法：
#   bash tools/wx-restore-copy.sh
#
# 原理：原版一直保留在 /Applications/WeChat.app.orig，
# 这里把它换回 /Applications/WeChat.app，副本挪到 .replaced 待确认。

set -euo pipefail

APP=/Applications/WeChat.app
ORIG=/Applications/WeChat.app.orig
OLD=/Applications/WeChat.app.replaced

if [ ! -e "$ORIG" ]; then
  echo "没有 $ORIG —— 微信本来就是原版，不需要还原。"
  exit 0
fi

echo "=== 1/3 换回原版 ==="
if [ -e "$APP" ]; then
  mv "$APP" "$OLD"
  echo "✅ 副本挪到 $OLD"
fi
mv "$ORIG" "$APP"
echo "✅ 原版已换回 $APP"

echo
echo "=== 2/3 校验 ==="
ls -ld "$APP"
codesign -dvvv "$APP" 2>&1 | grep -E "^Identifier=|^TeamIdentifier=|^CDHash=" || true
codesign --verify --deep --strict "$APP" && echo "✅ 深度校验通过" || echo "⚠️ 深度校验没过"

echo
echo "=== 3/3 收尾 ==="
echo "旧的副本留在 ${OLD}，确认微信能正常启动后可以删掉："
echo "  rm -rf ${OLD}"
echo
echo "提示：微信属主应已恢复为 root。若不是，跑："
echo "  sudo chown -R root:wheel ${APP}"
