// 运行状态与知识库持久化。
// 所有持久数据都放在宿主注入的 context.dataDir 下，进程重启后仍在。

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

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
    this.statePath = join(dataDir, 'state.json');
    this.state = { ...DEFAULT_STATE };
  }

  async init() {
    await mkdir(this.rawDir, { recursive: true });
    await mkdir(this.kbDir, { recursive: true });
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
}
