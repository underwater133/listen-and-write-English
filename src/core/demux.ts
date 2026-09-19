/**
 * MPEG-TS 解封装 + AAC ADTS 提取（纯 JS，零外部依赖）
 *
 * 实测验证（ted-probe/TED-API-probe-report.md §2.6-2.7）：
 *   - 容器：MPEG-TS，188 字节定长包，同步字节 0x47
 *   - PAT → PMT PID = 4095
 *   - PMT: stream_type=0x0f (AAC ADTS) @ PID 256
 *   - 输出：AAC LC / 44100Hz / stereo，帧级零残留
 *   - 多分片拼接帧数守恒（776 = 259+258+259）
 *
 * 为什么不用 ffmpeg：TED 的音频是裸 ADTS，剥掉 TS 包头即可用，
 * 浏览器 <audio> 能直接播（已实测三条路线全通过）。
 */

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

/** ADTS 采样率表，索引对应 ADTS 头的 sampling_frequency_index */
export const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350,
];

/** AAC profile 名称，ADTS 头存的是 profile-1 */
export const AAC_PROFILES: Record<number, string> = {
  0: 'AAC Main',
  1: 'AAC LC',
  2: 'AAC SSR',
  3: 'AAC LTP',
};

export interface AdtsFrameInfo {
  /** profile 值（已 +1，2 = AAC LC） */
  profile: number;
  sampleRate: number;
  channels: number;
  frameLength: number;
  headerLength: number;
}

export interface AudioStreamInfo {
  /** PMT PID */
  pmtPid: number;
  /** 音频 ES 的 PID */
  audioPid: number;
  /** 音频 stream_type，0x0f = AAC ADTS */
  streamType: number;
  /** PMT 中所有 ES 流 */
  streams: Array<{ streamType: number; pid: number }>;
}

export interface DemuxResult {
  /** 提取出的裸 AAC（ADTS 拼接） */
  audio: Buffer;
  /** 音频流信息 */
  stream: AudioStreamInfo;
  /** ADTS 帧数 */
  frameCount: number;
  /** 首个 ADTS 帧的参数 */
  frameInfo: AdtsFrameInfo;
  /** 由帧数自算的真实时长（秒）。⚠️ 不要用播放器 duration */
  durationSec: number;
  /** 解封装中被跳过的非同步字节数（TS 填充残留，正常现象） */
  skippedBytes: number;
}

/** 解析 PAT，返回 program 1 的 PMT PID */
export function parsePat(ts: Buffer): number | null {
  for (let off = 0; off + TS_PACKET_SIZE <= ts.length; off += TS_PACKET_SIZE) {
    const pkt = ts.subarray(off, off + TS_PACKET_SIZE);
    if (pkt[0] !== TS_SYNC_BYTE) continue;

    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    if (pid !== 0) continue;
    if ((pkt[3] & 0x10) === 0) continue; // 无 payload

    const afc = (pkt[3] >> 4) & 0x03;
    let ps = 4;
    if (afc === 2 || afc === 3) ps = 4 + 1 + pkt[4];

    let p = pkt.subarray(ps);
    if (p.length < 8) continue;
    const pointerField = p[0];
    p = p.subarray(pointerField + 1);
    if (p[0] !== 0x00) continue; // table_id: PAT = 0x00

    const sectionLength = ((p[1] & 0x0f) << 8) | p[2];
    const body = p.subarray(8, 3 + sectionLength - 4);

    for (let k = 0; k + 4 <= body.length; k += 4) {
      const program = (body[k] << 8) | body[k + 1];
      const pmtPid = ((body[k + 2] & 0x1f) << 8) | body[k + 3];
      if (program === 1) return pmtPid;
    }
  }
  return null;
}

