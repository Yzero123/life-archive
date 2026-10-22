#!/usr/bin/env python3
"""QQ 空间说说导出运行器。

由 Mini App 在开始导出时写入数据目录，再交给 Agent 调用。它只做三件事：

1. 保证导出工具就位（缺就 clone，依赖缺就装）。
2. **把抓取脚本完全挂到后台**（setsid 独立进程组），启动后立刻返回。
3. 把状态写进 status.json，调用方轮询这个文件即可汇报进度。

为什么必须挂后台
----------------
抓取脚本要等用户扫码（最长 1 小时），整轮抓取以小时计。如果把它挂在一次前台
工具调用里，工具调用一旦到达时限就会连带把进程杀掉，浏览器随之被关掉——
用户看到的就是「页面还没加载完就自动关闭」。

为什么绝不自动重开浏览器
------------------------
浏览器被关闭 = 用户主动中止（关错了窗口，或者不想继续了）。这时候自动重启
只会不停地弹窗、每次都要重新扫码，把人逼疯。所以这里**不做任何自动重跑**。
脚本退出就是退出，状态如实写进 status.json。断点会留在 result 目录里，
用户再点一次「开始导出」就从断点续上。

用法：
    python3 qq_export_runner.py --status <status.json 路径> [--owner <QQ号>]
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time

TOOL_REPO = "https://github.com/Christina-zhou/get-qzone-history.git"
TOOL_DIR_NAME = "get-qzone-history"
CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_WIN = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

# 脚本退出后，stdout/stderr 里出现这些片段就意味着「浏览器/页面被关闭」——
# 属于用户中止，不能当故障重试。
USER_ABORT_MARKERS = (
    "浏览器或页面已被关闭",
    "当前任务已中断",
    "Target closed",
    "Target page, context or browser has been closed",
    "Protocol error",
)


def write_status(path, **fields):
    payload = {"updatedAt": time.time()}
    payload.update(fields)
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError:
        pass


def browser_path():
    if os.path.exists(CHROME_MAC):
        return CHROME_MAC
    if os.path.exists(CHROME_WIN):
        return CHROME_WIN
    found = shutil.which("google-chrome") or shutil.which("chromium")
    return found or CHROME_MAC


def ensure_tool(work_dir):
    """确保工具目录存在，必要时 clone 并装依赖。返回 (工具目录, 若干提示行)。"""
    notes = []
    tool_dir = os.path.join(work_dir, TOOL_DIR_NAME)
    if not os.path.isdir(tool_dir):
        write = ["git clone --depth 1 %s %s" % (TOOL_REPO, tool_dir)]
        notes.append("正在克隆导出工具…")
        subprocess.run(write, check=True)
    if not os.path.isdir(os.path.join(tool_dir, "node_modules")):
        notes.append("正在安装 Node 依赖…")
        subprocess.run(["npm", "install"], cwd=tool_dir, check=False)
    requirements = os.path.join(tool_dir, "requirements.txt")
    if os.path.exists(requirements) and not os.path.exists(os.path.join(tool_dir, ".deps-installed")):
        subprocess.run([sys.executable, "-m", "pip", "install", "--user", "-r", requirements], check=False)
        try:
            open(os.path.join(tool_dir, ".deps-installed"), "w").close()
        except OSError:
            pass
    return tool_dir, notes


def latest_checkpoint(tool_dir):
    result_dir = os.path.join(tool_dir, "resource", "result")
    files = sorted(glob.glob(os.path.join(result_dir, "*.checkpoint.json")), key=os.path.getmtime)
    return files[-1] if files else ""


def checkpoint_state(path):
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def tail(path, limit=3000):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - limit))
            return fh.read()
    except OSError:
        return ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", required=True, help="status.json 输出路径")
    parser.add_argument("--work-dir", default="/tmp/qq-space-export-work")
    parser.add_argument("--owner", default="")
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--end-page", type=int, default=200)
    parser.add_argument("--page-wait-ms", type=int, default=20000)
    parser.add_argument("--segment-pages", type=int, default=10)
    parser.add_argument("--segment-pause-ms", type=int, default=180000)
    args = parser.parse_args()

    work_dir = os.path.abspath(args.work_dir)
    os.makedirs(work_dir, exist_ok=True)
    run_log = os.path.join(work_dir, "export-run.log")
    status_path = os.path.abspath(args.status)

    write_status(status_path, state="preparing", workDir=work_dir, log=run_log, notes=[])

    try:
        tool_dir, notes = ensure_tool(work_dir)
    except Exception as exc:  # noqa: BLE001
        write_status(status_path, state="failed", error="准备导出工具失败：%s" % exc)
        return 1

    checkpoint = latest_checkpoint(tool_dir)
    state = checkpoint_state(checkpoint)
    cmd = [
        "node", "get_qzone_history_browser.js",
        "--browser-path", browser_path(),
        "--start-page", str(args.start_page),
        "--end-page", str(args.end_page),
        "--page-wait-ms", str(args.page_wait_ms),
        "--segment-pages", str(args.segment_pages),
        "--segment-pause-ms", str(args.segment_pause_ms),
    ]
    if checkpoint and not state.get("is_final"):
        cmd += ["--resume-checkpoint", checkpoint]
        notes.append("从断点续跑：%s" % os.path.basename(checkpoint))

    # 关键：setsid 让抓取脚本脱离当前进程组，工具调用结束/超时都不会带走它，
    # 浏览器也就不会被连带关掉。
    with open(run_log, "ab") as log_fh:
        proc = subprocess.Popen(
            cmd,
            cwd=tool_dir,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )

    write_status(
        status_path,
        state="running",
        pid=proc.pid,
        log=run_log,
        checkpoint=checkpoint,
        command=" ".join(cmd),
        notes=notes,
    )
    print("导出已在后台启动，PID=%s" % proc.pid)
    print("状态文件：%s" % status_path)
    print("日志：%s" % run_log)
    if notes:
        print("说明：%s" % "；".join(notes))
    print("不要重复启动，也不要写任何自动重跑循环。抓取完成后检查 status.json。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
