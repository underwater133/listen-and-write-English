/**
 * 用户数据（收藏 / 诊断报告错题）的落点与迁移。
 *
 * 为什么不再用 globalStorage：
 *   卸载 VS Code 扩展会连 globalStorage 一起删掉 —— 用户实测「卸载重装后
 *   收藏全没了，素材库还在」（素材因为配置了 materialsDir 落在外部目录而幸免）。
 *   现在用户数据 **跟随 materialsDir** 存到素材根目录：
 *     <materialsDir>/favorites.json
 *     <materialsDir>/stats/mistakes.jsonl
 *     <materialsDir>/stats/review.json
 *   素材位置若是自定义绝对路径，卸载重装 / 换机都不会丢。
 *
 * ⚠️ 代价：素材根目录下因此混进了两个用户数据条目。凡是「清素材 / 遍历素材」
 *    的地方都必须把它们排除：
 *      - 清音频缓存见 extension.ts 的 clearCache（用 isUserDataEntry 跳过）
 *      - 遍历素材见 panel.ts 的 scanCached / tryRestoreLast
 *        （只认含 material.json 的子目录，天然跳过 stats/；favorites.json 是文件）
 */

import * as fs from 'fs';
import * as path from 'path';

/** 收藏文件（与素材同根） */
export const FAVORITES_FILE = 'favorites.json';
/** 错题/诊断数据的子目录（与素材同根） */
export const STATS_DIR = 'stats';
/** 错题记录文件名 */
export const MISTAKES_FILE = 'mistakes.jsonl';
/** 复习进度文件名（同样位于 stats/ 下） */
export const REVIEW_FILE = 'review.json';

/**
 * 素材根下属于「用户数据」的条目名 —— 清缓存时必须保留。
 * ⚠️ stats/ 整目录保留，因此 stats/review.json 天然受保护，不需要单独列。
 */
export function isUserDataEntry(name: string): boolean {
  return name === FAVORITES_FILE || name === STATS_DIR;
}

/** 用户数据相对素材根的路径清单 */
const USER_DATA_RELS = [
  FAVORITES_FILE,
  path.join(STATS_DIR, MISTAKES_FILE),
  path.join(STATS_DIR, REVIEW_FILE),
];

/**
 * 把用户数据（收藏 + 错题）从 fromRoot 搬到 toRoot。
 *
 * 规则与 migrateMaterials 一致：
 *   - 目标已存在则跳过（绝不覆盖 —— 用户数据面前宁可多余不可丢失）
 *   - rename 失败（跨盘 EXDEV）退化为复制 + 删除源
 *   - 幂等：源不存在 / 同根时什么都不做
 */
export function migrateUserData(
  fromRoot: string,
  toRoot: string
): { moved: number; skipped: number } {
  if (!fromRoot || !toRoot) return { moved: 0, skipped: 0 };
  if (path.resolve(fromRoot) === path.resolve(toRoot)) return { moved: 0, skipped: 0 };

  let moved = 0;
  let skipped = 0;
  for (const rel of USER_DATA_RELS) {
    const src = path.join(fromRoot, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(toRoot, rel);
    if (fs.existsSync(dst)) {
      skipped++;
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fs.renameSync(src, dst);
    } catch {
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
    moved++;
  }
  return { moved, skipped };
}
