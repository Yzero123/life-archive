// 运行状态与知识库持久化。
// 所有持久数据都放在宿主注入的 context.dataDir 下，进程重启后仍在。

import { mkdir, readFile, writeFile, readdir, rm, copyFile, stat } from 'node:fs/promises';
import { join, resolve, sep, dirname } from 'node:path';

export const PHASE = {
  IDLE: 'idle',
  EXPORTING: 'exporting',
  BUILDING: 'building',
  READY: 'ready',
  FAILED: 'failed',
};

const DEFAULT_STATE = {
  phase: PHASE.IDLE,
  message: '',
  progress: [],
  ownerUin: '',
  persona: '',
  stats: {
    totalRecords: 0,
    recovered: 0,
    recoveredBodyMissing: 0,
    unknownTime: 0,
    chunkCount: 0,
    summaryCount: 0,
    yearFrom: '',
    yearTo: '',
  },
  // 2.0：微信朋友圈数据源。默认关——1.0 的行为一个字都不能变。
  wx: {
    enabled: false,
    imported: false,
    count: 0,
    owner: '',
    source: '',
    importedAt: 0,
  },
  lastError: '',
  updatedAt: 0,
};

export class Store {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.rawDir = join(dataDir, 'raw');
    this.kbDir = join(dataDir, 'kb');
    // 本地回收站：破坏性操作先搬到这里，而不是直接删。
    this.trashDir = join(dataDir, 'trash');
    this.statePath = join(dataDir, 'state.json');
    this.state = { ...DEFAULT_STATE };
  }

  async init() {
    await mkdir(this.rawDir, { recursive: true });
    await mkdir(this.kbDir, { recursive: true });
    await mkdir(this.trashDir, { recursive: true });
    await this.loadState();
  }

  async loadState() {
    try {
      const raw = await readFile(this.statePath, 'utf8');
      this.state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch {
      this.state = { ...DEFAULT_STATE };
    }
    return this.state;
  }

  async saveState(patch = {}) {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() };
    await writeFile(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    return this.state;
  }

  async appendProgress(step) {
    const progress = [...(this.state.progress ?? []), { ...step, at: Date.now() }].slice(-60);
    return this.saveState({ progress });
  }

  async clearProgress() {
    return this.saveState({ progress: [] });
  }

  // ---- 原始数据 ----

  get messagesPath() {
    return join(this.rawDir, 'qzoneexport_messages.json');
  }

  get archivePath() {
    return join(this.rawDir, 'qzone_archive.json');
  }

  /**
   * 2.0：微信朋友圈原始数据落点。
   *
   * 名字与 1.0 的两个 raw 文件平行，`raw/` 目录本来就是「外部工具的产物」，
   * 外部解密工具把 JSON 放这里，Node 侧只负责读它、解析它。
   */
  get wxSnsPath() {
    return join(this.rawDir, 'wechat_sns.json');
  }

  async removeWxSns() {
    await rm(this.wxSnsPath, { force: true });
  }

  /**
   * 2.0：把朋友圈原始数据搬进回收站。
   *
   * 删原始数据是不可逆的——那份 JSON 是外部解密工具导出的，删了就得重新导。
   * 所以先留一份在本地回收站，用户后悔了能恢复。
   */
  async stashWxSns() {
    return this.stash('wx', ['raw/wechat_sns.json']);
  }

  async writeRaw(name, content) {
    const path = join(this.rawDir, name);
    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
    return path;
  }

  async readRaw(name) {
    try {
      return JSON.parse(await readFile(join(this.rawDir, name), 'utf8'));
    } catch {
      return null;
    }
  }

  async listRaw() {
    try {
      return await readdir(this.rawDir);
    } catch {
      return [];
    }
  }

  // ---- 知识库 ----

  get unifiedPath() {
    return join(this.kbDir, 'unified.jsonl');
  }

  get chunksPath() {
    return join(this.kbDir, 'chunks.jsonl');
  }

  get summariesPath() {
    return join(this.kbDir, 'summaries.jsonl');
  }

  get profilePath() {
    return join(this.kbDir, 'profile.json');
  }

  async writeJsonl(path, rows) {
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  }

  async readJsonl(path) {
    try {
      const raw = await readFile(path, 'utf8');
      return raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  async readJson(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return null;
    }
  }

  async writeJson(path, value) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  async removeProfile() {
    await rm(this.profilePath, { force: true });
  }

  async clearKb() {
    for (const name of ['unified.jsonl', 'chunks.jsonl', 'summaries.jsonl', 'profile.json']) {
      await rm(join(this.kbDir, name), { force: true });
    }
  }

  /**
   * 把知识库文件搬进回收站。
   *
   * 和 stashWxSns 是一对：破坏性操作先 stash、再 clearKb/removeWxSns。
   *
   * state.json 一起搬：清空知识库会顺手把统计清零，
   * 只搬数据文件的话，恢复之后页面还是显示「0 条」。
   */
  async stashKb() {
    return this.stash('kb', [
      'kb/unified.jsonl',
      'kb/chunks.jsonl',
      'kb/summaries.jsonl',
      'kb/profile.json',
      'state.json',
    ]);
  }

  // ---- 本地回收站 ----
  //
  // 审查建议：破坏性操作不能直接永久删除，要先进回收站，用户能恢复。
  // 回收站里只放文件副本 + 一份 meta（时间、动作、文件名、大小）——**不记原文**，
  // 免得「备份」变成第二份没脱敏的数据副本。

  /**
   * 把若干文件（相对 dataDir）复制进回收站，返回这一条回收站记录。
   *
   * @param {string} scope 'kb' | 'wx' | ...
   * @param {string[]} relPaths 相对 dataDir 的路径
   */
  async stash(scope, relPaths) {
    const at = Date.now();
    const stamp = new Date(at).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const id = `${stamp}-${scope}`;
    const dir = join(this.trashDir, id);
    const files = [];

    for (const rel of relPaths) {
      const src = safeJoin(this.dataDir, rel);
      if (!src) continue;
      try {
        const info = await stat(src);
        if (!info.isFile()) continue;
        const dest = join(dir, rel);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(src, dest);
        files.push({ path: rel, bytes: info.size });
      } catch {
        // 文件本来就不存在，跳过——回收站只装真实存在过的东西。
      }
    }

    if (!files.length) return null;
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'meta.json'),
      `${JSON.stringify({ id, scope, at, files }, null, 2)}\n`,
      'utf8',
    );
    return { id, scope, at, files, dir };
  }

  /** 列出回收站条目（新的在前）。 */
  async listTrash() {
    let names = [];
    try {
      names = await readdir(this.trashDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      try {
        const meta = JSON.parse(await readFile(join(this.trashDir, name, 'meta.json'), 'utf8'));
        out.push({
          id: String(meta.id ?? name),
          scope: String(meta.scope ?? ''),
          at: Number(meta.at ?? 0),
          files: Array.isArray(meta.files) ? meta.files : [],
        });
      } catch {
        // 不是回收站条目，忽略。
      }
    }
    out.sort((a, b) => b.at - a.at);
    return out;
  }

  /**
   * 从回收站恢复一个条目。
   *
   * 恢复会覆盖当前同名文件——所以这一步本身也要用户确认（由调用方把关）。
   */
  async restoreTrash(id) {
    const safeId = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!safeId) return { ok: false, message: '回收站条目编号无效' };
    const dir = join(this.trashDir, safeId);

    let meta;
    try {
      meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    } catch {
      return { ok: false, message: '回收站里没有这一条' };
    }

    const restored = [];
    for (const file of meta.files ?? []) {
      const dest = safeJoin(this.dataDir, String(file?.path ?? ''));
      if (!dest) continue;
      try {
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(dir, file.path), dest);
        restored.push(String(file.path));
      } catch {
        // 副本丢了就跳过，别让整条恢复失败。
      }
    }
    if (!restored.length) return { ok: false, message: '这一条没有可恢复的文件' };
    return { ok: true, id: safeId, scope: meta.scope, restored };
  }
}

/**
 * 把相对路径拼到 base 下，并挡住越界的路径。
 *
 * 回收站里的路径会回写磁盘，不能只信 meta.json 里的字符串——
 * 那是本地文件，但仍然要防一手「..」。
 */
function safeJoin(base, rel) {
  if (!rel || typeof rel !== 'string') return null;
  const root = resolve(base);
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}
