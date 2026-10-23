#!/usr/bin/env python3
"""WeChatDataAnalysis 抓密钥 · 路径可行性预判。

在点「获取」之前先算清楚：这次到底能走哪条路、要先做哪一步。
纯只读探测——不改系统状态、不写目标进程、不注入任何东西。

用法：
    python3 wx-path-check.py
    python3 wx-path-check.py <pid>        # 只查指定 pid

判据来自 WeChatDataAnalysis 官方源码：
  macos_db_key_helper._process_access_denied_error()
    → target_hardened_runtime=True 且 target_get_task_allow=False
      ⇒ 必然返回 TARGET_PROCESS_PROTECTED，与「开发者工具」开关无关
  macos_db_key_capture.ensure_wechat_in_place_debuggable()
    → os.access(微信目录, W_OK) 与 os.access(/Applications, W_OK)
      任一为 False ⇒ 返回 in_place_restore_permissions_unsafe
"""

from __future__ import annotations

import ctypes
import ctypes.util
import os
import re
import subprocess
import sys
from pathlib import Path

WECHAT_APP = Path("/Applications/WeChat.app")
WECHAT_MAIN = "/Applications/WeChat.app/Contents/MacOS/WeChat"
TASK_FOR_PID = 4
MACH_TASK_SELF = ctypes.c_void_p.in_dll(ctypes.CDLL("/usr/lib/libSystem.B.dylib"), "mach_task_self").value

OK, WARN, BAD = "✅", "⚠️ ", "❌"


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return f"{result.stdout}\n{result.stderr}"


def find_wechat_pids() -> list[int]:
    out = subprocess.run(["/bin/ps", "-axo", "pid=,command="], capture_output=True, text=True, check=False).stdout
    pids: list[int] = []
    for line in out.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        if parts[1].strip() == WECHAT_MAIN:
            pids.append(pid)
    return pids


def task_port(pid: int) -> int:
    lib = ctypes.CDLL(ctypes.util.find_library("System") or "/usr/lib/libSystem.B.dylib", use_errno=True)
    lib.task_for_pid.restype = ctypes.c_int
    lib.task_for_pid.argtypes = [ctypes.c_uint32, ctypes.c_int]
    return int(lib.task_for_pid(MACH_TASK_SELF, pid))


def signature_state() -> dict:
    """读当前微信的签名事实：hardened runtime / get-task-allow / ad-hoc。"""
    info = run(["/usr/bin/codesign", "-dvvv", str(WECHAT_APP)])
    entitlements = run(["/usr/bin/codesign", "-d", "--entitlements", ":", str(WECHAT_APP)])
    return {
        "hardened_runtime": bool(re.search(r"flags=.*\bruntime\b", info)),
        "ad_hoc": "Signature=adhoc" in info or bool(re.search(r"flags=0x[0-9a-fA-F]+\(adhoc", info)),
        "get_task_allow": "com.apple.security.get-task-allow" in entitlements
        and re.search(r"com\.apple\.security\.get-task-allow</key>\s*<true/>", entitlements) is not None,
        "team": (re.search(r"^TeamIdentifier=(\S+)", info, re.MULTILINE) or [None, ""])[1]
        if re.search(r"^TeamIdentifier=(\S+)", info, re.MULTILINE) else "",
    }


def devtools_state() -> str:
    out = run(["/usr/sbin/DevToolsSecurity", "-status"]).strip()
    return out.splitlines()[0] if out else "unknown"


def taskgated_allow() -> list[str]:
    out = run(["/usr/bin/defaults", "read", "/Library/Preferences/com.apple.security.taskgated"])
    return [line.strip() for line in out.splitlines() if "xinWeChat" in line or "WeChat" in line]


