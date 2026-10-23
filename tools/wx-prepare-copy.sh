#!/bin/bash
# 把微信换成自己的副本，让 WeChatDataAnalysis 的临时重签能过权限门。
#
# 为什么需要：工具要就地临时重签 /Applications/WeChat.app，代码里有道硬检查——
# 当前用户必须能直接写入这个 app 目录。macOS 默认它是 root:wheel 755，写不进去。
#
# 为什么不用 sudo：sudo chgrp 改「已安装 app 的元数据」会被 macOS 的 App 管理（TCC）拦，
# 报 Operation not permitted，连 root 都不放行。但**移动 app 不拦**（本机实测）。
# 而 /Applications 对 admin 组可写，所以普通用户就能把 app 换成自己的副本。
#
# 副本的属主变成你 → os.access(W_OK) 为真 → 权限门直接过；
# 副本放在 /Applications 下 codesign 重签实测成功 → 工具的临时重签不会卡。
#
# 用法：
#   bash tools/wx-prepare-copy.sh      # 准备
#   bash tools/wx-restore-copy.sh      # 还原
#
# 可回退：原版一直保留在 /Applications/WeChat.app.orig，一条 mv 就能换回来。

set -euo pipefail

APP=/Applications/WeChat.app
ORIG=/Applications/WeChat.app.orig

echo "=== 1/5 检查微信是否已完全退出 ==="
if pgrep -f "/Applications/WeChat.app/Contents/MacOS/WeChat" >/dev/null 2>&1; then
  echo "微信还在运行。请先完全退出（⌘Q，不是关窗口），再跑一次本脚本。"
  exit 1
fi
echo "✅ 微信未运行"

echo
echo "=== 2/5 检查前置状态 ==="
if [ -e "$ORIG" ]; then
  echo "已存在 $ORIG —— 说明之前换过一次。先跑 tools/wx-restore-copy.sh 还原，再重新准备。"
  exit 1
fi
if [ ! -d "$APP" ]; then
  echo "找不到 ${APP}，微信是不是装在别的位置？"
  exit 1
fi
echo "✅ 前置状态正常"

echo
echo "=== 3/5 把原版挪到 .orig（这一步实测不会被 App 管理拦）==="
mv "$APP" "$ORIG"
echo "✅ 已保留原版到 $ORIG"

echo
echo "=== 4/5 用 ditto 复制一份回来（保留签名与 xattr，走 APFS 写时复制，约 3 秒）==="
ditto "$ORIG" "$APP"
echo "✅ 副本已就位"

echo
echo "=== 5/5 校验副本 ==="
echo "--- 属主与权限（属主应是你）---"
ls -ld "$APP"
echo "--- 签名（TeamIdentifier 应为 5A4RE8SF68，CDHash 应与原版一致）---"
codesign -dvvv "$APP" 2>&1 | grep -E "^Identifier=|^TeamIdentifier=|^CDHash=" || true
echo "--- 深度校验 ---"
codesign --verify --deep --strict "$APP" && echo "✅ 深度校验通过" || echo "⚠️ 深度校验没过，先别继续"
echo "--- 可写性（工具的权限门判据）---"
python3 -c "import os,sys; print('os.access(W_OK) =', os.access('$APP', os.W_OK))"

echo
echo "========================================================"
echo "完成。剩下三步："
echo
echo "  1) 系统设置 → 隐私与安全性 → 开发者工具 → 微信 → 打开「允许附加调试器」"
echo "  2) 打开微信并登录"
echo "  3) WeChatDataAnalysis 里点「获取」→ 确认切兜底路径 → 走状态机"
echo
echo "抓完密钥后建议还原：bash tools/wx-restore-copy.sh"
echo "========================================================"
