/**
 * 复习（收藏单词的间隔重复）的调度算法与进度存储。
 *
 * 设计要点：
 * - 只复习 type === 'word' 的收藏（短语/整句不适合卡片式识别练习）。
 * - 主键是【词形小写】，不是收藏 id：收藏条目删掉再收藏同一个词 id 会变，
 *   用 id 绑定会丢掉复习历史；词形才是用户心智里「同一个词」。
 * - 复习记录里【不存】释义/例句 —— 那些每次从收藏实时取，避免两份数据漂移。
 * - 会话态（当前轮、重排次数）只在内存里，不落盘：刷新页面就重新组一场。
 * - 本文件不 import vscode，配置由调用方（panel.ts）读好后传进来 ——
 *   纯函数 + 临时目录即可单测，见 src/test/testReview.ts。
 */

import * as fs from 'fs';
import * as path from 'path';
import { REVIEW_FILE, STATS_DIR } from './userdata';

/** 自评档位 */
export type ReviewGrade = 'know' | 'fuzzy' | 'unknown';

/** 一个词的复习进度 */
export interface ReviewState {
  /** 阶梯档位（索引进 ReviewConfig.ladder） */
  level: number;
  /** 下次复习时间（epoch ms） */
  dueAt: number;
  /** 上次复习时间 */
  lastAt: number;
  /** 首次复习时间 */
  firstAt: number;
  /** 累计复习次数 */
  reviews: number;
  /** 已掌握：退出复习池（收藏列表标 ✓，可手动重新加入） */
  mastered: boolean;
}

export interface ReviewConfig {
  /** 阶梯间隔（毫秒）。长度即 level 上限，固定为 DEFAULT_LADDER_TEXT.length */
  ladder: number[];
  /** 每天最多引入多少个「从未复习过」的新词 */
  newWordsPerDay: number;
  /** 首轮抽取上限 */
  roundSize: number;
  /** 一张卡一场里最多重排（额外露面）几次 */
  maxRequeue: number;
}

export const DAY_MS = 86400000;

/** 阶梯默认值。用易读字符串而非裸毫秒 —— 一串裸数字在设置 UI 里没法看 */
export const DEFAULT_LADDER_TEXT = ['1d', '2d', '4d', '7d', '15d', '30d'];
export const DEFAULT_NEW_WORDS_PER_DAY = 10;
export const DEFAULT_ROUND_SIZE = 20;
export const DEFAULT_MAX_REQUEUE = 2;

const UNIT_MS: Record<string, number> = {
  m: 60000,
  min: 60000,
  h: 3600000,
  hour: 3600000,
  d: DAY_MS,
  day: DAY_MS,
  w: 7 * DAY_MS,
  week: 7 * DAY_MS,
};

/**
 * 解析一个间隔文本（"10m" / "2h" / "1d" / "1w"），失败返回 null。
 * ⚠️ 无后缀的裸数字按【分钟】算 —— 必须与 package.json 的 description 一致。
 */
export function parseDuration(s: unknown): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(String(s ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 'm').toLowerCase();
  const factor = UNIT_MS[unit];
  if (!factor) return null;
  return Math.round(n * factor);
}

/**
 * 把设置里的阶梯字符串数组解析成毫秒数组。
 *
 * ⚠️ 长度【恒等于】DEFAULT_LADDER_TEXT.length：阶梯长度决定 level 上限，
 *    让用户改长度会让已存的 level 越界或失去意义。
 *    超长截断；缺项/解析失败逐项回退到该位置的默认值 —— 绝不整体崩掉。
 */
