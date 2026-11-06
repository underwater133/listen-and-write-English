/**
 * 离线词典（ECDICT 子集，assets/dict.json.gz）
 *
 * 数据由 scripts/build-dict.mjs 从 ECDICT（MIT）构建：
 *   { v, count, words: { word: [phonetic, translation, frq?] }, lemma: { 变形: 原形 } }
 *   v2 起第三项是可选的词频排名（越小越常用）；老词典只有两项。
 *
 * 加载策略（Q9 决策）：单文件 gzip，首次查询时惰性解压载入内存 Map（约 200-300ms，
 * 仅一次），之后查询零成本。文件缺失/损坏 → 词典不可用，所有查询返回 null，
 * 调用方静默降级走百度 —— **绝不抛错**（页面/宿主不能因为词典挂掉而失败）。
 *
 * 词形还原（Q11 决策）：精确查询 → lemma 反转映射（went→go 等不规则变形）→
 * 规则剥离（s/es/ed/ing 等）兜底，每一步都做大小写不敏感处理。
 */

import * as fs from 'fs';
import * as zlib from 'zlib';

export interface DictEntry {
  phonetic: string;
  translation: string;
  /**
   * 命中变形词时给出词表里的原形（went → go）；精确命中自身词条时为空。
   * 供答案卡悬停释义展示「went → go」用。
   */
  base?: string;
  /**
   * 词频排名（构建期 COCA/BNC，越小越常用）。
   * 0/undefined = 词典里没有这个词的排名，或读的是没有排名的旧版词典。
   */
  frq?: number;
}

/** 词典里的原始条目：[音标, 释义] 或 [音标, 释义, 词频排名] */
type RawEntry = [string, string] | [string, string, number];

/** 侧边栏与编辑器面板是两个实例，词典按路径共享单例（避免双份内存） */
const instances = new Map<string, Dictionary>();

export function getDictionary(file: string): Dictionary {
  let d = instances.get(file);
  if (!d) {
    d = new Dictionary(file);
    instances.set(file, d);
  }
  return d;
}

export class Dictionary {
  private words: Map<string, RawEntry> | null = null;
  private lemma: Map<string, string> | null = null;
  private loading: Promise<void> | null = null;
  /** false = 加载失败过（文件缺失/损坏），不再重试，查询恒返回 null */
  private broken = false;
  /** 词库（学习）用的有序词表缓存，见 wordList() */
  private list: string[] | null = null;

  constructor(private file: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.words || this.broken) return;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          if (!fs.existsSync(this.file)) throw new Error('词典文件不存在');
          const json = JSON.parse(
            zlib.gunzipSync(fs.readFileSync(this.file)).toString('utf8')
          );
          this.words = new Map(Object.entries(json.words ?? {}));
          this.lemma = new Map(Object.entries(json.lemma ?? {}));
        } catch {
          this.broken = true; // 静默降级：查询方拿到 null 后走百度兜底
        }
      })();
    }
    await this.loading;
  }

  /** 预热：只触发加载（首次 gunzip 约 200-300ms），不做查询。失败静默 */
  async warm(): Promise<void> {
    await this.ensureLoaded();
  }

  /**
   * 「词库」用的有序词表（只给词形，释义按需 lookup）。
   *
   * 排序规则：
   *   - 词典带词频（v2 及以后）→ 【只取有排名的词条】，按排名升序
   *   - 旧词典没有排名 → 回退为全部词条的字母序（功能依旧可用，只是失去"高频优先"）
   *
   * ⚠️ 只返回词形而不是完整词条：15 万条 × {音标+释义} 的对象会白占几十 MB，
   *    而刷词一次只看一条，用的时候再查就行。结果缓存一份（列表是只读的）。
   */
  async wordList(): Promise<string[]> {
    await this.ensureLoaded();
    if (!this.words) return [];
    if (this.list) return this.list;
    const all = Array.from(this.words.keys());
    // 「有排名」= 该条目是三项数组且第三项 > 0
    const hasRank = all.some((w) => this.rankOf(w) > 0);
    const kept = hasRank ? all.filter((w) => this.rankOf(w) > 0) : all;
    kept.sort((a, b) => {
      const ra = this.rankOf(a);
      const rb = this.rankOf(b);
      if (ra !== rb) return ra - rb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    this.list = kept;
    return kept;
  }

  /** 词条的词频排名（0 = 无）；变形词不参与，只认词表里的原形 */
  private rankOf(word: string): number {
    const hit = this.words?.get(word);
    const r = Number(hit?.[2]);
    return Number.isFinite(r) && r > 0 ? r : 0;
  }

  /** 词形还原后查询。未命中返回 null（调用方决定是否走百度兜底） */
  async lookup(word: string): Promise<DictEntry | null> {
    await this.ensureLoaded();
    if (!this.words || !this.lemma) return null;

    const w = word.trim();
    if (!w || /\s/.test(w)) return null; // 短语不查词典（调用方也不该传）

    // 1) 精确 / 小写（自己就是词条，没有原形可标注）
    for (const c of [w, w.toLowerCase()]) {
      const hit = this.words.get(c);
      if (hit) return this.mk(hit, w);
    }
    // 2) lemma 反转映射（不规则变形：went→go、humans→human）
    for (const c of [w, w.toLowerCase()]) {
      const base = this.lemma.get(c) ?? this.lemma.get(c.toLowerCase());
      if (base) {
        const hit = this.words.get(base);
        if (hit) return this.mk(hit, w, base);
      }
    }
    // 3) 规则剥离兜底（covers 词典 exchange 没收录的生僻变形）
    for (const c of [w, w.toLowerCase()]) {
      for (const stem of stripSuffixes(c)) {
        const base = this.lemma.get(stem) ?? stem;
        const hit = this.words.get(base);
        if (hit) return this.mk(hit, w, base);
      }
    }
    return null;
  }

  /** query = 用户查的原始词形；base = 实际命中的词条（不同则说明走了词形还原） */
  private mk(hit: RawEntry, query: string, base?: string): DictEntry {
    const entry: DictEntry = { phonetic: hit[0], translation: hit[1] };
    const frq = Number(hit[2]);
    if (Number.isFinite(frq) && frq > 0) entry.frq = frq;
    // 只差大小写的「原形」不值得标箭头（went→go 才有信息量）
    if (base && base.toLowerCase() !== query.toLowerCase()) entry.base = base;
    return entry;
  }
}

/** 简单规则剥离：非穷举，只是 lemma 映射漏网时的兜底 */
function stripSuffixes(w: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (s.length >= 2 && !out.includes(s)) out.push(s);
  };
  if (w.endsWith('ies')) push(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) push(w.slice(0, -2));
  if (w.endsWith('s')) push(w.slice(0, -1));
  if (w.endsWith('ing')) {
    push(w.slice(0, -3));
    const stem = w.slice(0, -3);
    // running → runn → run（去双写辅音）
    if (stem.length >= 4 && stem[stem.length - 1] === stem[stem.length - 2]) {
      push(stem.slice(0, -1));
    }
  }
  if (w.endsWith('ied')) push(w.slice(0, -3) + 'y');
  if (w.endsWith('ed')) {
    push(w.slice(0, -2));
    push(w.slice(0, -1));
    const stem = w.slice(0, -2);
    if (stem.length >= 4 && stem[stem.length - 1] === stem[stem.length - 2]) {
      push(stem.slice(0, -1));
    }
  }
  return out;
}
