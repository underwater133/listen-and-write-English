/**
 * 核心数据结构 —— 所有素材源归一化后的统一模型
 *
 * 设计原则：下游（播放、听写校验、诊断报告）只依赖这里的类型，
 * 与具体素材源无关。新增源 = 新增一个 MaterialSourceAdapter 实现。
 */

import * as fs from 'fs';
import * as path from 'path';

/* ------------------------------------------------------------------ */
/* 统一模型                                                            */
/* ------------------------------------------------------------------ */

/** 一句话 = 一个练习单元。以 VTT cue 为单位，不跨 cue 合并。 */
export interface Sentence {
  /** 句序号，从 0 开始 */
  index: number;
  /** 起始时间，毫秒（已按 startOffsetMs 补偿，可直接用于 seek） */
  startMs: number;
  /** 结束时间，毫秒 */
  endMs: number;
  /** 英文原句（cue 内 \n 折行已合并为空格） */
  text: string;
  /** 原始行数，供 UI 决定一行/两行显示 */
  lineCount: number;
  /** 可选译文（按时间区间重叠匹配） */
  translation?: string;
}

export type MaterialSource = 'ted' | 'youtube' | 'podcast' | 'local';
export type MaterialLicense = 'public-domain' | 'cc' | 'personal-use' | 'unknown';

export type MaterialStatus =
  | 'remote'      // 仅元数据，音频未就绪
  | 'downloading' // 分片下载中
  | 'ready'       // 可练习
  | 'failed';

/**
 * 音频信息
 *
 * ⚠️ 关键：不要依赖播放器返回的 duration 做时间轴基准。
 *    ADTS 无时长元数据，浏览器按帧数估算会产生约 0.076s/分片 的误差，
 *    85 个分片累积会漂移数秒。
 *    本字段的 durationMs 一律由 ADTS 帧数自算：frames * 1024 / sampleRate * 1000
 */

/**
 * 音频缓存格式版本号
 *
 * ⚠️ 每次改动解封装 / 封装逻辑都必须 +1。
 *
 * 为什么需要：缓存文件只靠「存在性」判断复用，不做结构校验。
 * 一旦 demux 逻辑修复（例如补上 PES 头剥离），旧缓存里的坏文件
 * 会被继续复用，表现为「代码明明修了但问题依旧」，极难排查。
 *
 * 实测踩坑：demux 修复后，VS Code 扩展宿主仍复用旧缓存，
 * 播放报 MEDIA_ERR_SRC_NOT_SUPPORTED，而单元/冒烟测试全绿。
 *
 * 历史：
 *   1 → 最初的裸 ADTS 提取（未剥 PES 头，帧链错位）
 *   2 → 补上 PES 头剥离 + 帧链自洽校验（仍是裸 ADTS，见下）
 *   3 → 改为 MP4 封装。裸 ADTS 在 VS Code 的 webview 里必然
 *       报 DEMUXER_ERROR_COULD_NOT_OPEN（其内置 ffmpeg 无 ADTS
 *       解复用器），必须换成 MP4 容器。详见 core/mp4.ts。
 *   4 → 修正 mp4a（AudioSampleEntry）固定部分多写 4 字节的问题。
 *       v3 的产物在结构上不合法：esds 被从 +36 挤到 +40，解析器读到
 *       size=0 的假 box，报 DEMUXER_ERROR_NO_SUPPORTED_STREAMS。
 *       ⚠️ 必须 +1，否则磁盘上那些结构不合法的 v3 文件会被继续复用
 *       （当时的缓存校验只查 ftyp/moov/mdat 是否存在，坏文件也通过）。
 *       现在缓存校验统一走 inspectMp4()，它会校验 mp4a/esds 的位置与
 *       尺寸自洽，所以同类结构错误以后不会再被固化在磁盘上。
 *   5 → 改为 **MP3 容器**。这是最后一层根因：VS Code 的裁剪版 ffmpeg
 *       **没有 AAC 解码器**（实测 avcodec_find_decoder(86018) = NULL，
 *       音频解码器只有 pcm 系列、mp3、vorbis、flac 共 12 个），所以 AAC 无论
 *       封成 ADTS 还是 MP4 都播不了 —— 之前的 COULD_NOT_OPEN 与
 *       NO_SUPPORTED_STREAMS 正是这条链上的两层。而 mp3 解码器存在。
 *       做法：AAC 先用 libav(WASM) 解码，再用 lamejs 编成 MP3。
 *       详见 core/transcode.ts。
 */
