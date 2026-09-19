/**
 * 听写校验器 —— 产品灵魂
 *
 * 把用户听写结果与标准答案做词级 diff，产出「诊断」而非「对错」。
 *
 * 设计要点：
 * 1. 归一化：处理 smart quote、大小写、标点 —— 但不放过连读/弱读导致的错词
 * 2. 模糊匹配：gonna ↔ going to、wanna ↔ want to 等口语缩略，避免误判
 * 3. 错误归因：把每个错误分类为「漏听 / 错听 / 拼写 / 虚词」，这才能诊断耳朵
 * 4. 输出可累积：每次校验结果落盘，形成长期热力统计
 */

export type DiffOp = 'equal' | 'missing' | 'extra' | 'replace';

export type ErrorKind =
  | 'missing-function-word' // 漏听虚词（of / to / and / the）—— 最典型的弱读盲区
  | 'missing-content-word'  // 漏听实词
  | 'misheard'              // 听成了别的词（连读/近音混淆）
  | 'spelling'              // 听对了但拼错
  | 'extra';                // 多写了词

export interface DiffToken {
  op: DiffOp;
  /** 用户写的（extra/replace 时有值） */
  actual?: string;
  /** 标准答案的（missing/replace 时有值） */
  expected?: string;
  /** 错误归因（op !== 'equal' 时有值） */
  kind?: ErrorKind;
  /** 在标准答案中的词序（用于定位） */
  expectedIndex?: number;
}

export interface SentenceResult {
  sentenceIndex: number;
  /** 用户原始输入 */
  raw: string;
  /** 是否完全正确 */
  correct: boolean;
  /** 逐词 diff */
  tokens: DiffToken[];
  /** 正确词数 */
  correctCount: number;
  /** 总词数（标准答案） */
  totalCount: number;
  /** 准确率 0-1 */
  accuracy: number;
}

/* ------------------------------------------------------------------ */
/* 归一化                                                              */
/* ------------------------------------------------------------------ */

/** 高频虚词 —— 漏听它们说明弱读训练不足，与词汇量无关 */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with',
  'and', 'or', 'but', 'so', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'am', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can',
  'could', 'should', 'may', 'might', 'must', 'that', 'this', 'these', 'those',
  'it', 'its', 'he', 'she', 'they', 'we', 'you', 'i', 'his', 'her', 'their',
  'our', 'your', 'my', 'me', 'him', 'them', 'us', 'from', 'into', 'than',
]);

/**
 * 口语缩略/弱读展开表
 * 目的：用户听到 "gonna" 写成 "going to" 不应判错（反之亦然）
 */
const CONTRACTIONS: Record<string, string> = {
  "gonna": "going to",
  "wanna": "want to",
  "gotta": "got to",
  "kinda": "kind of",
  "sorta": "sort of",
  "dunno": "do not know",
  "lemme": "let me",
  "gimme": "give me",
  "cuz": "because",
  "cos": "because",
  "em": "them",
  "ya": "you",
  "yeah": "yes",
  "ok": "okay",
  "cannot": "can not",
  "dont": "do not",
  "cant": "can not",
  "wont": "will not",
  "isnt": "is not",
  "arent": "are not",
  "wasnt": "was not",
  "werent": "were not",
  "didnt": "did not",
  "doesnt": "does not",
  "havent": "have not",
  "hasnt": "has not",
  "hadnt": "had not",
  "wouldnt": "would not",
  "couldnt": "could not",
  "shouldnt": "should not",
  "thats": "that is",
  "its": "it is",
  "im": "i am",
  "ive": "i have",
  "ill": "i will",
  "id": "i would",
  "youre": "you are",
  "youve": "you have",
  "youll": "you will",
  "hes": "he is",
  "shes": "she is",
  "theyre": "they are",
  "weve": "we have",
  "were": "we are",
  "lets": "let us",
};

/** 统一引号/破折号，去掉除撇号与连字符外的标点 */
function normalizeText(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'") // smart single quotes
    .replace(/[\u201C\u201D\u2033]/g, '"')       // smart double quotes
    .replace(/[\u2010-\u2015\u2212]/g, '-')      // 各种 dash
    .replace(/\u2026/g, '...')                   // ellipsis
    .toLowerCase();
}