/** 解析 PMT，返回所有 ES 流 */
export function parsePmt(
  ts: Buffer,
  pmtPid: number
): Array<{ streamType: number; pid: number }> {
  for (let off = 0; off + TS_PACKET_SIZE <= ts.length; off += TS_PACKET_SIZE) {
    const pkt = ts.subarray(off, off + TS_PACKET_SIZE);
    if (pkt[0] !== TS_SYNC_BYTE) continue;

    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    if (pid !== pmtPid) continue;
    if ((pkt[3] & 0x10) === 0) continue;

    const afc = (pkt[3] >> 4) & 0x03;
    let ps = 4;
    if (afc === 2 || afc === 3) ps = 4 + 1 + pkt[4];

    let p = pkt.subarray(ps);
    if (p.length < 12) continue;
    const pointerField = p[0];
    p = p.subarray(pointerField + 1);
    if (p[0] !== 0x02) continue; // table_id: PMT = 0x02

    const sectionLength = ((p[1] & 0x0f) << 8) | p[2];
    const programInfoLength = ((p[10] & 0x0f) << 8) | p[11];
    let i = 12 + programInfoLength;
    const end = 3 + sectionLength - 4;

    const streams: Array<{ streamType: number; pid: number }> = [];
    while (i + 5 <= end) {
      const streamType = p[i];
      const elementaryPid = ((p[i + 1] & 0x1f) << 8) | p[i + 2];
      const esInfoLength = ((p[i + 3] & 0x0f) << 8) | p[i + 4];
      streams.push({ streamType, pid: elementaryPid });
      i += 5 + esInfoLength;
    }
    return streams;
  }
  return [];
}

/**
 * 提取指定 PID 的 ES 数据
 *
 * ⚠️ 必须剥离两层包头，这是本项目最深的坑：
 *   1. TS 包头（4 字节）+ 可选适配字段
 *   2. **PES 头** —— 仅出现在 payload_unit_start_indicator (PUSI) = 1 的包里
 *
 * 实测：TED 的 6 秒分片里 audioPid 有 560 个 TS 包，其中 37 个带 PUSI=1，
 * 即 ES 流里混着 37 个 PES 头（每个 14 字节起，steam_id=0xc0 表示 AAC）。
 * 早期实现只剥 TS 包头，这些 PES 头就被拼进了 ES，直接把 ADTS 帧链打断
 * （实测从第 7 帧后就断）。
 *
 * 症状：产出的 .aac 在浏览器里静默播放失败 —— 因为帧链错位，解码器无法同步。
 */
export function demuxPid(ts: Buffer, pid: number): Buffer {
  const chunks: Buffer[] = [];
  for (let off = 0; off + TS_PACKET_SIZE <= ts.length; off += TS_PACKET_SIZE) {
    const pkt = ts.subarray(off, off + TS_PACKET_SIZE);
    if (pkt[0] !== TS_SYNC_BYTE) continue;

    const id = ((pkt[1] & 0x1f) << 8) | pkt[2];
    if (id !== pid) continue;

    const pusi = (pkt[1] & 0x40) !== 0;
    if ((pkt[3] & 0x10) === 0) continue; // 无 payload

    const afc = (pkt[3] >> 4) & 0x03;
    let ps = 4;
    if (afc === 2 || afc === 3) ps = 4 + 1 + pkt[4];
    if (ps >= TS_PACKET_SIZE) continue;

    let payload = pkt.subarray(ps);

    // PUSI=1 时 payload 以 PES 头开始，剥掉它
    if (pusi) {
      if (
        payload.length >= 9 &&
        payload[0] === 0x00 &&
        payload[1] === 0x00 &&
        payload[2] === 0x01
      ) {
        const pesHeaderDataLength = payload[8];
        const skip = 9 + pesHeaderDataLength;
        if (skip <= payload.length) {
          payload = payload.subarray(skip);
        } else {
          // PES 头跨越到后续 TS 包（罕见），此处保守放弃该包头剩余部分
          payload = payload.subarray(payload.length);
        }
      }
    }

    if (payload.length > 0) chunks.push(payload);
  }
  return Buffer.concat(chunks);
}

/** ADTS 帧头固定长度（protection_absent=1 时 7 字节，否则 9 字节） */
const ADTS_MIN_HEADER = 7;

/**
 * 判断某个偏移处是否是「可信的」ADTS 起始
 *
 * ⚠️ 光看 0xFFF 同步字是不够的：AAC 压缩数据里 0xFF 后跟 0xF? 是常见字节组合，
 * 会造成大量假同步。必须同时满足：
 *   1. 同步字 0xFFF
 *   2. sampling_frequency_index 合法（否则采样率表查不到）
 *   3. channel_config 非 0
 *   4. frameLength 落在合理区间
 */