export const AUDIO_CACHE_VERSION = 5;

export interface AudioInfo {
  /** 本地音频文件绝对路径（v5 起为 .mp3） */
  path: string;
  /**
   * 容器格式。
   *
   * ⚠️ TED 源解出的裸 AAC 一律要封进 MP4 再交给播放器：
   *    VS Code 的 ffmpeg.dll（2.76MB 裁剪版）字符串表里
   *      "mov,mp4,m4a,3gp,3g2,mj2"           ✅
   *      "MPEG-TS (MPEG-2 Transport Stream)" ❌
   *      "adts"                              ❌
   *    裸 ADTS 会得到 FFmpegDemuxer: open context failed。
   *    同一文件在完整 Chrome 里能播 —— 所以这不是文件的问题，
   *    是「谁在解封装」的问题，换容器才是正解。
   */
  format: 'aac' | 'mp3' | 'wav' | 'm4a';
  /** 由 ADTS 帧数自算的真实时长（毫秒），非播放器值 */
  durationMs: number;
  /** 采样率，用于帧数换算 */
  sampleRate: number;
  /** 声道数 */
  channels: number;
  /** ADTS 总帧数 */
  frameCount: number;
  /** 文件字节数 */
  bytes: number;
  /**
   * 句子时间轴的补偿量（毫秒）。
   * 裁掉 intro 时为 -3504；保留 intro 时为 0。
   * sentences[].startMs 已经应用过该补偿。
   */
  startOffsetMs: number;
  /**
   * 写出该缓存时的 AUDIO_CACHE_VERSION。
   * 缺失（undefined）说明是早期产物，一律视为失效需重建。
   */
  cacheVersion?: number;
}

/**
 * 按素材目录重新定位音频文件，返回可用路径；找不到返回 null。
 *
 * ⚠️ audio.json 里的 path 是【写入时的绝对路径】。素材目录一旦整体搬迁
 *    （`listeningTrainer.materialsDir` 变更时扩展会自动搬运），旧路径必然失效：
 *      - panel.openCached 判 existsSync(path) 失败 → 误报「音频缓存已过期」
 *      - panel.tryRestoreLast 的 readFileSync 抛错被 catch → 素材被静默跳过
 *      - 就算判据放行，推给 webview 的 audioUri 也指向不存在的旧位置 → 播放失败
 *    （2026-09-19 实测：配置 materialsDir 后点素材库的卡片必现）
 *
 * 目录名不变，所以「同目录 + 候选文件名」重定位是正确且幂等的。
 * 一律用 path.basename 取名字，杜绝 ".." 之类的越界拼接。
 */