/** 分词：保留词内撇号与连字符（don't / well-known） */
export function tokenize(s: string): string[] {
  return normalizeText(s)
    .replace(/[^a-z0-9'\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** 展开缩略词，用于 token 级比较（一个缩略可能展开成多个词） */
function expandToken(tok: string): string[] {
  const mapped = CONTRACTIONS[tok];
  if (mapped) return mapped.split(' ');
  return [tok];
}

/** 预展开一个 token 序列 */
function expandAll(tokens: string[]): { flat: string[]; origin: number[] } {
  const flat: string[] = [];
  const origin: number[] = [];
  tokens.forEach((t, i) => {
    for (const e of expandToken(t)) {
      flat.push(e);
      origin.push(i);
    }
  });
  return { flat, origin };
}

/* ------------------------------------------------------------------ */
/* 编辑距离（词级）—— LCS 动态规划 + 回溯                                */
/* ------------------------------------------------------------------ */

interface EditOp {
  type: 'eq' | 'del' | 'ins' | 'sub';
  a?: string;
  b?: string;
  ai?: number;
}

/**
 * 词级 diff，返回编辑操作序列
 *
 * 实现说明：用 LCS 动态规划而非 Myers。
 * 理由：句子长度最多几十词，O(n·m) 开销可忽略；而 Myers 的回溯
 * 在需要区分「替换」时容易出错（实测初版实现会把整句误判为
 * 大量插入+删除，而不是精准定位到个别词）。
 * LCS 回溯逻辑直观、易于验证正确性。
 *
 * 回溯顺序（从右往左）：
 *   - a[i-1] === b[j-1]  → 相等，双方后退
 *   - dp[i-1][j] >= dp[i][j-1] → a 中该词被删除（漏听）
 *   - 否则 → b 中该词是插入（多写）
 * 相邻的 del + ins 会被后处理合并为 sub（替换），以便归因为"错听"。
 */
function diffWords(a: string[], b: string[]): EditOp[] {
  const n = a.length;
  const m = b.length;

  // dp[i][j] = a 前 i 个 与 b 前 j 个 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯收集操作（从后往前，最后 reverse）
  const ops: EditOp[] = [];
  let i = n;
  let j = m;

  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ type: 'eq', a: a[i - 1], b: b[j - 1], ai: i - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: 'del', a: a[i - 1], ai: i - 1 });
      i--;
    } else {
      ops.push({ type: 'ins', b: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ type: 'del', a: a[i - 1], ai: i - 1 });
    i--;
  }
  while (j > 0) {
    ops.push({ type: 'ins', b: b[j - 1] });
    j--;
  }

  ops.reverse();
  return mergeDelInsToSub(ops);
}

/**
 * 把相邻的「删除 + 插入」合并为「替换」
 *
 * 例：a=[nuclear], b=[deterents]
 *     LCS 回溯会给出 del(nuclear) + ins(deterents)
 *     语义上这是"把 nuclear 听成了 deterents"，应归因为 replace 才能判错听/拼写
 *
 * ⚠️ 关键：del 与 ins 的先后顺序取决于回溯走法，两种都要处理。
 *    实测 `deterrents`→`deterents` 会出现 ins 在前的形式，
 *    若只处理 del→ins 顺序，末尾的替换会被误判为"多写+漏听"。
 *
 * 只在 1:1 相邻时合并，避免把整段错位误判为一个替换。
 */
