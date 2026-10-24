// 输入校验与资源上限
//
// 审查建议里的一条：请求体限制 4 MiB、朋友圈文件嗅探 32 MiB，
// 但「JSON 解析和全库 prompt 仍可能造成内存峰值」——
// 也就是说，一个畸形或超大的输入能造成的代价没有硬上限。
//
// 这里把代价定成硬数字，并且**超出就明说**：
// 要么明确报错，要么明确标注「截掉了哪些」，
// 绝不静默截断后假装成功——那才是最难查的一类 bug。

/** HTTP 请求体上限（4 MiB）。 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** 外部导出文件嗅探上限（32 MiB）。 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** JSON 嵌套深度上限。正常导出文件最深也就十来层。 */
export const MAX_JSON_DEPTH = 64;

/** 单次导入的总记录数上限。 */
export const MAX_RECORDS = 200000;

/** 单条正文最大长度（字符）。 */
export const MAX_CONTENT_CHARS = 20000;

/** 单条记录的评论数上限。 */
export const MAX_COMMENTS = 200;

/** 单条记录的点赞用户数上限。 */
export const MAX_LIKE_USERS = 200;

/** 单条记录的媒体（图片 + 视频）数上限。 */
export const MAX_MEDIA = 50;

/** 送给模型的全库速览字符上限。 */
export const MAX_DIGEST_CHARS = 60000;

/** 画像素材字符上限。 */
export const MAX_PROFILE_CHARS = 80000;

/**
 * 检查 JSON 文本的嵌套深度。
 *
 * Node 的 JSON.parse 没有深度上限，一个几百层嵌套的数组能把解析栈打爆
 * （或者干脆把 CPU 烧掉）。这里在解析**之前**扫一遍字符串，成本 O(n)，
 * 超了直接报错，不进解析器。
 *
 * @returns {string|null} 出错原因；没问题返回 null
 */
export function jsonDepthError(text, max = MAX_JSON_DEPTH) {
  const value = String(text ?? '');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth > max) return `JSON 嵌套超过 ${max} 层`;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    }
  }
  return null;
}

/**
 * 超长文本截断，并**显式标注**原长。
 *
 * 标注是有意的：截断过的内容要让下游知道，
 * 否则模型和人都可能把它当成完整原文。
 */
export function capText(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…（已截断，原文 ${value.length} 字）`;
}

/**
 * 数组上限：只取前 max 个，并如实报告被丢掉多少。
 *
 * @returns {{ items: any[], dropped: number }}
 */
export function capArray(items, max) {
  const list = Array.isArray(items) ? items : [];
  return { items: list.slice(0, max), dropped: Math.max(0, list.length - max) };
}