export function relocateAudioPath(dir: string, info: AudioInfo): string | null {
  // 常规情况：路径没变，直接可用
  if (info.path && fs.existsSync(info.path)) return info.path;

  const candidates: string[] = [];
  // 1) 沿用原文件名（迁移只换目录，文件名通常不变）
  if (info.path) candidates.push(path.basename(info.path));
  // 2) 按 format 推断的约定名
  const ext = info.format === 'aac' ? 'aac' : info.format === 'm4a' ? 'm4a' : 'mp3';
  candidates.push(`audio.${ext}`);
  // 3) v5 起的最终产物（旧记录 format 缺失时的兜底）
  candidates.push('audio.mp3');

  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export interface ListeningMaterial {
  /** `${source}:${sourceId}` */
  id: string;
  source: MaterialSource;
  sourceId: string;
  sourceUrl: string;
  title: string;
  presenter?: string;
  description?: string;
  coverUrl?: string;
  language: string;
  /** 可用字幕语言 code 列表 */
  availableLanguages: string[];
  license: MaterialLicense;
  sentences: Sentence[];
  audio?: AudioInfo;
  status: MaterialStatus;
  cacheDir: string;
  fetchedAt: number;
}

/* ------------------------------------------------------------------ */
/* 音频获取进度                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 为什么进度不能只有 (done, total)：
 *
 * 分片下载完之后还有三段**本地计算**：解封装 TS → 封装 MP4 → AAC 解码 → MP3 编码。
 * 实测 8MB / 500s 的 TED 音频，下载完只要几秒，而转码要 20~30s（编码占 22.7s）。
 *
 * 只报分片数的话，UI 会长期停在「下载音频 192/192」——用户看到的是「卡住了」，
 * 实际在转码。（2026-09-19 实际观感反馈）
 */
export type AudioStage =
  /** 并发下载分片 */
  | 'download'
  /** 逐片 MPEG-TS 解封装 */
  | 'demux'
  /** 封装 + AAC 解码 + MP3 编码（耗时主体） */
  | 'transcode';

export interface AudioProgress {
  stage: AudioStage;
  /** 已完成分片数（仅 download 阶段有意义） */
  done: number;
  /** 总分片数 */
  total: number;
  /** 当前阶段内的完成比例 0~1 */
  ratio: number;
  /** 可直接上屏给用户看的一句话 */
  message: string;
}

/** 素材源适配器 —— 新增源只需实现此接口 */
export interface MaterialSourceAdapter {
  readonly source: MaterialSource;
  /** 判断输入能否被本适配器处理 */
  canHandle(input: string): boolean;
  /** 拉元数据 + 字幕（不下载音频） */
  fetchMetadata(input: string, cacheDir: string): Promise<ListeningMaterial>;
  /** 下载音频并解封装/转码，返回补充了 audio 字段的 material */
  fetchAudio(
    material: ListeningMaterial,
    onProgress?: (p: AudioProgress) => void
  ): Promise<ListeningMaterial>;
}

/* ------------------------------------------------------------------ */
/* TED 原始接口结构（仅适配器内部使用）                                 */
/* 依据：ted-probe/TED-API-probe-report.md 实测                          */
/* ------------------------------------------------------------------ */

export interface TedNextData {
  props: {
    pageProps: {
      videoData: {
        id: number;
        title: string;
        slug: string;
        description?: string;
        presenterDisplayName?: string;
        duration: number;
        canonicalUrl: string;
        hlsUrl: string;
        primaryImageSet?: Array<{ url: string; aspectRatioName: string }>;
        videoPlayerData: {
          id: number;
          resources: { hls: { metadata: string; stream: string } };
          languages: Array<{
            languageCode: string;
            languageName: string;
            endonym: string;
            isRtl: boolean;
          }>;
        };
      };
      transcriptData?: {
        translation: {
          language: { internalLanguageCode: string };
          paragraphs: Array<{ cues: Array<{ text: string; time: number }> }>;
        };
      };
    };
  };
}

export interface TedStreamMetadata {
  domains: Array<{ duration: number; primaryDomain: boolean }>;
  subtitles: Array<{ code: string; name: string; webvtt: string }>;
}

/* ------------------------------------------------------------------ */
/* WebVTT 解析                                                          */
/* ------------------------------------------------------------------ */

/**
 * 解析 WebVTT → Sentence[]
 * 实测输入：137 句，与 __NEXT_DATA__ 的 cue 总数一致
 */
export function parseWebVtt(vtt: string): Sentence[] {
  const out: Sentence[] = [];
  const blocks = vtt.replace(/\r\n?/g, '\n').split('\n\n');

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    if (lines[0].startsWith('WEBVTT') || lines[0].startsWith('NOTE')) continue;

    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;

    const m = lines[timeIdx].match(
      /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/
    );
    if (!m) continue;

    const toMs = (h: string, mi: string, s: string, ms: string) =>
      ((+h * 60 + +mi) * 60 + +s) * 1000 + +ms.padEnd(3, '0');

    const textLines = lines.slice(timeIdx + 1);
    if (textLines.length === 0) continue;

    out.push({
      index: out.length,
      startMs: toMs(m[1], m[2], m[3], m[4]),
      endMs: toMs(m[5], m[6], m[7], m[8]),
      text: textLines.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ').trim(),
      lineCount: textLines.length,
    });
  }

  return out;
}

/**
 * 稳健抽取 HTML 中的 __NEXT_DATA__ JSON
 *
 * ⚠️ 不要用正则 `(.*?)</script>` —— 页面内其他 </script> 会干扰导致匹配失败。
 *    实测必须用 indexOf 双定位。
 */
export function extractNextDataJson(html: string): string | null {
  const START_TAG = '<script id="__NEXT_DATA__" type="application/json">';
  const i = html.indexOf(START_TAG);
  if (i === -1) return null;
  const jsonStart = i + START_TAG.length;
  const j = html.indexOf('</script>', jsonStart);
  if (j === -1) return null;
  return html.slice(jsonStart, j);
}

