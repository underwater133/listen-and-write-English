/**
 * 离线词典（ECDICT 子集，assets/dict.json.gz）
 *
 * 数据由 scripts/build-dict.mjs 从 ECDICT（MIT）构建：
 *   { v, count, words: { word: [phonetic, translation] }, lemma: { 变形: 原形 } }
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
}

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
  private words: Map<string, [string, string]> | null = null;
  private lemma: Map<string, string> | null = null;
  private loading: Promise<void> | null = null;
  /** false = 加载失败过（文件缺失/损坏），不再重试，查询恒返回 null */
  private broken = false;

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

  /** 词形还原后查询。未命中返回 null（调用方决定是否走百度兜底） */
  async lookup(word: string): Promise<DictEntry | null> {
    await this.ensureLoaded();
    if (!this.words || !this.lemma) return null;

    const w = word.trim();
    if (!w || /\s/.test(w)) return null; // 短语不查词典（调用方也不该传）

    // 1) 精确 / 小写
    for (const c of [w, w.toLowerCase()]) {
      const hit = this.words.get(c);
      if (hit) return this.mk(hit);
    }
    // 2) lemma 反转映射（不规则变形：went→go、humans→human）
    for (const c of [w, w.toLowerCase()]) {
      const base = this.lemma.get(c) ?? this.lemma.get(c.toLowerCase());
      if (base) {
        const hit = this.words.get(base);
        if (hit) return this.mk(hit);
      }
    }
    // 3) 规则剥离兜底（covers 词典 exchange 没收录的生僻变形）
    for (const c of [w, w.toLowerCase()]) {
      for (const stem of stripSuffixes(c)) {
        const base = this.lemma.get(stem) ?? stem;
        const hit = this.words.get(base);
        if (hit) return this.mk(hit);
      }
    }
    return null;
  }

  private mk(hit: [string, string]): DictEntry {
    return { phonetic: hit[0], translation: hit[1] };
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
