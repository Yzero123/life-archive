#!/usr/bin/env python3
"""把 L1/L2 知识块批量灌进 AstrBot 知识库。

接口来自 AstrBot 源码 astrbot/dashboard/api/knowledge_bases.py：
  POST {base_url}/api/v1/knowledge-bases/{kb_id}/documents/import
      Authorization: Bearer <api_key>          # 需要 kb scope
      {"kb_id": ..., "documents": [{"file_name": ..., "chunks": ["..."]}],
       "batch_size": 32, "tasks_limit": 3, "max_retries": 3}
  GET  {base_url}/api/v1/knowledge-bases/tasks/{task_id}   # 轮询进度

api_key 在 AstrBot WebUI 的「设置 → API 密钥」里创建，勾选 kb 权限。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def api_request(base_url: str, path: str, token: str,
                payload: dict | None = None, method: str = "GET") -> dict:
    url = f"{base_url.rstrip('/')}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def load_manifest(kb_dir: Path) -> dict[str, str]:
    """文件路径 → 说说 ID，供增量去重使用。"""
    manifest_path = kb_dir.parent / "manifest.jsonl" if kb_dir.name in ("L1", "L2") else kb_dir / "manifest.jsonl"
    mapping: dict[str, str] = {}
    if manifest_path.exists():
        for line in manifest_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            mapping[item.get("file", "")] = item.get("id", "")
    return mapping


def main() -> int:
    parser = argparse.ArgumentParser(description="批量上传知识块到 AstrBot 知识库")
    parser.add_argument("directory", type=Path, help="L1/ 或 L2/ 目录")
    parser.add_argument("--kb-id", required=True, help="目标知识库 ID")
    parser.add_argument("--base-url", default="http://localhost:6185", help="AstrBot 地址")
    parser.add_argument("--token", default=None, help="AstrBot API Key（默认读环境变量 ASTRBOT_TOKEN）")
    parser.add_argument("--batch-size", type=int, default=32, help="单批文档数")
    parser.add_argument("--tasks-limit", type=int, default=3, help="并发导入任务数")
    parser.add_argument("--only-new", action="store_true", help="只上传没传过的块")
    parser.add_argument("--state", type=Path, default=None, help="增量状态文件路径")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要上传的内容，不实际调用")
    args = parser.parse_args()

    token = args.token or ""
    if not token and not args.dry_run:
        import os
        token = os.environ.get("ASTRBOT_TOKEN", "")
    if not token and not args.dry_run:
        print("错误：需要 --token 或环境变量 ASTRBOT_TOKEN", file=sys.stderr)
        return 1

    if not args.directory.is_dir():
        print(f"错误：目录不存在 {args.directory}", file=sys.stderr)
        return 1

    files = sorted(args.directory.glob("*.md"))
    if not files:
        print(f"⚠️  {args.directory} 下没有 .md 文件")
        return 0

    state_path = args.state or (args.directory.parent / f".uploaded_{args.directory.name}.json")
    uploaded: set[str] = set()
    if args.only_new and state_path.exists():
        uploaded = set(json.loads(state_path.read_text(encoding="utf-8")))

    manifest = load_manifest(args.directory)
    documents = []
    skipped = 0
    for path in files:
        key = manifest.get(f"{args.directory.name}/{path.name}", path.name)
        if args.only_new and key in uploaded:
            skipped += 1
            continue
        content = path.read_text(encoding="utf-8").strip()
        if not content:
            continue
        documents.append({
            "file_name": path.name,
            "chunks": [content],
            "_key": key,
        })

    print(f"📦 待上传 {len(documents)} 个块（跳过已传 {skipped} 个）→ 知识库 {args.kb_id}")
    if args.dry_run:
        for doc in documents[:3]:
            print(f"  ── {doc['file_name']}")
            print("     " + doc["chunks"][0].replace("\n", "\n     ")[:300])
        return 0

    if not documents:
        print("没有新内容需要上传")
        return 0

    uploaded_keys: set[str] = set(uploaded)
    batch_size = max(1, args.batch_size)
    for start in range(0, len(documents), batch_size):
        batch = documents[start:start + batch_size]
        payload = {
            "kb_id": args.kb_id,
            "documents": [{"file_name": d["file_name"], "chunks": d["chunks"]} for d in batch],
            "batch_size": args.tasks_limit,
            "tasks_limit": args.tasks_limit,
            "max_retries": 3,
        }
        try:
            result = api_request(
                args.base_url,
                f"/api/v1/knowledge-bases/{args.kb_id}/documents/import",
                token, payload, method="POST",
            )
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", "ignore")
            print(f"❌ 上传失败（HTTP {error.code}）：{body}", file=sys.stderr)
            return 1
        except urllib.error.URLError as error:
            print(f"❌ 连不上 AstrBot：{error}", file=sys.stderr)
            return 1

        task_id = result.get("task_id") or result.get("data", {}).get("task_id")
        print(f"  → 批次 {start // batch_size + 1}/{(len(documents) + batch_size - 1) // batch_size}"
              f"  task_id={task_id}")
        if task_id:
            wait_task(args.base_url, task_id, token)
        uploaded_keys.update(d["_key"] for d in batch)

    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(sorted(uploaded_keys), ensure_ascii=False, indent=2),
                          encoding="utf-8")
    print(f"✅ 完成，累计已上传 {len(uploaded_keys)} 个块，状态写入 {state_path}")
    return 0


def wait_task(base_url: str, task_id: str, token: str, timeout: int = 1800) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            result = api_request(
                base_url, f"/api/v1/knowledge-bases/tasks/{task_id}", token)
        except urllib.error.URLError:
            time.sleep(3)
            continue
        data = result.get("data", result)
        status = data.get("status")
        if status in ("completed", "success", "failed", "error"):
            print(f"     任务状态：{status}")
            if status in ("failed", "error"):
                print(f"     ⚠️ {data.get('message', '')}")
            return
        time.sleep(3)
    print("     ⚠️ 任务等待超时")


if __name__ == "__main__":
    raise SystemExit(main())