export function parseLadder(items: unknown): number[] {
  const defaults = DEFAULT_LADDER_TEXT.map((x) => parseDuration(x) as number);
  const arr = Array.isArray(items) ? items : [];
  return defaults.map((def, i) => {
    if (i >= arr.length) return def;
    return parseDuration(arr[i]) ?? def;
  });
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 把 vscode 配置的原始值规整成一份可用的 ReviewConfig */
export function normalizeConfig(o: {
  ladder?: unknown;
  newWordsPerDay?: unknown;
  roundSize?: unknown;
  maxRequeue?: unknown;
}): ReviewConfig {
  return {
    ladder: parseLadder(o?.ladder),
    newWordsPerDay: clampInt(o?.newWordsPerDay, DEFAULT_NEW_WORDS_PER_DAY, 0, 200),
    roundSize: clampInt(o?.roundSize, DEFAULT_ROUND_SIZE, 1, 200),
    maxRequeue: clampInt(o?.maxRequeue, DEFAULT_MAX_REQUEUE, 0, 5),
  };
}

/* ---------------- 复习池 ---------------- */

/**
 * 组池所需的最小字段集（FavoriteEntry 结构上兼容，避免 import 造成耦合）。
 * ⚠️ 结构里没有 favorite 的 id 字段名冲突问题 —— id 就是收藏条目的 id。
 */
export interface ReviewWordSource {
  id: string;
  type: string;
  text: string;
  translation?: string;
  pending?: boolean;
  createdAt: number;
  context?: { sentenceText?: string };
}

export interface ReviewCandidate {
  /** 词形小写 —— 复习进度的主键 */
  key: string;
  /** 收藏条目 id —— 仅用于从收藏取释义/例句/播放例句 */
  favId: string;
  text: string;
  createdAt: number;
}

/** 复习进度主键 */
export function reviewKey(text: string): string {
  return String(text ?? '').trim().toLowerCase();
}

/**
 * 从收藏里挑出可复习的词。
 *
 * 排除规则：
 *   - 非 word（短语/整句不复习）
 *   - 既没有释义、又没有例句 —— 卡片翻面会是空白，体验很差
 *   - 词形重复（收藏层已去重，这里再兜一次，取最先出现的）
 */
export function selectPool(favorites: ReviewWordSource[]): ReviewCandidate[] {
  const out: ReviewCandidate[] = [];
  const seen = new Set<string>();
  for (const f of favorites || []) {
    if (!f || f.type !== 'word') continue;
    const key = reviewKey(f.text);
    if (!key || seen.has(key)) continue;
    const hasTranslation = !f.pending && !!String(f.translation ?? '').trim();
    const hasSentence = !!String(f.context?.sentenceText ?? '').trim();
    if (!hasTranslation && !hasSentence) continue;
    seen.add(key);
    out.push({ key, favId: f.id, text: f.text, createdAt: Number(f.createdAt) || 0 });
  }
  return out;
}

/* ---------------- 组队列 ---------------- */

/** 确定性可注入的洗牌（测试里传固定 rand） */
export function shuffle<T>(arr: T[], rand: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

export interface Round0Result {
  items: ReviewCandidate[];
  /** 本场引入的新词数（调用方据此累加今日额度） */
  newWords: number;
}

/**
 * 组首轮队列。
 *
 * 顺序：先给「新词」留名额（受每日额度限制），再用到期卡补足到 roundSize，
 * 最后把两者【打散】混合 —— 先清债再见新词会让用户每次开头都在还旧账。
 */
export function buildRound0(
  pool: ReviewCandidate[],
  states: Record<string, ReviewState>,
  config: ReviewConfig,
  now: number,
  dailyUsed: number,
  rand: () => number = Math.random
): Round0Result {
  const fresh: ReviewCandidate[] = [];
  const due: ReviewCandidate[] = [];
  for (const c of pool) {
    const st = states[c.key];
    if (!st) {
      fresh.push(c);
      continue;
    }
    if (st.mastered) continue;
    if (Number(st.dueAt) <= now) due.push(c);
  }

  fresh.sort((a, b) => a.createdAt - b.createdAt);
  due.sort((a, b) => Number(states[a.key]?.dueAt ?? 0) - Number(states[b.key]?.dueAt ?? 0));

  const quota = Math.max(0, config.newWordsPerDay - Math.max(0, dailyUsed));
  const newPick = fresh.slice(0, Math.min(quota, config.newWordsPerDay));
  const restSlots = Math.max(0, config.roundSize - newPick.length);
  const duePick = due.slice(0, restSlots);

  return { items: shuffle(newPick.concat(duePick), rand), newWords: newPick.length };
}

/**
 * 「再来 N 张」：从池里取【已排期】但还没到期的词，提前复习。
 *
 * ⚠️ 只挑已有 ReviewState 的词 —— 从没复习过的不算「提前复习」，那属于
 *    「引入新词」，只能由每日额度（newWordsPerDay）放行。
 *    曾经放它们进来过，后果是：连点「再来 5 个」可以无限引入新词，
 *    newWordsPerDay 形同虚设；而且按钮字面意思是"再来几个"，给新词也对不上。
 *
 * 已掌握的、以及本场已出现过的（exclude）都跳过。
 * 排序按 dueAt 升序 —— 优先给"本来还要等最久"的那些。
 */
export function buildExtra(
  pool: ReviewCandidate[],
  states: Record<string, ReviewState>,
  exclude: Set<string>,
  count: number
): ReviewCandidate[] {
  const cand: ReviewCandidate[] = [];
  for (const c of pool) {
    if (exclude.has(c.key)) continue;
    const st = states[c.key];
    if (!st || st.mastered) continue;
    cand.push(c);
  }
  cand.sort((a, b) => Number(states[a.key]?.dueAt ?? 0) - Number(states[b.key]?.dueAt ?? 0));
  return cand.slice(0, Math.max(0, count));
}

/* ---------------- 评分 → 进度 ---------------- */

/**
 * 本次评分后该卡还需要重排几次（requeues = 本场已重排次数）。
 *
 * 规则（与设计清单一致）：
 *   - 认识 → 0
 *   - 模糊 → 只在【首次露面】时给 1 次；重排轮里再评模糊不追加
 *   - 不认识 → maxRequeue - 已重排次数（即每卡每场额外露面封顶 maxRequeue 次）
 */
export function gradeRequeue(grade: ReviewGrade, requeues: number, config: ReviewConfig): number {
  if (grade === 'know') return 0;
  if (grade === 'fuzzy') return requeues === 0 ? 1 : 0;
  return Math.max(0, config.maxRequeue - requeues);
}

/**
 * 把一次评分写进进度。
 *
 * ⚠️ 关键取舍：只有【正面直接答对】才升档。
 *    重排轮或看完答案之后回顾性质的「认识」是当场短时记忆，不该涨 level ——
 *    但仍给他明天再见一次（dueAt = now + 1d），不一棍子打死。
 * ⚠️ requeues > 0 即表示本次是重排轮。
 */
export function schedule(
  prev: ReviewState | undefined,
  grade: ReviewGrade,
  requeues: number,
  config: ReviewConfig,
  now: number
): ReviewState {
  const base: ReviewState = prev
    ? { ...prev }
    : { level: 0, dueAt: now, lastAt: now, firstAt: now, reviews: 0, mastered: false };
  const next: ReviewState = {
    level: Math.max(0, Number(base.level) || 0),
    dueAt: Number(base.dueAt) || now,
    lastAt: now,
    firstAt: Number(base.firstAt) || now,
    reviews: (Number(base.reviews) || 0) + 1,
    mastered: !!base.mastered,
  };
  const lastLevel = config.ladder.length - 1;

  if (grade === 'unknown') {
    /*
     * 归零 + 明天再来。
     *
     * ⚠️ 别把 dueAt 写回 now（曾经就是 now）：那样这个词永远处于「已到期」，
     *    首页的「待复习 N 个」永远归不了零、今日任务永远显示没完成，
     *    用户会以为程序算错了（2026-10-16 实测反馈）。
     *    「当场再练一遍」由会话内的重排轮负责（见 gradeRequeue），跟 dueAt 无关 ——
     *    想今天多练就点「再来 5 个」（buildExtra 会优先挑最接近到期的词）。
     */
    return { ...next, level: 0, dueAt: now + DAY_MS, mastered: false };
  }
  if (grade === 'fuzzy') {
    return { ...next, dueAt: now + DAY_MS, mastered: false };
  }
  if (requeues > 0) {
    return { ...next, dueAt: now + DAY_MS, mastered: false };
  }
  // 用【当前档位】的间隔排期，然后再升档。
  //
  // ⚠️ 别改回 ladder[level + 1]：那样第一档永远是死配置 ——「答对」总会把
  //    档位推到至少 1，ladder[0] 就再也没人读了（2026-10-16 修的正是这个）。
  //    用当前档位排期，阶梯里每一档都真的生效：
  //      答对 #1 → 1d，+1 档；答对 #2 → 2d，+1 档；… 顶档答对 → 已掌握。
  const dv = now + config.ladder[Math.min(lastLevel, next.level)];
  if (next.level >= lastLevel) {
    // 已在顶档又答对 → 判定「已掌握」，退出复习池
    return { ...next, level: lastLevel, dueAt: dv, mastered: true };
  }
  return { ...next, level: next.level + 1, dueAt: dv, mastered: false };
}

/* ---------------- 存储 ---------------- */

interface ReviewFile {
  version: number;
  items: Record<string, ReviewState>;
  /** 今日新词额度（自然日；跨日自动失效） */
  daily: { date: string; newWords: number };
}

/** 自然日 key（本地时区）—— 「每天 10 个新词」按本地 0 点重置 */
export function dateKey(now: number): string {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}

function sanitizeState(raw: any, now: number): ReviewState {
  return {
    level: Math.max(0, Number(raw?.level) || 0),
    dueAt: Number(raw?.dueAt) || 0,
    lastAt: Number(raw?.lastAt) || 0,
    firstAt: Number(raw?.firstAt) || 0,
    reviews: Math.max(0, Number(raw?.reviews) || 0),
    mastered: !!raw?.mastered,
  };
}

/**
 * 复习进度存储：<materialsDir>/stats/review.json
 *
 * 与 FavoriteStore 同一套路：每次变更 load → 改 → save 全量重写
 * （侧边栏与编辑器面板是两个实例共享同一文件）。
 * 文件损坏 → 视为空，绝不抛错（页面脚本抛错会整页按钮失效）。
 */
export class ReviewStore {
  private file: string;

  constructor(userDataRoot: string) {
    this.file = path.join(userDataRoot, STATS_DIR, REVIEW_FILE);
  }

  private load(): ReviewFile {
    const empty: ReviewFile = { version: 1, items: {}, daily: { date: '', newWords: 0 } };
    if (!fs.existsSync(this.file)) return empty;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const items: Record<string, ReviewState> = {};
      const raw = data?.items;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const k of Object.keys(raw)) items[k] = sanitizeState(raw[k], Date.now());
      }
      return {
        version: 1,
        items,
        daily: {
          date: String(data?.daily?.date ?? ''),
          newWords: Math.max(0, Number(data?.daily?.newWords) || 0),
        },
      };
    } catch {
      return empty;
    }
  }

  private save(data: ReviewFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
  }

  /** 全部进度（key = 词形小写） */
  all(): Record<string, ReviewState> {
    return this.load().items;
  }

  get(key: string): ReviewState | undefined {
    return this.load().items[key];
  }

  set(key: string, state: ReviewState): void {
    if (!key) return;
    const data = this.load();
    data.items[key] = state;
    this.save(data);
  }

  /**
   * 「重新加入复习」：已掌握 → 回到 level 0，立刻到期。
   * ⚠️ 保留 reviews 计数（历史不该被抹掉，只是重新排期）。
   */
  restart(key: string, now: number): void {
    const data = this.load();
    const prev = data.items[key];
    if (!prev) return;
    data.items[key] = { ...prev, level: 0, dueAt: now, mastered: false };
    this.save(data);
  }

  /** 今日已引入的新词数（跨日返回 0，不改写文件） */
  dailyUsed(now: number): number {
    const d = this.load().daily;
    return d.date === dateKey(now) ? d.newWords : 0;
  }

  /** 累加今日新词计数（跨日则重置为 n） */
  addDaily(n: number, now: number): void {
    if (!n) return;
    const data = this.load();
    const today = dateKey(now);
    const used = data.daily.date === today ? data.daily.newWords : 0;
    data.daily = { date: today, newWords: used + n };
    this.save(data);
  }
}