export function isPlausibleAdts(buf: Buffer, off: number, sampleRate?: number): boolean {
  if (off + ADTS_MIN_HEADER > buf.length) return false;
  if (buf[off] !== 0xff || (buf[off + 1] & 0xf0) !== 0xf0) return false;

  const b2 = buf[off + 2];
  const sfIndex = (b2 >> 2) & 0x0f;
  // 索引 13/14/15 是保留值
  if (sfIndex > 12) return false;

  const channels = ((b2 & 0x01) << 2) | ((buf[off + 3] >> 6) & 0x03);
  if (channels === 0) return false;

  const b3 = buf[off + 3];
  const frameLength =
    ((b3 & 0x03) << 11) | (buf[off + 4] << 3) | ((buf[off + 5] >> 5) & 0x07);
  // AAC 帧长下界约 7 字节头 + 少量数据；上界 8191 是字段上限
  if (frameLength < 12 || frameLength > 8191) return false;

  if (sampleRate !== undefined) {
    const sr = ADTS_SAMPLE_RATES[sfIndex];
    if (sr !== sampleRate) return false;
  }
  return true;
}

/**
 * 从给定偏移起，沿帧长链向前走 maxFrames 帧，返回成功走通的帧数
 *
 * 这是区分「真流起点」与「假同步」的核心手段：
 * 只有能连续自洽走通多帧的位置，才是真正的 ADTS 起点。
 */
export function walkAdtsChain(
  buf: Buffer,
  off: number,
  maxFrames: number,
  sampleRate?: number
): { frames: number; end: number } {
  let p = off;
  let frames = 0;
  while (frames < maxFrames) {
    if (!isPlausibleAdts(buf, p, sampleRate)) break;
    const b3 = buf[p + 3];
    const frameLength =
      ((b3 & 0x03) << 11) | (buf[p + 4] << 3) | ((buf[p + 5] >> 5) & 0x07);
    p += frameLength;
    frames++;
  }
  return { frames, end: p };
}

/**
 * 找到第一个 ADTS 同步头（0xFFF）的位置
 *
 * @deprecated 该实现只认同步字，容易在损坏数据里落在假同步上。
 *             请改用 findReliableAdtsStart()。
 */
export function findAdtsSync(buf: Buffer): number {
  for (let i = 0; i + 7 < buf.length; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xf0) === 0xf0) return i;
  }
  return -1;
}

/**
 * 找到「可信的」ADTS 流起点
 *
 * 算法：按可信度分两轮扫描，要求候选位置能连续走通 CHAIN_REQUIRED 帧。
 *   第一轮：要求采样率与预期一致（最强约束）
 *   第二轮：放宽采样率限制，仅要求帧长链自洽（兼容未知参数）
 *
 * @returns 起点偏移；找不到返回 -1
 */
export function findReliableAdtsStart(buf: Buffer, expectedSampleRate?: number): number {
  const CHAIN_REQUIRED = 8;
  const SCAN_LIMIT = Math.min(buf.length - ADTS_MIN_HEADER, 1 << 20); // 最多扫 1MB

  const passes: Array<number | undefined> = [
    expectedSampleRate,
    undefined,
  ];

  for (const sr of passes) {
    for (let i = 0; i < SCAN_LIMIT; i++) {
      if (!isPlausibleAdts(buf, i, sr)) continue;
      const { frames } = walkAdtsChain(buf, i, CHAIN_REQUIRED, sr);
      if (frames >= CHAIN_REQUIRED) return i;
    }
  }
  return -1;
}

/** 解析某个偏移处的 ADTS 头 */
export function parseAdtsHeader(buf: Buffer, off: number): AdtsFrameInfo {
  const b1 = buf[off + 1];
  const b2 = buf[off + 2];
  const b3 = buf[off + 3];

  const profile = ((b2 >> 6) & 0x03) + 1;
  const sfIndex = (b2 >> 2) & 0x0f;
  const channels = ((b2 & 0x01) << 2) | ((b3 >> 6) & 0x03);
  const frameLength =
    ((b3 & 0x03) << 11) | (buf[off + 4] << 3) | ((buf[off + 5] >> 5) & 0x07);

  return {
    profile,
    sampleRate: ADTS_SAMPLE_RATES[sfIndex] ?? 0,
    channels,
    frameLength,
    headerLength: b1 & 0x01 ? 7 : 9,
  };
}