def main() -> int:
    print("=" * 64)
    print("WeChatDataAnalysis 抓密钥 · 路径可行性预判")
    print("=" * 64)

    # ── 事实 1：微信签名 ──────────────────────────────────────────
    print("\n【1】微信当前签名")
    if not WECHAT_APP.exists():
        print(f"{BAD} 找不到 {WECHAT_APP}")
        return 2
    sig = signature_state()
    print(f"    hardened runtime  : {sig['hardened_runtime']}")
    print(f"    get-task-allow    : {sig['get_task_allow']}")
    print(f"    ad-hoc 签名       : {sig['ad_hoc']}")
    print(f"    TeamIdentifier    : {sig['team'] or '(无)'}")

    helper_ok = not (sig["hardened_runtime"] and not sig["get_task_allow"])
    if helper_ok:
        print(f"  {OK} 受控组件路径「可能」可用（需微信已重签或带 get-task-allow）")
    else:
        print(f"  {BAD} 受控组件路径必然失败 → TARGET_PROCESS_PROTECTED")
        print(f"      官方源码判据：hardened_runtime=True 且 get_task_allow=False")
        print(f"      官方明确说明：这与「开发者工具」开关无关，切了也没用")

    # ── 事实 2：安装目录写权限 ────────────────────────────────────
    print("\n【2】临时重签路径的权限门")
    app_w = os.access(WECHAT_APP, os.W_OK)
    dir_w = os.access(WECHAT_APP.parent, os.W_OK)
    print(f"    /Applications            可写: {dir_w}")
    print(f"    /Applications/WeChat.app 可写: {app_w}")
    st = WECHAT_APP.stat()
    print(f"    属主/权限: uid={st.st_uid} mode={oct(st.st_mode & 0o777)}")
    in_place_ok = app_w and dir_w
    if in_place_ok:
        print(f"  {OK} 临时重签路径可以通过权限门")
    else:
        print(f"  {BAD} 临时重签路径会被硬拦 → in_place_restore_permissions_unsafe")
        print(f"      修法（见指引 §3.4）：")
        print(f"        sudo chgrp admin /Applications/WeChat.app")
        print(f"        sudo chmod g+w /Applications/WeChat.app")
        print(f"      回退：")
        print(f"        sudo chgrp wheel /Applications/WeChat.app")
        print(f"        sudo chmod g-w /Applications/WeChat.app")

    # ── 事实 3：调试附加授权 ──────────────────────────────────────
    print("\n【3】调试附加授权（LLDB 附加需要）")
    dev = devtools_state()
    print(f"    DevToolsSecurity : {dev}")
    allowed = taskgated_allow()
    print(f"    taskgated 已授权  : {allowed if allowed else '(微信未在「允许附加调试器」列表里)'}")
    port_note = ""
    pids = [int(a) for a in sys.argv[1:] if a.isdigit()] or find_wechat_pids()
    for pid in pids:
        port = task_port(pid)
        port_note = f"pid {pid} task port = {port} {'(可达)' if port > 0 else '(不可达)'}"
        print(f"    {port_note}")
    print("    注：task port 可达只是必要条件；重签后的微信仍需 taskgated 授权才能附加。")

    # ── 结论 ──────────────────────────────────────────────────────
    print("\n" + "=" * 64)
    print("结论")
    print("=" * 64)
    if not in_place_ok:
        print(f"{BAD} 现在点「获取」大概率会失败。")
        print(f"    先做：sudo chgrp admin /Applications/WeChat.app && sudo chmod g+w /Applications/WeChat.app")
        print(f"    再做：完全退出并重开微信")
        print(f"    然后：工具里点「获取」，按状态机走（临时微信 → 进聊天页 → 退出账号 → 开始监测 → 等「监测已就绪」→ 重新登录）")
    elif not helper_ok:
        print(f"{WARN} 权限门已过，但受控组件路径仍会撞 TARGET_PROCESS_PROTECTED。")
        print(f"    走临时重签 + LLDB 兜底路径（工具会问你要不要切过去，点确认）。")
        print(f"    切过去后仍需 taskgated 对微信的「允许附加调试器」授权。")
    else:
        print(f"{OK} 两道门都过了，可以直接点「获取」。")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
