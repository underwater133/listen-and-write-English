/**
 * 「词库」新学单词：进度存储 + 有序词表上的游标推进。
 *
 * 与复习（core/review.ts）的区别（设计决策 Q2 = B）：
 *   - 复习只认【收藏】里的单词（收藏才算"进入学习系统"）；
 *   - 词库是【浏览式刷词】：只记"学到哪了"，不参与排期。学过的词要成为
 *     复习对象，仍然得点收藏 —— 两条线只有"收藏"这一个交汇点。
 *
 * 进度锚点是【词形】而不是下标：
 *   - 刷词时会跳过已收藏/已掌握的词，列表长度随收藏增删而变；存下标会漂移。
 *   - 词典重建后（新增词条、词频变化）下标同样会漂移，词形不会。
 *   - 锚词在词典里找不到时（词条被删/换了词典）退回 learn 计数当下标。
 *
 * 本文件不 import vscode：纯函数 + 临时目录即可单测（见 src/test/testLearn.ts）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { STATS_DIR, VOCAB_FILE } from './userdata';

export interface LearnProgress {
  /** 最近学过的那个词（词表里的原形，按词形小写存）；空串 = 还没开始 */
  anchor: string;
  /** 累计学过多少个词（跨词典重建也保留，用于顶部的「已学 N」） */
  learned: number;
  /**
   * 最前沿 = 最后一次被计入「已学」的那张卡（词形小写）。
   * 「已学」只在越过它时 +1：回看后再往回刷/原地重按都不算新学
   * （bug：没有它时，两个词之间来回切计数会一直虚增）。
   * 旧版本数据没有此字段 → 退回旧行为（每次前进 +1），随使用自动收敛。
   */
  frontier?: string;
}

export const EMPTY_PROGRESS: LearnProgress = { anchor: '', learned: 0, frontier: '' };

/**
 * 学习进度存储：<materialsDir>/stats/vocab.json
 *
 * 与 FavoriteStore / ReviewStore 同一套路：每次变更 load → 改 → save 全量重写
 * （侧边栏与编辑器面板是两个实例共享同一文件）。
 * 文件损坏 → 视为未开始，绝不抛错（页面脚本抛错会整页按钮失效）。
 */
export class LearnStore {
  private file: string;

  constructor(userDataRoot: string) {
    this.file = path.join(userDataRoot, STATS_DIR, VOCAB_FILE);
  }

  read(): LearnProgress {
    if (!fs.existsSync(this.file)) return { ...EMPTY_PROGRESS };
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        anchor: typeof data?.anchor === 'string' ? data.anchor.trim().toLowerCase() : '',
        learned: Math.max(0, Number(data?.learned) || 0),
        frontier: typeof data?.frontier === 'string' ? data.frontier.trim().toLowerCase() : '',
      };
    } catch {
      return { ...EMPTY_PROGRESS };
    }
  }

  save(p: LearnProgress): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify(
          {
            version: 1,
            anchor: String(p.anchor ?? '').trim().toLowerCase(),
            learned: Math.max(0, Number(p.learned) || 0),
            frontier: String(p.frontier ?? '').trim().toLowerCase(),
          },
          null,
          2
        ),
        'utf8'
      );
    } catch {
      // 写不进去（目录只读等）只影响"下次从哪继续"，不该打断刷词
    }
  }

  /** 重置：删文件而不是写空对象，避免留下一份"看起来学过 0 个"的壳 */
  reset(): void {
    try {
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    } catch {
      /* 删不掉就下次覆盖 */
    }
  }
}

/**
 * 恢复起点：锚词的【下一个】词。
 *
 * 为什么是"下一个"：锚词是"已经看过的那张卡"，继续学习要从它后面开始，
 * 否则每次打开词库都会重看同一个词。
 * 找不到锚词时退回 learned 计数（词典重建 / 换了词典的兜底）。
 */
export function resumeIndex(words: string[], p: LearnProgress): number {
  if (!words.length) return 0;
  const anchor = String(p?.anchor ?? '').trim().toLowerCase();
  if (anchor) {
    const i = words.indexOf(anchor);
    if (i >= 0) return i + 1;
  }
  const learned = Math.max(0, Math.floor(Number(p?.learned) || 0));
  return Math.min(learned, words.length);
}

/**
 * 从 start 起找第一个「不被跳过」的下标；找不到返回 -1。
 *
 * 跳过的判定由调用方提供（已收藏 / 已掌握 / 词条缺音标缺释义 …），
 * 这样本函数保持纯逻辑、可单测，也不把复习/收藏的细节耦合进来。
 */
export function findNextIndex(
  words: string[],
  start: number,
  skip: (word: string) => boolean
): number {
  for (let i = Math.max(0, start); i < words.length; i++) {
    if (!skip(words[i])) return i;
  }
  return -1;
}