/**
 * 逐帧遍历 ADTS，统计帧数并校验参数一致性
 *
 * ⚠️ 严格模式：一旦帧长链断裂就停止，不逐字节跳过。
 * 旧实现用「跳过垃圾字节继续找同步字」的容错逻辑，会在损坏数据里
 * 落入假同步并产出错位的帧序列 —— 而且 skipped 计数没人检查，
 * 问题被彻底掩盖。宁可少解出帧，也不能产出错位数据。
 *
 * @returns stats.paramVariants 应为 1（所有帧参数一致）。
 *          brokenAt >= 0 表示在该偏移处断链，说明数据有问题。
 */
export function walkAdtsFrames(buf: Buffer): {
  frames: number;
  skipped: number;
  consumed: number;
  info: AdtsFrameInfo | null;
  paramVariants: number;
  brokenAt: number;
  /** 帧长序列的稳定性指标：标准差 / 均值。> 1.5 说明可能错位 */
  lengthCv: number;
} {
  let off = 0;
  let frames = 0;
  let info: AdtsFrameInfo | null = null;
  let brokenAt = -1;
  const params = new Set<string>();
  const lengths: number[] = [];

  while (off + ADTS_MIN_HEADER <= buf.length) {
    if (!isPlausibleAdts(buf, off)) {
      brokenAt = off;
      break;
    }
    const h = parseAdtsHeader(buf, off);
    if (h.frameLength <= 0 || off + h.frameLength > buf.length) {
      brokenAt = off;
      break;
    }

    if (!info) info = h;
    params.add(`p=${h.profile} sr=${h.sampleRate} ch=${h.channels}`);
    lengths.push(h.frameLength);
    frames++;
    off += h.frameLength;
  }

  // 帧长变异系数：正常 AAC 帧长波动平缓，错位数据会剧烈跳动
  let lengthCv = 0;
  if (lengths.length > 1) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    if (mean > 0) {
      const varr =
        lengths.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lengths.length;
      lengthCv = Math.sqrt(varr) / mean;
    }
  }

  return {
    frames,
    skipped: 0,
    consumed: off,
    info,
    paramVariants: params.size,
    brokenAt,
    lengthCv,
  };
}

/**
 * 完整解封装：TS → 裸 AAC
 *
 * @param ts 单个或已拼接的 MPEG-TS 数据
 * @throws 当 PAT/PMT 解析失败或找不到音频流时
 */
