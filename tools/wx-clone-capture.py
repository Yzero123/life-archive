#!/usr/bin/env python3
"""微信数据库密钥捕获驱动（一次性副本 + LLDB 路线）。

背景
----
WeChatDataAnalysis 的「原地重签」路线（``/api/macos-key-capture/prepare``）在本机
macOS 上物理不可行：

* 工具会把 ``/Applications/WeChat.app`` 临时 ad-hoc 重签并**保留腾讯原始权限**
  （``--preserve-metadata=entitlements``）；
* 但 ad-hoc 签名 + ``com.apple.security.app-sandbox`` 等受限权限会被系统 AMFI
  判定为 "The file is adhoc signed but contains restricted entitlements"，
  进程直接被 SIGTRAP 杀掉，``open -n`` 报 "Launch failed"。

工具本身其实自带一条可用的路线：``macos_clone_capture``——用 APFS 写时复制克隆出
一份 **免权限的一次性微信副本** 和一份 **真实容器快照**，在副本上抓密钥，
**完全不修改官方安装**。该路线只暴露在 Python 内部，API 走不到，
所以本脚本直接调用工具自身的模块来驱动它。

用法
----
    python3 tools/wx-clone-capture.py status      # 只看环境与状态
    python3 tools/wx-clone-capture.py prepare     # 克隆副本 + 启动一次性微信
    python3 tools/wx-clone-capture.py preflight   # 预检断点（需先 prepare）
    python3 tools/wx-clone-capture.py capture     # 抓密钥（需先 preflight）
    python3 tools/wx-clone-capture.py cleanup     # 清理副本与快照

脚本不硬编码任何账号、wxid 或路径，全部运行时从系统里推导。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

APP_PATH = "/Applications/WeChatDataAnalysis.app"
BACKEND = APP_PATH + "/Contents/Resources/backend/wechat-backend"
EXTRACT_ROOT = Path.home() / "Library/Caches/WeChatDataAnalysis/wcda-py-src"
DEBUG_ROOT = Path.home() / "Library/Caches/WeChatDataAnalysis/wechat-debug"
CONTAINER_RELATIVE = Path("Library/Containers/com.tencent.xinWeChat")
DEBUG_COPY_NAME = "WeChat Debug - WCDA.app"

GET_TASK_ALLOW_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.get-task-allow</key>
  <true/>
</dict>
</plist>
"""


# --------------------------------------------------------------------------- #
# 工具源码（PyInstaller 归档）提取
# --------------------------------------------------------------------------- #
def ensure_extracted() -> Path:
    """把 PyInstaller 归档解出来，并补齐被归档的本地扩展。"""
    pyz = EXTRACT_ROOT / "wechat-backend_extracted" / "PYZ.pyz_extracted"
    if pyz.is_dir() and (pyz / "wechat_decrypt_tool" / "macos_clone_capture.pyc").is_file():
        return pyz
    if not BACKEND.is_file():
        raise SystemExit(f"找不到工具后端: {BACKEND}")
    EXTRACT_ROOT.mkdir(parents=True, exist_ok=True)
    print(f"[extract] 解包 {BACKEND} -> {EXTRACT_ROOT}")
    for interpreter in (sys.executable, "/usr/bin/python3"):
        completed = subprocess.run(
            [interpreter, "-m", "pyinstxtractor_ng", BACKEND],
            check=False,
            capture_output=True,
            text=True,
            cwd=str(EXTRACT_ROOT),
        )
        if completed.returncode == 0:
            break
    else:
        raise SystemExit("解包失败：需要 pyinstxtractor_ng（pip install --user pyinstxtractor-ng）")
    extracted = EXTRACT_ROOT / "wechat-backend_extracted"
    if not extracted.is_dir():
        # pyinstxtractor_ng 会在当前工作目录旁生成目录，搬进缓存目录。
        for candidate in Path.cwd().parent.glob("wechat-backend_extracted"):
            shutil.move(str(candidate), str(extracted))
            break
    if not extracted.is_dir():
        raise SystemExit("解包失败：未找到 wechat-backend_extracted")
    pyz = extracted / "PYZ.pyz_extracted"
    # 归档里只有 .pyc，本地扩展（cryptography/_rust、_cffi_backend）要补回来。
    for name in ("cryptography", "_cffi_backend"):
        source = extracted / name
        target = pyz / name
        if not source.exists():
            continue
        if source.is_dir():
            for path in source.rglob("*"):
                if path.is_file() and path.suffix in {".so", ".dylib"}:
                    destination = pyz / path.relative_to(extracted)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if not destination.exists():
                        shutil.copy2(path, destination)
                        print(f"[extract] 补齐 {path.relative_to(extracted)}")
        else:
            for path in source.glob(f"{name}*.so"):
                destination = pyz / path.name
                if not destination.exists():
                    shutil.copy2(path, destination)
                    print(f"[extract] 补齐 {path.name}")
    return pyz


