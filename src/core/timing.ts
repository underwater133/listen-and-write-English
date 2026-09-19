/**
 * 句子时间轴的人工修正层
 *
 * ── 为什么需要 ────────────────────────────────────────────────
 * TED 的 VTT 字幕是"粗对齐"的：cue 边界由人工/自动转写给出，本身就有
 * 几百毫秒级别的误差，且各句误差不一致（有的准、有的偏）。实测同一篇里
 * 偏移从 -200ms 到 +800ms 都有。这不是解析 bug —— parseWebVtt 忠实还原了
 * 字幕本身的时间戳，`startOffsetMs` 也只能整体补偿（裁 intro 那一次），
 * 无法逐句对齐。
 *
 * 因此唯一务实的做法是：**让用户在听的时候逐句微调**。
 *
 * ── 为什么单开一个覆盖层，而不是直接改 material.json ─────────
 *   1. 「复原」必须随时可用 —— 原始时间轴是唯一的复原基准，
 *      一旦被就地改写就再也回不去了。
 *   2. material.json 会被多条路径重写（fetchAudio 末尾的
 *      clampSentencesToAudio、缓存重建…），用户修正混在里面很容易被冲掉。
 *   3. 修正记录天然稀疏（一篇里通常只改几句），单独存很小、也好审计。
 *
 *   materials/<dir>/material.json   ← 原始时间轴（只读语义，永不写入修正）
 *   materials/<dir>/timing.json     ← 用户修正覆盖层（增删改都只动它）
 *
 *   生效值 = material.sentences（原始）
 *          ⊕ timing.json（有则覆盖 startMs/endMs）
 *
 * 「复原本句」= 删掉 timing.json 里那一条；「复原全部」= 删掉整个文件。
 */

import * as fs from 'fs';
import * as path from 'path';
import { Sentence } from './types';

export interface SentenceTiming {
  startMs: number;
  endMs: number;
}

/** 修正映射：key 是句序号（字符串，便于 JSON 序列化），value 是该句的生效时间 */
export type TimingOverrides = Record<string, SentenceTiming>;

const TIMING_FILE = 'timing.json';
const TIMING_VERSION = 1;

export function timingFilePath(dir: string): string {
  return path.join(dir, TIMING_FILE);
}

/** 合法判据：有限数、非负、终点必须晚于起点 */
function isValidTiming(v: unknown): v is SentenceTiming {
  if (!v || typeof v !== 'object') return false;
  const t = v as SentenceTiming;
  return (
    typeof t.startMs === 'number' &&
    typeof t.endMs === 'number' &&
    Number.isFinite(t.startMs) &&
    Number.isFinite(t.endMs) &&
    t.startMs >= 0 &&
    t.endMs > t.startMs
  );
}

/**
 * 读修正记录。
 *
 * ⚠️ 任何异常（文件不存在 / JSON 坏 / 结构不对）一律返回空映射，
 *    **绝不抛错**：修正记录是锦上添花，不能让一篇素材因此打不开。
 *    单条记录不合法时只丢弃那一条，其余照常生效。
 */
export function readTimingOverrides(dir: string): TimingOverrides {
  const p = timingFilePath(dir);
  try {
    if (!fs.existsSync(p)) return {};
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { sentences?: unknown };
    const src =
      raw && typeof raw === 'object' && raw.sentences && typeof raw.sentences === 'object'
        ? (raw.sentences as Record<string, unknown>)
        : {};

    const out: TimingOverrides = {};
    for (const [k, v] of Object.entries(src)) {
      if (!/^\d+$/.test(k)) continue;
      if (!isValidTiming(v)) continue;
      out[k] = { startMs: Math.round(v.startMs), endMs: Math.round(v.endMs) };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 写修正记录。空映射 = 删除文件（「复原全部」应该让素材目录回到干净状态，
 * 而不是留一个 `{"sentences":{}}`）。
 *
 * 写失败会抛出（磁盘满 / 只读 / 目录被删），由调用方决定怎么提示。
 */
export function writeTimingOverrides(dir: string, overrides: TimingOverrides): void {
  const p = timingFilePath(dir);
  if (Object.keys(overrides).length === 0) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* 删不掉也不影响（读的时候是空映射，等同无修正） */
    }
    return;
  }
  fs.writeFileSync(
    p,
    JSON.stringify({ version: TIMING_VERSION, sentences: overrides }, null, 2),
    'utf8'
  );
}

/** 写入/覆盖一句的修正，返回写入后的完整映射 */
export function setTimingOverride(
  dir: string,
  index: number,
  timing: SentenceTiming
): TimingOverrides {
  const ov = readTimingOverrides(dir);
  ov[String(index)] = {
    startMs: Math.round(timing.startMs),
    endMs: Math.round(timing.endMs),
  };
  writeTimingOverrides(dir, ov);
  return ov;
}

/** 复原一句，返回剩余映射 */
export function clearTimingOverride(dir: string, index: number): TimingOverrides {
  const ov = readTimingOverrides(dir);
  delete ov[String(index)];
  writeTimingOverrides(dir, ov);
  return ov;
}

/** 复原全部，返回空映射 */
export function clearAllTimingOverrides(dir: string): TimingOverrides {
  writeTimingOverrides(dir, {});
  return {};
}

/**
 * 把修正应用到句子数组上，返回新数组（不改原数组）。
 *
 * 被修正过的句子会带上 `timingEdited: true`，UI 据此显示 ✎ 标记与「复原」。
 *
 * durationMs 给出时会把修正值钳制到音频范围内：
 *   - 音频比修正值短（换了素材 / 重新转码后时长变了）时，越界的修正没有意义，
 *     钳制后若起点终点贴到一起，则**丢弃该修正、退回原始值** ——
 *     否则会造出一个零长度、永远播不出声的句子，比偏一点更糟。
 */
export function applyTimingOverrides(
  sentences: Sentence[],
  overrides: TimingOverrides,
  durationMs?: number
): Sentence[] {
  if (Object.keys(overrides).length === 0) return sentences;

  const upper =
    typeof durationMs === 'number' && durationMs > 0 ? durationMs - 1 : undefined;

  return sentences.map((s, i) => {
    const ov = overrides[String(i)];
    if (!ov) return s;

    let startMs = ov.startMs;
    let endMs = ov.endMs;
    if (upper !== undefined) {
      startMs = Math.max(0, Math.min(startMs, upper));
      endMs = Math.max(0, Math.min(endMs, upper));
    }
    if (endMs <= startMs) return s;

    return { ...s, startMs, endMs, timingEdited: true };
  });
}