/** 从 hlsUrl 提取 projectMasterId。例：.../project_masters/11314/manifest.m3u8 → "11314" */
export function extractProjectMasterId(hlsUrl: string): string | null {
  const m = hlsUrl.match(/\/project_masters\/(\d+)\//);
  return m ? m[1] : null;
}

/**
 * 从 master m3u8 解析 audio-only 轨道 URI
 *
 * ⚠️ 不要猜 URL（index-a1-v1.m3u8 实测 404），必须读 EXT-X-MEDIA 的 URI 属性。
 * master 实样例：
 *   #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="medium",CHANNELS="2",
 *     URI="index-f8-a1.m3u8?intro_master_id=9294&preview=true"
 */
export function parseAudioRenditionUri(
  masterM3u8: string,
  prefer: 'low' | 'medium' | 'high' = 'medium'
): string | null {
  const audioLines = masterM3u8
    .split('\n')
    .filter((l) => l.startsWith('#EXT-X-MEDIA:TYPE=AUDIO'));

  const order =
    prefer === 'medium' ? ['medium', 'high', 'low']
    : prefer === 'high' ? ['high', 'medium', 'low']
    : ['low', 'medium', 'high'];

  for (const want of order) {
    for (const line of audioLines) {
      const name = line.match(/NAME="([^"]+)"/);
      const uri = line.match(/URI="([^"]+)"/);
      if (name && uri && name[1] === want) return uri[1];
    }
  }
  const any = audioLines.map((l) => l.match(/URI="([^"]+)"/)).find(Boolean);
  return any ? any[1] : null;
}

/** 解析 variant m3u8 的分片列表 */
export interface TsSegment {
  durationSec: number;
  url: string;
  /** 是否为片头（来自 intro master，需裁掉） */
  isIntro: boolean;
}

/**
 * 解析音频 variant m3u8 得到分片列表
 *
 * 实测特征：
 *   - 首片来自 `videos/9294/`（intro，3.527s），带 #EXT-X-DISCONTINUITY
 *   - 正片来自 `videos/11314/`
 */
export function parseVariantSegments(
  variantM3u8: string,
  introMasterId: string | null
): TsSegment[] {
  const out: TsSegment[] = [];
  const lines = variantM3u8.split('\n');
  let pendingDur = 0;

  for (const raw of lines) {
    const line = raw.trim();
    const inf = line.match(/^#EXTINF:([\d.]+)/);
    if (inf) {
      pendingDur = parseFloat(inf[1]);
      continue;
    }
    if (line && !line.startsWith('#')) {
      const isIntro = introMasterId
        ? line.includes(`/videos/${introMasterId}/`)
        : false;
      out.push({ durationSec: pendingDur, url: line, isIntro });
      pendingDur = 0;
    }
  }
  return out;
}

/**
 * 合并英中字幕：按时间区间重叠最大者匹配
 * 实测 TED 的 zh-cn 与 en 时间轴高度一致，匹配率 100%
 */
export function mergeTranslation(en: Sentence[], zh: Sentence[]): Sentence[] {
  return en.map((s) => {
    let best: Sentence | undefined;
    let bestOverlap = 0;
    for (const t of zh) {
      const overlap = Math.min(s.endMs, t.endMs) - Math.max(s.startMs, t.startMs);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = t;
      }
    }
    return { ...s, translation: best?.text };
  });
}

/** 对句子时间轴应用补偿（裁掉 intro 后为负值） */
export function applyOffset(sentences: Sentence[], offsetMs: number): Sentence[] {
  return sentences.map((s) => ({
    ...s,
    startMs: s.startMs + offsetMs,
    endMs: s.endMs + offsetMs,
  }));
}

/**
 * 把句子时间轴钳制到音频实际时长范围内
 *
 * 为什么必须做：
 * 实测音频 495.93s，但 VTT 末两句（"Thank you." / "(Applause)"）标注到 499.87s，
 * 超出约 3.9s。根因是「丢弃的 intro 分片时长 3.527s」与「VTT 偏移常量 3.504s」
 * 之间存在 23ms 系统误差，加上片尾可能存在截断，误差累积到末尾。
 *
 * 若不钳制，UI 会 seek 到不存在的区间，导致播放器卡住或行为异常。
 *
 * 处理策略：
 * - endMs 超出上界 → 钳到 durationMs
 * - startMs 超出上界 → 该句标记为不可播（startMs 也钳到末尾，长度为 0）
 * - startMs 为负 → 钳到 0
 */
export function clampSentencesToAudio(
  sentences: Sentence[],
  durationMs: number
): Sentence[] {
  const upper = Math.max(0, durationMs - 1);

  return sentences.map((s) => {
    const startMs = Math.max(0, Math.min(s.startMs, upper));
    const endMs = Math.max(startMs, Math.min(s.endMs, upper));
    if (startMs === s.startMs && endMs === s.endMs) return s;
    return { ...s, startMs, endMs };
  });
}
