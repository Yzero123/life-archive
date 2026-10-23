#!/usr/bin/env python3
"""QQ 空间说说导出运行器（一次扫码版）。

由 Mini App 在开始导出时写入数据目录，再交给 Agent 调用。

它做四件事：

1. 保证导出工具就位（缺就 clone，依赖缺就装）。
2. **起一个常驻浏览器**（系统 Chrome + 调试端口 + 持久化 profile），
   独立进程组运行，**导出和回溯都不关它**。
3. 等用户在这个浏览器里**扫码登录一次**，把登录态就绪的信号写进状态文件。
4. 把抓取脚本挂到独立进程组、用 `--connect-cdp` 复用这个浏览器的登录态。

为什么是「一次扫码」
------------------
QQ 空间的 uin / p_skey 是**会话 cookie**——只活在浏览器进程里，浏览器一关就没了。
原来的流程是「导出工具开一个浏览器 → 抓完关掉 → 回溯探针再开一个浏览器」，
于是每一步都要重新扫码，而且两个工具登录的还不是同一个页面。

现在浏览器由运行器自己起、自己留着，导出和回溯都通过 CDP 挂上去复用同一份登录态。
实测（Playwright 1.64 + Chrome 155）：CDP 连接下调用 browser.close()
**只断开客户端，Chrome 进程和调试端口都还在**，所以导出工具跑完不会把浏览器带走。

用法：
    # 前台：把后台 worker 挂起来就立刻返回
    python3 qq_export_runner.py --status <status.json> --plugin-root <插件目录> [--owner <QQ号>]

    # 后台 worker：跑完整条流水线（由上面那条自动拉起）
    python3 qq_export_runner.py --status <status.json> --plugin-root <插件目录> --worker [...]
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

# 常驻浏览器的 profile 单独放，不跟导出工具自带的 chrome-profile 混用。
# 导出工具的 profile 里有它自己的登录残骸，混在一起会互相干扰。
SESSION_PROFILE_NAME = "chrome-profile-session"

# 等登录的最长时间。扫码 + 手机 QQ 点「确认登录」两件事都要做完。
LOGIN_WAIT_SECONDS = 900

# 阶段 -> 面向用户的一句话。状态文件里 state 与 message 一起给 Agent 看，
# Agent 要把它原样转述给用户，所以写「人话」，不写内部代号。
STATE_MESSAGES = {
    "scheduled": "已排队，马上开始。",
    "preparing": "正在准备导出工具（首次运行需要下载依赖，会慢一点）。",
    "starting_session": "正在启动常驻浏览器…",
    "waiting_login": "浏览器窗口已经打开，请用手机 QQ 扫码登录 QQ 空间，并在手机上点「确认登录」。整个流程只需要扫这一次。",
    "exporting": "登录成功，正在抓取说说（每页间隔约 20 秒，每 10 页休息 3 分钟，请耐心等待）。",
    "done": "抓取完成。浏览器还开着，登录态仍然保留，回溯已删除说说不需要再扫码。",
    "failed": "导出中断了。",
}


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


def set_state(path, state, **fields):
    message = fields.pop("message", None) or STATE_MESSAGES.get(state, state)
    write_status(path, state=state, message=message, **fields)
    print("[%s] %s" % (state, message), flush=True)


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


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def run_node_session(args, plugin_root, state_path, work_dir, tool_dir, action, extra=None):
    """调用包内的 qzone_session.js 管理常驻浏览器。返回解析后的 JSON。"""
    script = os.path.join(plugin_root, "tools", "qzone_session.js")
    profile_dir = os.path.join(work_dir, "resource", "temp", SESSION_PROFILE_NAME)
    session_state = os.path.join(work_dir, "qzone-session.json")
    cmd = [
        "node",
        script,
        action,
        "--profile-dir",
        profile_dir,
        "--state",
        session_state,
        "--tool-dir",
        tool_dir,
    ]
    if extra:
        cmd += extra
    env = dict(os.environ)
    node_modules = os.path.join(tool_dir, "node_modules")
    env["NODE_PATH"] = node_modules + os.pathsep + env.get("NODE_PATH", "")
    try:
        proc = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    text = (proc.stdout or "").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except ValueError:
        # 多行输出时取最后一个 JSON 对象
        for line in reversed(text.splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except ValueError:
                    continue
        return {}


def wait_for_login(args, state_path, work_dir, tool_dir):
    """等用户扫码。返回 (是否就绪, 详情)。"""
    deadline = time.time() + max(10, int(args.login_wait))
    last_hint = 0.0
    while time.time() < deadline:
        info = run_node_session(args, args.plugin_root, state_path, work_dir, tool_dir, "status")
        if info.get("alive") and info.get("loginReady"):
            return True, info
        if info.get("alive") and info.get("login", {}).get("uin") and not info.get("login", {}).get("hasPSkey"):
            # 有 uin 没 p_skey：多半是只扫了码还没在手机上点确认
            if time.time() - last_hint > 30:
                last_hint = time.time()
                set_state(
                    state_path,
                    "waiting_login",
                    message=(
                        "已经识别到你的 QQ 号，但还差最后一步：请在**手机 QQ 上点「确认登录」**。"
                        "只扫码不确认，p_skey 不会下发，接口会一直回「需要登录」。"
                    ),
                )
        if time.time() - last_hint > 30:
            last_hint = time.time()
            print("等待扫码登录…", flush=True)
        time.sleep(3)
    return False, {}


def build_export_cmd(args, tool_dir, cdp_url):
    cmd = [
        "node",
        "get_qzone_history_browser.js",
        "--browser-path",
        browser_path(),
        # 复用常驻浏览器的登录态：不再自己开浏览器，也就不用再扫码。
        "--connect-cdp",
        cdp_url,
        "--start-page",
        str(args.start_page),
        "--end-page",
        str(args.end_page),
        "--page-wait-ms",
        str(args.page_wait_ms),
        "--segment-pages",
        str(args.segment_pages),
        "--segment-pause-ms",
        str(args.segment_pause_ms),
    ]
    if args.owner:
        cmd += ["--target-qq", str(args.owner)]
    return cmd


def run_worker(args):
    """后台 worker：常驻浏览器 → 等登录 → 启动抓取。"""
    work_dir = os.path.abspath(args.work_dir)
    os.makedirs(work_dir, exist_ok=True)
    run_log = os.path.join(work_dir, "export-run.log")
    status_path = os.path.abspath(args.status)
    session_state = os.path.join(work_dir, "qzone-session.json")
    profile_dir = os.path.join(work_dir, "resource", "temp", SESSION_PROFILE_NAME)

    set_state(status_path, "preparing", log=run_log, workDir=work_dir)

    try:
        tool_dir, notes = ensure_tool(work_dir)
    except Exception as exc:  # noqa: BLE001
        set_state(status_path, "failed", error="准备导出工具失败：%s" % exc)
        return 1

    # 1) 常驻浏览器
    set_state(status_path, "starting_session", log=run_log, notes=notes)
    started = run_node_session(args, args.plugin_root, status_path, work_dir, tool_dir, "start")
    cdp_url = started.get("cdpUrl") or ""
    if not cdp_url:
        set_state(
            status_path,
            "failed",
            error="常驻浏览器没起来：%s" % (started.get("error") or "调试端口没就绪"),
            notes=notes,
        )
        return 1

    session_info = {
        "cdpUrl": cdp_url,
        "browserPid": started.get("pid"),
        "profileDir": profile_dir,
        "sessionState": session_state,
    }

    # 2) 等一次扫码
    set_state(status_path, "waiting_login", log=run_log, notes=notes, **session_info)
    ready, login_info = wait_for_login(args, status_path, work_dir, tool_dir)
    if not ready:
        set_state(
            status_path,
            "failed",
            error=(
                "等了 %d 秒还没等到登录态。请确认：① 浏览器窗口里扫码成功；"
                "② **手机 QQ 上点了「确认登录」**。浏览器还开着，可以直接再扫一次，不用重启任何东西。"
                % max(10, int(args.login_wait))
            ),
            log=run_log,
            notes=notes,
            **session_info
        )
        return 1

    uin = login_info.get("login", {}).get("uin", "")
    set_state(
        status_path,
        "exporting",
        log=run_log,
        notes=notes,
        uin=uin,
        loginReady=True,
        **session_info
    )

    # 3) 抓取脚本挂到独立进程组，工具调用结束/超时都不会带走它。
    #    它复用常驻浏览器，所以整条链路只有开头那一次扫码。
    checkpoint = latest_checkpoint(tool_dir)
    state = checkpoint_state(checkpoint)
    cmd = build_export_cmd(args, tool_dir, cdp_url)
    if checkpoint and not state.get("is_final"):
        cmd += ["--resume-checkpoint", checkpoint]
        notes.append("从断点续跑：%s" % os.path.basename(checkpoint))

    with open(run_log, "ab") as log_fh:
        proc = subprocess.Popen(
            cmd,
            cwd=tool_dir,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )

    set_state(
        status_path,
        "exporting",
        log=run_log,
        notes=notes,
        uin=uin,
        loginReady=True,
        exportPid=proc.pid,
        checkpoint=checkpoint,
        command=" ".join(cmd),
        **session_info
    )
    print("抓取已在后台启动，PID=%s" % proc.pid, flush=True)
    print("常驻浏览器 PID=%s，CDP=%s（登录态保留，回溯不用再扫码）" % (session_info["browserPid"], cdp_url), flush=True)
    print("状态文件：%s" % status_path, flush=True)
    print("不要重复启动，也不要写任何自动重跑循环。抓取完成后检查 status.json。", flush=True)
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", required=True, help="status.json 输出路径")
    parser.add_argument("--plugin-root", default="", help="插件根目录（用来找 tools/ 下的脚本）")
    parser.add_argument("--work-dir", default="/tmp/qq-space-export-work")
    parser.add_argument("--owner", default="")
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--end-page", type=int, default=200)
    parser.add_argument("--page-wait-ms", type=int, default=20000)
    parser.add_argument("--segment-pages", type=int, default=10)
    parser.add_argument("--segment-pause-ms", type=int, default=180000)
    parser.add_argument("--login-wait", type=int, default=LOGIN_WAIT_SECONDS, help="等扫码登录的秒数")
    parser.add_argument("--worker", action="store_true", help="内部用：以 worker 身份跑完整流水线")
    args = parser.parse_args()

    work_dir = os.path.abspath(args.work_dir)
    os.makedirs(work_dir, exist_ok=True)
    status_path = os.path.abspath(args.status)
    run_log = os.path.join(work_dir, "export-run.log")

    if args.worker:
        return run_worker(args)

    # 前台：把 worker 挂进独立进程组，自己立刻返回。
    # worker 会活很久（要等扫码），绝不能挂在一次前台工具调用里。
    cmd = [sys.executable, os.path.abspath(__file__), "--status", status_path, "--work-dir", work_dir]
    if args.plugin_root:
        cmd += ["--plugin-root", os.path.abspath(args.plugin_root)]
    if args.owner:
        cmd += ["--owner", str(args.owner)]
    cmd += [
        "--start-page", str(args.start_page),
        "--end-page", str(args.end_page),
        "--page-wait-ms", str(args.page_wait_ms),
        "--segment-pages", str(args.segment_pages),
        "--segment-pause-ms", str(args.segment_pause_ms),
        "--login-wait", str(args.login_wait),
        "--worker",
    ]

    with open(run_log, "ab") as log_fh:
        proc = subprocess.Popen(
            cmd,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )

    set_state(
        status_path,
        "scheduled",
        pid=proc.pid,
        log=run_log,
        workDir=work_dir,
        command=" ".join(cmd),
    )
    print("导出流水线已在后台启动，PID=%s" % proc.pid)
    print("状态文件：%s" % status_path)
    print("日志：%s" % run_log)
    print("浏览器窗口会弹出，请用手机 QQ 扫码并在手机上点「确认登录」。整个流程只需要扫这一次。")
    print("不要重复启动，也不要写任何自动重跑循环。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
