/**
 * 素材的学习状态覆盖层（已学完 / 难度）
 *
 * ── 为什么写在素材目录里，而不是集中一个 stats/materials.json ──────
 *   1. 随素材删除自动消失，不会留下指向已删素材的孤儿记录；
 *   2. 切换 materialsDir 时随素材目录整体搬家，不用登记 USER_DATA_RELS；
 *   3. 不写进 material.json —— 那个文件在重新抓元数据时会被整体重写，
 *      用户标记会被一并抹掉。
 *
 *   materials/<dir>/material.json   ← 素材元数据（可能被重写）
 *   materials/<dir>/learn.json      ← 用户标记覆盖层（只由本模块写入）
 *   materials/<dir>/timing.json     ← 时间轴修正覆盖层（同一套思路，见 core/timing.ts）
 */

import * as fs from 'fs';
import * as path from 'path';

export type MaterialDifficulty = 'easy' | 'medium' | 'hard';

export interface MaterialFlags {
  /** 是否已学完（纯手动标记，不做进度推断） */
  learned: boolean;
  /** 难度；null = 未评级 */
  difficulty: MaterialDifficulty | null;
  updatedAt: number;
}

const FLAGS_FILE = 'learn.json';
const FLAGS_VERSION = 1;

/** 难度白名单（数组顺序即界面展示顺序） */
export const DIFFICULTIES: MaterialDifficulty[] = ['easy', 'medium', 'hard'];

/** 取值白名单校验：界面传来的难度一律先过这一关，非法值当未评级 */
export function isMaterialDifficulty(v: unknown): v is MaterialDifficulty {
  return typeof v === 'string' && (DIFFICULTIES as string[]).indexOf(v) >= 0;
}

export function materialFlagsPath(dir: string): string {
  return path.join(dir, FLAGS_FILE);
}

export function defaultMaterialFlags(): MaterialFlags {
  return { learned: false, difficulty: null, updatedAt: 0 };
}

/**
 * 读标记。
 *
 * ⚠️ 任何异常（文件不存在 / JSON 坏 / 字段非法）一律静默回退默认值，
 *    **绝不抛错**：标记是锦上添花，不能让一篇素材因此打不开。
 *    单条字段不合法时只丢弃那一个字段，另一个照常生效。
 */
export function readMaterialFlags(dir: string): MaterialFlags {
  try {
    const p = materialFlagsPath(dir);
    if (!fs.existsSync(p)) return defaultMaterialFlags();
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as any;
    const learned = raw?.learned === true;
    const difficulty = isMaterialDifficulty(raw?.difficulty) ? raw.difficulty : null;
    const updatedAt = Number(raw?.updatedAt);
    return { learned, difficulty, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 };
  } catch {
    return defaultMaterialFlags();
  }
}

/**
 * 写标记。
 *
 * 两个字段都回到默认值时**删掉文件**：「取消已学完 + 清掉难度」不该在素材目录里
 * 留下一个 {"learned":false,"difficulty":null}，让目录保持干净（与 timing.json 一致）。
 *
 * 写失败会抛出（磁盘只读 / 目录被删），由调用方提示用户并回滚界面。
 */
export function writeMaterialFlags(dir: string, flags: MaterialFlags): void {
  const p = materialFlagsPath(dir);
  const learned = flags.learned === true;
  const difficulty = isMaterialDifficulty(flags.difficulty) ? flags.difficulty : null;

  if (!learned && !difficulty) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* 删不掉也无妨：读出来与默认值等价 */
    }
    return;
  }

  fs.writeFileSync(
    p,
    JSON.stringify({ version: FLAGS_VERSION, learned, difficulty, updatedAt: Date.now() }, null, 2),
    'utf8'
  );
}
