#!/usr/bin/env bash
# life-archive-pipeline 一键串联：合并两路数据源 → L1 明细块 → L2 摘要块
#
# 用法：
#   ./run_pipeline.sh \
#     --qzoneexport /path/to/Messages/json/messages.json \
#     --archive-db  /path/to/qzone-archive.sqlite3 \
#     --owner-uin   你的QQ号 \
#     --out out/kb
#
# 可选环境变量（--backend openai 时使用）：
#   KB_LLM_BASE_URL  例：https://api.ppinfra.com/v3/openai
#   KB_LLM_API_KEY   例：pp-xxxx
#   KB_LLM_MODEL     例：baai/bge-m3 用于摘要建议用对话模型，如 MiniMax-M3

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${PYTHON:-python3}"

QZE_JSON=""
ARCHIVE_DB=""
OWNER_UIN=""
OUT_DIR="out/kb"
BACKEND="none"
MODEL=""
GRANULARITY="year"
INCLUDE_GUESTBOOK=""

usage() {
  cat <<'EOF'
用法: run_pipeline.sh [选项]

  --qzoneexport PATH    QZoneExport 的 Messages/json/messages.json
  --archive-db PATH     QQ-Zone-Restore-Archive 的 qzone-archive.sqlite3
  --owner-uin QQ        空间主人 QQ 号（用于从说说 ID 反解发布时间，强烈建议填）
  --out DIR             输出目录（默认 out/kb）
  --backend NAME        none | openai | llm-call（默认 none）
  --model NAME          LLM 模型名（backend != none 时必填）
  --granularity year|month  摘要粒度（默认 year）
  --with-guestbook      把留言板内容也纳入知识块
  -h, --help            显示帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --qzoneexport) QZE_JSON="$2"; shift 2 ;;
    --archive-db)  ARCHIVE_DB="$2"; shift 2 ;;
    --owner-uin)   OWNER_UIN="$2"; shift 2 ;;
    --out)         OUT_DIR="$2"; shift 2 ;;
    --backend)     BACKEND="$2"; shift 2 ;;
    --model)       MODEL="$2"; shift 2 ;;
    --granularity) GRANULARITY="$2"; shift 2 ;;
    --with-guestbook) INCLUDE_GUESTBOOK="--include-guestbook"; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$QZE_JSON" && -z "$ARCHIVE_DB" ]]; then
  echo "错误：至少要提供 --qzoneexport 或 --archive-db 其中之一" >&2
  usage; exit 1
fi

if [[ "$BACKEND" != "none" && -z "$MODEL" ]]; then
  echo "错误：--backend $BACKEND 需要同时提供 --model" >&2
  exit 1
fi

UNIFIED="${OUT_DIR}/unified.jsonl"
mkdir -p "$OUT_DIR"

echo "▶ 1/3 合并数据源"
MERGE_ARGS=(--out "$UNIFIED" --report)
[[ -n "$QZE_JSON"   ]] && MERGE_ARGS+=(--qzoneexport "$QZE_JSON")
[[ -n "$ARCHIVE_DB" ]] && MERGE_ARGS+=(--archive-db "$ARCHIVE_DB")
[[ -n "$OWNER_UIN"  ]] && MERGE_ARGS+=(--owner-uin "$OWNER_UIN")
"$PY" "$HERE/src/merge_sources.py" "${MERGE_ARGS[@]}"

echo
echo "▶ 2/3 生成 L1 明细知识块"
CHUNK_ARGS=(--input "$UNIFIED" --out "$OUT_DIR")
[[ -n "$INCLUDE_GUESTBOOK" ]] && CHUNK_ARGS+=("$INCLUDE_GUESTBOOK")
"$PY" "$HERE/src/build_chunks.py" "${CHUNK_ARGS[@]}"

echo
echo "▶ 3/3 生成 L2 摘要知识块"
SUMMARY_ARGS=(--input "$UNIFIED" --out "$OUT_DIR" --granularity "$GRANULARITY" --backend "$BACKEND")
[[ -n "$MODEL" ]] && SUMMARY_ARGS+=(--model "$MODEL")
"$PY" "$HERE/src/build_summaries.py" "${SUMMARY_ARGS[@]}"

echo
echo "✅ 全部完成"
echo "   L1 明细块：${OUT_DIR}/L1/"
echo "   L2 摘要块：${OUT_DIR}/L2/"
echo "   按年浏览：${OUT_DIR}/by_year/"
echo "   溯源清单：${OUT_DIR}/manifest.jsonl"
echo "   下一步：按 astrbot/setup_knowledge_base.md 把 L1/ 与 L2/ 上传到 AstrBot 知识库"