function mergeDelInsToSub(ops: EditOp[]): EditOp[] {
  const out: EditOp[] = [];
  let k = 0;

  while (k < ops.length) {
    if (ops[k].type === 'eq') {
      out.push(ops[k]);
      k++;
      continue;
    }

    // 收集连续的 del / ins，并记录顺序
    const dels: EditOp[] = [];
    const inss: EditOp[] = [];
    while (
      k < ops.length &&
      (ops[k].type === 'del' || ops[k].type === 'ins')
    ) {
      if (ops[k].type === 'del') dels.push(ops[k]);
      else inss.push(ops[k]);
      k++;
    }

    // 1:1 对应 → 合并为替换（与顺序无关）
    if (dels.length === 1 && inss.length === 1) {
      out.push({
        type: 'sub',
        a: dels[0].a,
        b: inss[0].b,
        ai: dels[0].ai,
      });
      continue;
    }

    // 否则按原样输出（保持 del 在前，符合"漏听"直觉）
    out.push(...dels, ...inss);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 错误归因                                                            */
/* ------------------------------------------------------------------ */

/** 判断两个词是否只是拼写差异（听对了但拼错） */
function isLikelySpelling(actual: string, expected: string): boolean {
  if (actual === expected) return false;
  const a = actual.replace(/['\-]/g, '');
  const e = expected.replace(/['\-]/g, '');
  if (a === e) return true;
  if (Math.abs(a.length - e.length) > 3) return false;

  // 简单编辑距离 <= 1 视为拼写错误
  const dist = levenshteinSmall(a, e, 2);
  return dist <= 1;
}

/** 有上限的编辑距离，超出 cap 提前返回 */
function levenshteinSmall(a: string, b: string, cap: number): number {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > cap) return cap + 1;

  let prev = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[m];
}

/** 判断是否为"近音混淆"（连读/弱读导致的错听） */
function isLikelyMisheard(actual: string, expected: string): boolean {
  if (actual === expected) return false;
  if (isLikelySpelling(actual, expected)) return false;

  const a = actual.replace(/[^a-z]/g, '');
  const e = expected.replace(/[^a-z]/g, '');
  if (!a || !e) return false;

  // 首字母相同、长度接近 → 更可能是听错而非听清后拼错
  if (a[0] === e[0] && Math.abs(a.length - e.length) <= 2) return true;

  // 有共同前后缀
  const commonPrefix = [...a].findIndex((c, i) => c !== e[i]);
  if (commonPrefix >= 2) return true;

  return false;
}

/**
 * 校验一句听写结果
 *
 * @param expected 标准答案（英文原句）
 * @param actual   用户听写
 */
export function checkSentence(
  sentenceIndex: number,
  expected: string,
  actual: string
): SentenceResult {
  const expTokens = tokenize(expected);
  const actTokens = tokenize(actual);

  // 展开缩略词后比较，避免 gonna/going to 误判
  const expExp = expandAll(expTokens);
  const actExp = expandAll(actTokens);

  const ops = diffWords(expExp.flat, actExp.flat);

  const tokens: DiffToken[] = [];
  let correctCount = 0;

  for (const op of ops) {
    switch (op.type) {
      case 'eq':
        tokens.push({ op: 'equal', expected: op.a, actual: op.b, expectedIndex: op.ai });
        correctCount++;
        break;

      case 'del': {
        // 标准答案有、用户没写 → 漏听
        const w = op.a!;
        const kind: ErrorKind = FUNCTION_WORDS.has(w)
          ? 'missing-function-word'
          : 'missing-content-word';
        tokens.push({ op: 'missing', expected: w, kind, expectedIndex: op.ai });
        break;
      }

      case 'sub': {
        // 写了别的词 → 错听 or 拼写
        const a = op.b!;
        const e = op.a!;
        let kind: ErrorKind;
        if (isLikelySpelling(a, e)) kind = 'spelling';
        else if (isLikelyMisheard(a, e)) kind = 'misheard';
        else kind = 'misheard';
        tokens.push({
          op: 'replace',
          actual: a,
          expected: e,
          kind,
          expectedIndex: op.ai,
        });
        break;
      }

      case 'ins':
        // 用户多写了词
        tokens.push({ op: 'extra', actual: op.b, kind: 'extra' });
        break;
    }
  }

  // 合并相邻的 equal（缩略展开会产生碎词），让展示更自然
  const merged = mergeAdjacentEquals(tokens);

  const totalCount = expTokens.length;
  const accuracy = totalCount === 0 ? 1 : Math.min(1, correctCount / expExp.flat.length);

  return {
    sentenceIndex,
    raw: actual,
    correct: merged.every((t) => t.op === 'equal'),
    tokens: merged,
    correctCount,
    totalCount,
    accuracy,
  };
}

/** 把连续的 equal 合并成一个 token，展示时更连贯 */
function mergeAdjacentEquals(tokens: DiffToken[]): DiffToken[] {
  const out: DiffToken[] = [];
  for (const t of tokens) {
    const last = out[out.length - 1];
    if (t.op === 'equal' && last && last.op === 'equal') {
      last.expected = `${last.expected} ${t.expected}`;
      last.actual = `${last.actual} ${t.actual}`;
      last.expectedIndex = last.expectedIndex;
      continue;
    }
    out.push({ ...t });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 长期诊断统计                                                        */
/* ------------------------------------------------------------------ */

export interface MistakeRecord {
  timestamp: number;
  materialId: string;
  sentenceIndex: number;
  kind: ErrorKind;
  expected: string;
  actual?: string;
}

export interface DiagnosisReport {
  totalAttempts: number;
  totalSentences: number;
  averageAccuracy: number;
  /** 按错误类型统计 */
  byKind: Record<ErrorKind, number>;
  /** 最常听错的词 TOP N */
  topMissedWords: Array<{ word: string; count: number; kind: ErrorKind }>;
  /** 弱读盲区（漏听的虚词） */
  functionWordBlindSpots: Array<{ word: string; count: number }>;
}

/**
 * 从历史错误记录生成诊断报告
 *
 * 这是产品区别于普通听写工具的核心 —— 它告诉你「耳朵的盲区在哪」。
 */
export function buildReport(records: MistakeRecord[]): DiagnosisReport {
  const byKind: Record<ErrorKind, number> = {
    'missing-function-word': 0,
    'missing-content-word': 0,
    'misheard': 0,
    'spelling': 0,
    'extra': 0,
  };

  const wordCount = new Map<string, { count: number; kind: ErrorKind }>();
  const fnCount = new Map<string, number>();
  const sentenceSet = new Set<string>();
  const attemptSet = new Set<string>();

  for (const r of records) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

    const word = r.expected;
    const prev = wordCount.get(word);
    wordCount.set(word, { count: (prev?.count ?? 0) + 1, kind: r.kind });

    if (r.kind === 'missing-function-word') {
      fnCount.set(word, (fnCount.get(word) ?? 0) + 1);
    }

    sentenceSet.add(`${r.materialId}:${r.sentenceIndex}`);
    attemptSet.add(`${r.materialId}:${r.sentenceIndex}:${r.timestamp}`);
  }

  const topMissedWords = [...wordCount.entries()]
    .map(([word, v]) => ({ word, count: v.count, kind: v.kind }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const functionWordBlindSpots = [...fnCount.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  const totalErrors = records.length;
  const totalSentences = sentenceSet.size;
  const averageAccuracy =
    totalSentences === 0 ? 1 : Math.max(0, 1 - totalErrors / Math.max(1, totalSentences * 8));

  return {
    totalAttempts: attemptSet.size,
    totalSentences,
    averageAccuracy,
    byKind,
    topMissedWords,
    functionWordBlindSpots,
  };
}