export function demuxTsToAac(ts: Buffer): DemuxResult {
  const pmtPid = parsePat(ts);
  if (pmtPid === null) {
    throw new Error(
      'TS 解封装失败：找不到 PAT/PMT。可能是 TED 改了流结构，或下载到错误内容。'
    );
  }

  const streams = parsePmt(ts, pmtPid);
  const audioStream = streams.find((s) => s.streamType === 0x0f || s.streamType === 0x11);
  if (!audioStream) {
    throw new Error(
      `TS 解封装失败：PMT 中无 AAC 音频流（实际流: ${streams
        .map((s) => `0x${s.streamType.toString(16)}`).join(', ')}）`
    );
  }

  let es = demuxPid(ts, audioStream.pid);
  if (es.length === 0) throw new Error('TS 解封装失败：音频 ES 为空');

  // 用「帧长链自洽」找真正的起点，而不是只认第一个 0xFFF 同步字。
  // TED 的 ES 流开头会带 FFmpeg 写入的编码器元数据（实测见 "Lavc58.101.101"），
  // 只认同步字的旧实现会从这里开始产出错位帧序列。
  const sync = findReliableAdtsStart(es);
  if (sync < 0) throw new Error('TS 解封装失败：未找到可信的 ADTS 流起点');
  es = es.subarray(sync);

  const w = walkAdtsFrames(es);
  if (!w.info) throw new Error('TS 解封装失败：无有效 ADTS 帧');

  // 完整性校验：链条必须走到数据末尾附近，且帧长波动合理。
  // 宁可报错也不要产出坏文件 —— 坏文件在浏览器里是静默失败，极难排查。
  const tail = es.length - w.consumed;
  if (tail > 2048) {
    throw new Error(
      `TS 解封装失败：ADTS 帧链在第 ${w.consumed} 字节处断裂，剩余 ${tail} 字节无法解析。` +
        `可能是 TED 流结构变化或下载内容损坏。`
    );
  }
  if (w.paramVariants > 1) {
    throw new Error(
      `TS 解封装失败：ADTS 帧参数不一致（出现 ${w.paramVariants} 种组合），数据可能损坏。`
    );
  }
  if (w.frames > 32 && w.lengthCv > 1.5) {
    throw new Error(
      `TS 解封装失败：帧长波动异常（变异系数 ${w.lengthCv.toFixed(2)}），帧序列疑似错位。`
    );
  }

  return {
    audio: es,
    stream: {
      pmtPid,
      audioPid: audioStream.pid,
      streamType: audioStream.streamType,
      streams,
    },
    frameCount: w.frames,
    frameInfo: w.info,
    durationSec: (w.frames * 1024) / w.info.sampleRate,
    skippedBytes: w.skipped,
  };
}

/**
 * 快速校验一个 ADTS AAC 文件的结构完整性
 *
 * 用途：缓存复用前的自检。缓存只靠「存在性」判断会被坏的旧文件长期占用，
 * 表现为「代码修了但问题依旧」。
 *
 * ⚠️ 只抽样检查前若干帧与文件头，不扫全文件（大文件会慢）。
 *    用于快速判定「这个文件明显是坏的」，不做全量验证。
 *
 * @returns ok=false 时 reason 说明原因
 */
export function quickValidateAac(
  buf: Buffer,
  opts: { sampleProbeFrames?: number } = {}
): { ok: boolean; reason?: string; probedFrames: number } {
  const probe = opts.sampleProbeFrames ?? 64;

  if (buf.length < 64) {
    return { ok: false, reason: '文件过小', probedFrames: 0 };
  }
  // 文件头必须是 ADTS 同步字（早期 bug 会留下 PES/编码器残留）
  if (buf[0] !== 0xff || (buf[1] & 0xf0) !== 0xf0) {
    return {
      ok: false,
      reason: `文件头非 ADTS 同步字（实际 ${buf[0].toString(16)} ${buf[1].toString(16)}）`,
      probedFrames: 0,
    };
  }

  let off = 0;
  let frames = 0;
  while (frames < probe && off + ADTS_MIN_HEADER <= buf.length) {
    if (!isPlausibleAdts(buf, off)) {
      return {
        ok: false,
        reason: `第 ${frames} 帧处（偏移 ${off}）帧链断裂`,
        probedFrames: frames,
      };
    }
    const b3 = buf[off + 3];
    const len = ((b3 & 0x03) << 11) | (buf[off + 4] << 3) | ((buf[off + 5] >> 5) & 0x07);
    if (len < 12 || off + len > buf.length) {
      return {
        ok: false,
        reason: `第 ${frames} 帧长度非法（${len}）`,
        probedFrames: frames,
      };
    }
    off += len;
    frames++;
  }

  return { ok: true, probedFrames: frames };
}

/**
 * 拼接多个已单独解封装的 AAC 分片
 *
 * 实测：跨分片无截断（每片末帧完整），直接 concat 即可。
 * 每个分片必须先各自解封装（服务端每片独立携带 TS 头）。
 *
 * ⚠️ 不要用「帧数守恒」作为正确性依据 —— 若所有分片同样错位，
 *    计数依然相等。请用 quickValidateAac() 校验拼接后的结果。
 */
export function concatAacSegments(segments: Buffer[]): Buffer {
  return Buffer.concat(segments);
}

/** 生成 AAC 的 data URI（小文件可直接内联给 webview） */
export function toAacDataUri(aac: Buffer): string {
  return `data:audio/aac;base64,${aac.toString('base64')}`;
}