def load_tool_modules():
    pyz = ensure_extracted()
    sys.path.insert(0, str(pyz))
    from wechat_decrypt_tool import macos_clone_capture as clone  # noqa: E402
    from wechat_decrypt_tool import macos_db_key_capture as dbkey  # noqa: E402

    return clone, dbkey


# --------------------------------------------------------------------------- #
# 打补丁：让一次性副本路线适配本机
# --------------------------------------------------------------------------- #
def patch_tool(clone, dbkey) -> None:
    """两处本机适配：

    1. ``_materialize_private_xwechat_files`` 默认只认 ``app_data/xwechat_files``
       或 ``xwechat_files.local-backup-*``；本机数据目录是
       ``Documents/xwechat_files``，需要把真实目录当作克隆源。
    2. 免权限副本默认不带 ``get-task-allow``，LLDB 无法附加；
       这里给一次性副本补上该权限（ad-hoc 签名允许）。
    """
    original_materialize = clone._materialize_private_xwechat_files

    def materialize(source_documents: Path, cloned_documents: Path) -> None:
        try:
            original_materialize(source_documents, cloned_documents)
            return
        except Exception:
            fallback = source_documents / "xwechat_files"
            if not fallback.is_dir() or fallback.is_symlink():
                raise
            destination = cloned_documents / "xwechat_files"
            if destination.is_symlink() or destination.is_file():
                destination.unlink()
            elif destination.is_dir():
                shutil.rmtree(destination)
            clone._clone_path_force(fallback, destination)
            print(f"[patch] 改用真实 xwechat_files 作为克隆源: {fallback}")

    clone._materialize_private_xwechat_files = materialize

    # 权限校验：允许 get-task-allow 存在（免权限主体保持不变）。
    clone._has_compatible_debug_entitlements = lambda _app: True

    # 工具默认用「管理员授权」跑 lldb，会弹系统密码框。本机的一次性副本已经带
    # get-task-allow，当前用户就能附加，所以直接以当前用户执行，免掉密码弹窗。
    def run_as_administrator(command: str, *, timeout: float) -> str:
        completed = subprocess.run(
            ["/bin/bash", "-c", command],
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return str(completed.stdout or "")

    clone._run_as_administrator = run_as_administrator
    dbkey._run_as_administrator = run_as_administrator
    for module in list(sys.modules.values()):
        name = getattr(module, "__name__", "")
        if name.startswith("wechat_decrypt_tool") and hasattr(module, "_run_as_administrator"):
            module._run_as_administrator = run_as_administrator

    # 微信容器根目录带 com.apple.macl，clonefile(2) 直接返回 EPERM；
    # 但它的子项都没有 macl，可以逐个写时复制克隆。
    original_clone = clone._clone_path_force

    def clone_path_force(source: Path, destination: Path) -> None:
        try:
            original_clone(source, destination)
            return
        except Exception:
            pass
        if source.is_symlink():
            return
        if source.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
            for child in sorted(source.iterdir()):
                if child.is_symlink():
                    continue
                clone_path_force(child, destination / child.name)
            print(f"[patch] macl 目录改为逐子项克隆: {source}")
            return
        # 受 macl 保护的单个文件：能普通复制就复制，复制不了就跳过。
        try:
            shutil.copy2(source, destination)
        except OSError:
            print(f"[patch] 跳过受保护文件: {source.name}")

    clone._clone_path_force = clone_path_force

    original_ensure = clone._ensure_disposable_debug_copy

    def ensure(wechat_app: Path, debug_root: Path):
        debug_app, created = original_ensure(wechat_app, debug_root)
        entitlements = debug_root / "get-task-allow.plist"
        entitlements.write_text(GET_TASK_ALLOW_PLIST, encoding="utf-8")
        subprocess.run(
            [
                "/usr/bin/codesign",
                "--force",
                "--deep",
                "--sign",
                "-",
                "--entitlements",
                str(entitlements),
                str(debug_app),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=300,
        )
        print(f"[patch] 已给一次性副本补 get-task-allow: {debug_app}")
        return debug_app, created

    clone._ensure_disposable_debug_copy = ensure


# --------------------------------------------------------------------------- #
# 运行时推导
# --------------------------------------------------------------------------- #
def container_dir() -> Path:
    path = Path.home() / CONTAINER_RELATIVE
    if not path.is_dir():
        raise SystemExit(f"找不到微信容器: {path}")
    return path


def probe_db_path() -> Path:
    """真实账号的 sns.db（用作捕获结果的校验探针）。"""
    documents = container_dir() / "Data" / "Documents" / "xwechat_files"
    candidates = sorted(documents.glob("*/db_storage/sns/sns.db"))
    if not candidates:
        raise SystemExit(f"没找到 sns.db: {documents}")
    return candidates[0]


def account_dirs() -> list[Path]:
    documents = container_dir() / "Data" / "Documents" / "xwechat_files"
    return sorted(p for p in documents.iterdir() if p.is_dir() and not p.is_symlink())


# --------------------------------------------------------------------------- #
# 步骤
# --------------------------------------------------------------------------- #
def step_status(clone, dbkey) -> int:
    try:
        state = clone._read_state(DEBUG_ROOT)
    except Exception:
        state = {}
    print(json.dumps({
        "debug_root": str(DEBUG_ROOT),
        "debug_root_exists": DEBUG_ROOT.is_dir(),
        "debug_copy": str(DEBUG_ROOT / DEBUG_COPY_NAME),
        "debug_copy_exists": (DEBUG_ROOT / DEBUG_COPY_NAME).is_dir(),
        "profile_path": state.get("profile_path", ""),
        "debug_pid": state.get("debug_pid", 0),
        "state": state or {},
        "probe_db": str(probe_db_path()),
        "passphrase_cached": (Path.home() / ".wcdb-key-tool" / "wechat-passphrase.json").is_file(),
        "wechat_running": clone._find_wechat_main_pid(Path("/Applications/WeChat.app")) is not None,
    }, ensure_ascii=False, indent=2))
    return 0


def step_prepare(clone, dbkey) -> int:
    result = clone.prepare_clone_capture(
        "/Applications/WeChat.app",
        backup_root=Path.home() / "Library/Application Support/wechat-data-analysis-desktop/output/macos-key-capture-backups",
        debug_root=DEBUG_ROOT,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("\n请在弹出的「WeChat Debug - WCDA」窗口里用真实微信账号扫码登录。")
    return 0


def step_preflight(clone, dbkey) -> int:
    result = clone.preflight_prepared_clone(
        "/Applications/WeChat.app",
        backup_root=Path.home() / "Library/Application Support/wechat-data-analysis-desktop/output/macos-key-capture-backups",
        debug_root=DEBUG_ROOT,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def step_capture(clone, dbkey) -> int:
    result = clone.capture_prepared_clone(
        "/Applications/WeChat.app",
        backup_root=Path.home() / "Library/Application Support/wechat-data-analysis-desktop/output/macos-key-capture-backups",
        probe_db_path=str(probe_db_path()),
        timeout=600,
        debug_root=DEBUG_ROOT,
    )
    payload = dict(result)
    payload.pop("passphrase", None)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def step_cleanup(clone, dbkey) -> int:
    result = clone.cleanup_clone_capture(
        "/Applications/WeChat.app",
        backup_root=Path.home() / "Library/Application Support/wechat-data-analysis-desktop/output/macos-key-capture-backups",
        debug_root=DEBUG_ROOT,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


STEPS = {
    "status": step_status,
    "prepare": step_prepare,
    "preflight": step_preflight,
    "capture": step_capture,
    "cleanup": step_cleanup,
}


def main() -> int:
    parser = argparse.ArgumentParser(description="WeChatDataAnalysis 一次性副本密钥捕获驱动")
    parser.add_argument("step", choices=sorted(STEPS))
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        raise SystemExit("需要 Python 3.11（与工具打包版本一致）")
    clone, dbkey = load_tool_modules()
    patch_tool(clone, dbkey)
    try:
        return STEPS[args.step](clone, dbkey)
    except Exception as error:  # noqa: BLE001
        import traceback
        code = getattr(error, "code", "")
        print(f"[failed] {code or type(error).__name__}: {error}", file=sys.stderr)
        traceback.print_exc()
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
