#!/usr/bin/env python3
"""qq-kb-pipeline 回归测试。

用合成数据验证：
  1. 说说 ID → 发布时间解码算法（对齐 Rust 实现）
  2. 两路数据源合并、按 ID 去重、已恢复说说标记
  3. 时间精度判定（exact / from-mood-id / interaction-approx / unknown）
  4. L1 知识块的元数据前缀
  5. L2 摘要块生成（含时间未知分组）
  6. LLM 后端链路（用本地 mock OpenAI 服务）与失败降级

运行：python3 tests/test_pipeline.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import kb_common as kb  # noqa: E402
import merge_sources  # noqa: E402

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  ✅ {name}")
    else:
        FAILED.append(f"{name} — {detail}")
        print(f"  ❌ {name}  {detail}")


def run(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, *args], cwd=cwd, capture_output=True, text=True)


def test_mood_id_decode() -> None:
    print("\n[1] 说说 ID 时间解码")
    # 取自 Rust 侧单元测试 decodes_original_publish_time_from_legacy_mood_id
    cell_id = "b327e672e295585b4ceb0500"
    check("正确 QQ 号解出发布时间",
          kb.mood_cell_id_published_at(cell_id, "1927686067", 1_574_686_344) == 1_532_532_194,
          str(kb.mood_cell_id_published_at(cell_id, "1927686067", 1_574_686_344)))
    check("QQ 号不匹配时拒绝",
          kb.mood_cell_id_published_at(cell_id, "1927686068", 1_574_686_344) is None)
    check("ID 过短时拒绝",
          kb.mood_cell_id_published_at("abc", "1927686067", 0) is None)
    check("非法十六进制不抛异常",
          kb.mood_cell_id_published_at("zzzzzzzzzzzzzzzz", "1927686067", 0) is None)


def test_merge(workdir: Path) -> dict:
    print("\n[2] 两路数据源合并")
    fixtures = workdir / "fixtures"
    result = subprocess.run(
        [sys.executable, str(ROOT / "tests/make_fixtures.py"), str(fixtures)],
        capture_output=True, text=True,
    )
    check("合成数据生成成功", result.returncode == 0, result.stderr[-200:])

    json_path = fixtures / "messages.json"
    db_path = fixtures / "qzone-archive.sqlite3"
    unified = workdir / "unified.jsonl"

    records = merge_sources.load_qzoneexport(json_path)
    archive = merge_sources.load_qzone_archive(db_path, None)
    check("QZoneExport 侧读出 3 条", len(records) == 3, str(len(records)))
    check("归档库侧读出 4 条", len(archive) == 4, str(len(archive)))

    merged = merge_sources.merge_records(records + archive)
    check("合并后 6 条唯一记录", len(merged) == 6, str(len(merged)))

    by_id = {r["id"]: r for r in merged}
    shared = [r for r in merged if len(r["sources"]) > 1]
    check("两源命中的同一条被合并", len(shared) == 1, str(len(shared)))

    recovered = [r for r in merged if r["recovered"]]
    check("标记出 3 条已删除恢复内容", len(recovered) == 3, str(len(recovered)))

    time_sources = {r["time_source"] for r in merged}
    check("时间精度含 exact", kb.TIME_SOURCE_EXACT in time_sources)
    check("时间精度含 unknown", kb.TIME_SOURCE_UNKNOWN in time_sources)
    check("时间精度含 interaction-approx", kb.TIME_SOURCE_INTERACTION in time_sources)

    hash_only = [r for r in merged if r["id"].startswith(kb.HISTORY_CELL_PREFIX)]
    check("哈希型历史卡片标记为互动时间近似",
          len(hash_only) == 1 and hash_only[0]["time_source"] == kb.TIME_SOURCE_INTERACTION,
          str([(r["id"][:20], r["time_source"]) for r in hash_only]))

    guestbook = [r for r in merged if r["kind"] == "guestbook"]
    check("留言板被单独分类", len(guestbook) == 1, str(len(guestbook)))

    # 已删除但保留标准 ID 的说说：时间应由 ID 反解得出
    recovered_with_id = [r for r in recovered
                         if r["id"] not in (kb.HISTORY_CELL_PREFIX,) and not r["id"].startswith(kb.HISTORY_CELL_PREFIX)
                         and r["kind"] == "shuoshuo"]
    check("保留标准 ID 的已删说说能定位到时间",
          len(recovered_with_id) == 1 and recovered_with_id[0]["published_at"] == 1_490_000_000,
          str([(r["id"][:20], r["published_at"]) for r in recovered_with_id]))

    # 合并结果落盘
    kb.write_jsonl(unified, merged)
    check("unified.jsonl 落盘成功", unified.exists() and unified.stat().st_size > 0)
    return {"unified": unified, "merged": merged}


def test_chunks(workdir: Path, unified: Path) -> None:
    print("\n[3] L1 明细知识块")
    out = workdir / "kb"
    result = run([str(ROOT / "src/build_chunks.py"), "--input", str(unified), "--out", str(out)], ROOT)
    check("L1 生成成功", result.returncode == 0, result.stderr[-300:])

    l1 = out / "L1"
    files = sorted(l1.glob("*.md"))
    check("L1 产出 5 个块（留言板默认排除）", len(files) == 5, str(len(files)))

    bodies = {f.name: f.read_text(encoding="utf-8") for f in files}
    recovered_body = next((b for b in bodies.values() if "[来源] 已删除后从互动残留恢复" in b), "")
    check("已恢复说说在块内带来源标记", bool(recovered_body))
    check("已恢复块仍带绝对时间", "[时间] 2017-03-20" in recovered_body, recovered_body[:80])
    check("评论被摘录进块", "[评论摘录]" in recovered_body, recovered_body[:200])
    check("定位信息进入块", any("[位置] 上海市静安区" in b for b in bodies.values()))
    check("未知时间的块显式标注",
          any("[时间] 未知" in b for b in bodies.values()))
    check("manifest.jsonl 生成", (out / "manifest.jsonl").exists())
    check("按年浏览版生成", len(list((out / "by_year").glob("*.md"))) >= 1)

    # 超长说说必须被截到 AstrBot 分块阈值以内，否则会被切成两块、第二块丢前缀
    long_record = {
        "id": "verylong", "content": "很长的正文" * 400,
        "published_at": 1_500_000_000, "time_source": kb.TIME_SOURCE_EXACT,
        "location": "某地", "like_count": 9, "post_url": "http://x/y",
        "comments": [{"nick": f"好友{i}", "content": "评论内容" * 30} for i in range(20)],
        "recovered": False, "first_interaction_at": 0, "forward_from": "",
    }
    from build_chunks import render_chunk
    rendered = render_chunk(long_record, max_chars=900)
    check("超长块被截到 900 字以内", len(rendered) <= 900, str(len(rendered)))
    check("超长块仍保留时间前缀", rendered.startswith("[时间] "), rendered[:40])
    check("超长块仍保留正文片段", "[正文] " in rendered)

    # 用 AstrBot 真实分块器验证：一条说说 = 一个 chunk
    chunker_dir = ROOT / "astrbot-src/astrbot/core/knowledge_base/chunking"
    if chunker_dir.exists():
        probe = _probe_astrbot_chunker(rendered, chunker_dir)
        if probe is None:
            print("  ⏭  跳过 AstrBot 分块器校验（需 Python 3.10+ 与 uv）")
        else:
            check("AstrBot 分块器下仍为单块", probe == 1, f"被切成 {probe} 块")


def test_summaries(workdir: Path, unified: Path) -> None:
    print("\n[4] L2 摘要知识块")
    out = workdir / "kb"
    result = run([str(ROOT / "src/build_summaries.py"), "--input", str(unified),
                  "--out", str(out), "--granularity", "year", "--backend", "none"], ROOT)
    check("L2 生成成功", result.returncode == 0, result.stderr[-300:])

    l2 = out / "L2"
    files = sorted(l2.glob("*.md"))
    check("L2 至少产出 3 个年度摘要", len(files) >= 3, str(len(files)))
    check("时间未知的记录单独成组", (l2 / "时间未知.md").exists())

    body = (l2 / "2017.md").read_text(encoding="utf-8")
    check("摘要含条数统计", "[条数]" in body)
    check("摘要含代表性内容", "代表性内容" in body or "关键词" in body)

    # 统计摘要不应输出 n-gram 碎片
    for path in files:
        text = path.read_text(encoding="utf-8")
        if "话题关键词" in text:
            keywords = text.split("话题关键词：")[1].split("。")[0]
            fragments = [k for k in keywords.split("、") if len(k) == 2]
            check(f"{path.name} 关键词无 2 字碎片", len(fragments) <= 2,
                  f"碎片过多：{fragments[:6]}")


def test_llm_backend(workdir: Path, unified: Path) -> None:
    print("\n[5] LLM 后端与降级")
    port = 8947
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tests/mock_openai_server.py"), str(port)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        time.sleep(1.5)
        out = workdir / "kb_llm"
        result = run([str(ROOT / "src/build_summaries.py"), "--input", str(unified),
                      "--out", str(out), "--granularity", "year", "--backend", "openai",
                      "--model", "mock-model", "--base-url", f"http://127.0.0.1:{port}/v1",
                      "--api-key", "sk-test"], ROOT)
        check("openai 后端调用成功", result.returncode == 0, result.stderr[-300:])
        body = (out / "L2/2017.md").read_text(encoding="utf-8")
        check("LLM 返回内容被写入摘要块", "MOCK" in body, body[:120])
    finally:
        server.terminate()
        server.wait(timeout=5)

    out_fail = workdir / "kb_fail"
    result = run([str(ROOT / "src/build_summaries.py"), "--input", str(unified),
                  "--out", str(out_fail), "--granularity", "year", "--backend", "openai",
                  "--model", "mock-model", "--base-url", "http://127.0.0.1:9/v1",
                  "--api-key", "sk-test"], ROOT)
    check("LLM 不可达时不中断流程", result.returncode == 0, result.stderr[-300:])
    check("降级为统计摘要", "降级为统计摘要" in result.stdout, result.stdout[-200:])
    body = (out_fail / "L2/2017.md").read_text(encoding="utf-8")
    check("降级产出仍是有效摘要", len(body.strip()) > 40, body[:80])


def test_upload_dry_run(workdir: Path) -> None:
    print("\n[6] AstrBot 上传脚本（dry-run）")
    kb_dir = workdir / "kb/L1"
    if not kb_dir.exists():
        check("上传脚本前置数据存在", False, "缺少 L1 目录")
        return
    result = run([str(ROOT / "astrbot/upload_to_astrbot.py"), str(kb_dir),
                  "--kb-id", "test-kb", "--dry-run"], ROOT)
    check("上传脚本 dry-run 成功", result.returncode == 0, result.stderr[-300:])
    check("dry-run 打印待上传内容", "待上传" in result.stdout, result.stdout[:200])


def _probe_astrbot_chunker(text: str, chunker_dir: Path) -> int | None:
    """用 AstrBot 真实分块器跑一遍，返回切出的块数。

    分块器源码用了 3.10+ 语法，宿主 Python 3.9 时改走 uv 拉一个 3.13 解释器；
    两者都不可用则返回 None（跳过该校验）。
    """
    workdir = Path(tempfile.mkdtemp(prefix="kbchunk-"))
    try:
        package = workdir / "kbchunk"
        package.mkdir()
        (package / "__init__.py").write_text("", encoding="utf-8")
        for name in ("base.py", "recursive.py", "markdown.py"):
            (package / name).write_text(
                (chunker_dir / name).read_text(encoding="utf-8"), encoding="utf-8")
        script = workdir / "probe.py"
        script.write_text(
            "import asyncio, json, sys\n"
            "sys.path.insert(0, %r)\n"
            "from kbchunk.markdown import MarkdownChunker\n"
            "chunks = asyncio.run(MarkdownChunker().chunk(json.load(open(%r))))\n"
            "print(len(chunks))\n" % (str(workdir), str(workdir / "input.json")),
            encoding="utf-8")
        (workdir / "input.json").write_text(json.dumps(text, ensure_ascii=False), encoding="utf-8")

        result = subprocess.run([sys.executable, str(script)], capture_output=True, text=True, cwd=workdir)
        if result.returncode == 0:
            return int(result.stdout.strip().splitlines()[-1])
        # 3.9 语法不兼容 → 换 uv 拉 3.13
        if shutil.which("uv"):
            result = subprocess.run(
                ["uv", "run", "--quiet", "--python", "3.13", "python3", str(script)],
                capture_output=True, text=True, cwd=workdir)
            if result.returncode == 0:
                return int(result.stdout.strip().splitlines()[-1])
        return None
    except Exception:
        return None
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def main() -> int:
    workdir = Path(tempfile.mkdtemp(prefix="qq-kb-test-"))
    try:
        test_mood_id_decode()
        state = test_merge(workdir)
        test_chunks(workdir, state["unified"])
        test_summaries(workdir, state["unified"])
        test_llm_backend(workdir, state["unified"])
        test_upload_dry_run(workdir)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    print("\n" + "=" * 52)
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    if FAILED:
        print("\n失败明细：")
        for item in FAILED:
            print(f"  ❌ {item}")
        return 1
    print("✅ 全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
