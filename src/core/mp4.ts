/**
 * 裸 ADTS(AAC) → MP4 封装（零依赖）
 *
 * ─────────────────────────────────────────────────────────────────
 * 为什么必须做这件事（实测结论）
 * ─────────────────────────────────────────────────────────────────
 * 裸 ADTS 的 .aac 文件在 VS Code 的 webview 里必然播放失败：
 *
 *   Blob size : 8170675 | type = audio/aac       ← 字节完全正确
 *   详情      : code=4 | ns=3 | ms=22
 *   errMsg    : PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN:
 *               FFmpegDemuxer: open context failed
 *
 * 反复排除后确认：文件本身没问题
 *   - 帧链完整（21519 帧、brokenAt=-1、paramVariants=1、lengthCv=0.12）
 *   - 首帧 ADTS 头 ff f1 50 80 → AOT 2 = AAC-LC（不是 LTP）
 *   - 同一文件用 Chrome 的 <audio> 直读 file:// 能播（52ms 拿到
 *     duration=499.01），用 Blob 也能播（24ms）
 *   - 宿主导出的 base64 与磁盘字节逐一相同（1 对 1 校验通过）
 *
 * 差异只在「谁在解封装」：
 *   Chrome（静态链接完整 ffmpeg）→ 裸 ADTS 可播
 *   VS Code 内置 ffmpeg.dll（2.76MB，裁剪版）→ 裸 ADTS 解不开
 *
 * 实测该 ffmpeg.dll 的字符串表：
 *   "mov,mp4,m4a,3gp,3g2,mj2"  ✅  QuickTime / MOV 解复用器在
 *   "MPEG-TS (MPEG-2 Transport Stream)"  ❌ 缺
 *   "WAV / WAVE (Waveform Audio)"        ❌ 缺
 *   "adts"                      ❌ 缺
 *
 * → 结论：VS Code 的 ffmpeg 只保留了「够用于编辑器内预览」的容器，
 *   裸 ADTS 不在其中。正确的修法不是绕（换 URL、换 Blob、改 MIME），
 *   而是【换容器】：把已经解出来的 AAC 帧重新封进 MP4。
 *
 * ─────────────────────────────────────────────────────────────────
 * 为什么选 MP4 而不是 WAV
 * ─────────────────────────────────────────────────────────────────
 * 同一段 36s 音频实测：
 *   ADTS 原样  576 KB   ← VS Code 播不了
 *   MP4 封装   568 KB   ← 只多约 3KB 容器开销，体积最优 ✅
 *   WAV(PCM)   6.1 MB   ← 10.8× 膨胀；全片 499s 要 84MB ❌
 *
 * ─────────────────────────────────────────────────────────────────
 * 为什么不是转码而是封装
 * ─────────────────────────────────────────────────────────────────
 * 帧还是那些 AAC-LC 帧，一字节没动，只是外面套了 MP4 的 sample table。
 * 无重采样、无质量损失、无额外依赖（不需要 ffmpeg 二进制），
 * Node 里几十毫秒就能完成 8MB 文件的封装。
 */

const SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350,
];

/** ADTS 一帧固定 1024 个采样（numBlocks=0 时） */
const SAMPLES_PER_FRAME = 1024;

export interface AdtsToMp4Options {
  /** 调试日志 */
  log?: (msg: string) => void;
}

export interface AdtsToMp4Result {
  /** MP4 字节 */
  mp4: Buffer;
  /** 帧数 */
  frameCount: number;
  /** 采样率 */
  sampleRate: number;
  /** 声道数 */
  channels: number;
  /** Audio Object Type（2 = AAC-LC） */
  aot: number;
  /** AudioSpecificConfig 字节 */
  asc: Buffer;
  /** 时长（毫秒），由帧数自算 */
  durationMs: number;
}

/* ------------------------------------------------------------------ */
/* box 工具                                                            */
/* ------------------------------------------------------------------ */

function box(type: string, ...payloads: Buffer[]): Buffer {
  const size = 8 + payloads.reduce((a, b) => a + b.length, 0);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(size, 0);
  head.write(type, 4, 4, 'ascii');
  return Buffer.concat([head, ...payloads]);
}

function fullBox(type: string, version: number, flags: number, ...payloads: Buffer[]): Buffer {
  const vf = Buffer.alloc(4);
  vf.writeUInt8(version, 0);
  vf.writeUIntBE(flags, 1, 3);
  return box(type, vf, ...payloads);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff, 0);
  return b;
}

function u8(n: number): Buffer {
  return Buffer.from([n & 0xff]);
}

function zeros(n: number): Buffer {
  return Buffer.alloc(n);
}

function fourcc(s: string): Buffer {
  return Buffer.from(s, 'ascii');
}

/** 3x3 单位矩阵（16.16 定点），MP4 里是固定值 */
function unityMatrix(): Buffer {
  const b = Buffer.alloc(36);
  b.writeUInt32BE(0x00010000, 0);   // a
  b.writeUInt32BE(0x00010000, 16);  // d
  b.writeUInt32BE(0x40000000, 32);  // w
  return b;
}

/* ------------------------------------------------------------------ */
/* ADTS                                                                */
/* ------------------------------------------------------------------ */

interface AdtsHeader {
  protectionAbsent: number;
  /** profile 字段（= AOT - 1） */
  profileField: number;
  sfIndex: number;
  channelConfig: number;
  frameLength: number;
  headerLength: number;
}

function readAdtsHeader(buf: Buffer, off: number): AdtsHeader | null {
  if (off + 7 > buf.length) return null;
  // 同步字 12 bit 全 1
  if (buf[off] !== 0xff || (buf[off + 1] & 0xf0) !== 0xf0) return null;

  const protectionAbsent = buf[off + 1] & 0x01;
  const profileField = (buf[off + 2] >> 6) & 0x03;
  const sfIndex = (buf[off + 2] >> 2) & 0x0f;
  const channelConfig = ((buf[off + 2] & 0x01) << 2) | ((buf[off + 3] >> 6) & 0x03);
  const frameLength =
    ((buf[off + 3] & 0x03) << 11) | (buf[off + 4] << 3) | ((buf[off + 5] >> 5) & 0x07);
  const headerLength = protectionAbsent ? 7 : 9;

  if (sfIndex > 12) return null;
  if (channelConfig === 0) return null;
  if (frameLength < headerLength) return null;

  return { protectionAbsent, profileField, sfIndex, channelConfig, frameLength, headerLength };
}

/**
 * AudioSpecificConfig（ASC），2 字节形式
 *
 *   audioObjectType         5 bit   AAC-LC = 2
 *   samplingFrequencyIndex  4 bit
 *   channelConfiguration    3 bit
 *
 * 实测：AAC-LC / 44.1kHz / stereo → 12 10
 */
function buildAsc(aot: number, sfIndex: number, channelConfig: number): Buffer {
  const b = Buffer.alloc(2);
  b[0] = ((aot & 0x1f) << 3) | ((sfIndex >> 1) & 0x07);
  b[1] = ((sfIndex & 0x01) << 7) | ((channelConfig & 0x0f) << 3);
  return b;
}

/* ------------------------------------------------------------------ */
/* esds                                                                */
/* ------------------------------------------------------------------ */

function buildEsds(asc: Buffer): Buffer {
  // DecoderSpecificInfo（tag 0x05）
  const dsi = Buffer.concat([u8(0x05), u8(asc.length), asc]);

  // DecoderConfigDescriptor（tag 0x04）
  const dcdBody = Buffer.concat([
    u8(0x40),          // objectTypeIndication: MPEG-4 Audio
    u8(0x15),          // streamType=5(audio)<<2 | upStream=0 | reserved=1
    u8(0x00), u8(0x00), u8(0x00), // bufferSizeDB
    u32(128000), u32(128000),     // maxBitrate / avgBitrate
    dsi,
  ]);
  const dcd = Buffer.concat([u8(0x04), u8(0x80), u8(0x80), u8(0x80), u8(dcdBody.length), dcdBody]);

  // ES_Descriptor（tag 0x03）
  const esBody = Buffer.concat([u16(0), u8(0x00), dcd]);
  const esd = Buffer.concat([u8(0x03), u8(0x80), u8(0x80), u8(0x80), u8(esBody.length), esBody]);

  return fullBox('esds', 0, 0, esd);
}

/* ------------------------------------------------------------------ */
/* 结构自检                                                            */
/* ------------------------------------------------------------------ */

/**
 * 校验产出的 MP4 在结构上是否自洽。
 *
 * 这是"验证工具本身"——必须能真正区分好坏，否则就是一片虚假的绿。
 * 判定原则：**父子尺寸自洽**，而不是"某个 box 存在"。
 *
 * @throws 任一结构不变量被破坏时
 */
function assertMp4Structure(
  mp4: Buffer,
  expectFrames: number,
  expectChannels: number,
  expectAsc: Buffer
): void {
  const insp = inspectMp4(mp4);
  if (!insp.ok) {
    throw new Error(`ADTS 转 MP4 自检失败：${insp.reason}`);
  }
  if (insp.frameCount !== expectFrames) {
    throw new Error(
      `ADTS 转 MP4 自检失败：stsz.sampleCount=${insp.frameCount}，期望 ${expectFrames}`
    );
  }
  if (insp.channels !== expectChannels) {
    throw new Error(
      `ADTS 转 MP4 自检失败：mp4a.channelCount=${insp.channels}，期望 ${expectChannels}`
    );
  }
  // ASC 必须完整嵌在 esds 里 —— 解析器靠它才知道怎么解码。
  if (mp4.indexOf(expectAsc) < 0) {
    throw new Error(
      `ADTS 转 MP4 自检失败：esds 内未找到 AudioSpecificConfig（期望 ${expectAsc.toString('hex')}）`
    );
  }
}

/**
 * 结构自检结果。
 *
 * 这是「验证工具本身」——必须能真正区分好坏，否则就是一片虚假的绿。
 * 判定原则：**父子尺寸自洽 + 字段位置正确**，而不是"某个 box 存在"。
 */
export interface Mp4Inspection {
  ok: boolean;
  reason?: string;
  /** 从 stsz 读出的样本数（ok=false 时为 0） */
  frameCount: number;
  /** 从 mp4a 读出的声道数（ok=false 时为 0） */
  channels: number;
  /** 从 mp4a 读出的采样率（ok=false 时为 0） */
  sampleRate: number;
}

/**
 * 检查一个 MP4 的结构是否自洽 —— 不需要任何预期值，全部从文件自身读出。
 *
 * 用途：
 *   1. muxer 落盘前自检（配合 assertMp4Structure 比对预期值）
 *   2. **缓存校验** —— 判断磁盘上的旧文件能不能安全复用
 *
 * ⚠️ 第 2 个用途是关键。曾出过这样的事故：muxer 的 mp4a 多写了 4 字节，
 * 修好代码后忘了递增缓存版本号，而当时的缓存校验只查 ftyp/moov/mdat
 * 是否存在 —— 坏文件这三个也都有，于是校验通过、坏缓存被复用，
 * 等于"代码修了，用户跑的还是旧数据"。
 *
 * 所以缓存校验必须用**同一个**结构化判据，而不是宽松的存在性检查。
 * 这个函数就是那唯一的判据来源。
 */
export function inspectMp4(buf: Buffer): Mp4Inspection {
  const no = (reason: string): Mp4Inspection => ({
    ok: false,
    reason,
    frameCount: 0,
    channels: 0,
    sampleRate: 0,
  });

  if (buf.length < 256) return no('文件过小');

  // ── 顶层：ftyp / moov / mdat 顺序与覆盖
  let off = 0;
  const tops: string[] = [];
  let mdatDataStart = -1;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off);
    if (size < 8 || off + size > buf.length) {
      return no(`顶层 box @${off} 尺寸非法（size=${size}）`);
    }
    const type = buf.toString('ascii', off + 4, off + 8);
    tops.push(type);
    if (type === 'mdat') mdatDataStart = off + 8;
    off += size;
  }
  if (off !== buf.length) return no(`顶层 box 未填满文件（走到 ${off}，共 ${buf.length}）`);
  if (tops[0] !== 'ftyp') return no(`第 1 个顶层 box 应为 ftyp，实为 ${tops[0]}`);
  if (tops[1] !== 'moov') return no(`第 2 个顶层 box 应为 moov，实为 ${tops[1]}`);
  if (tops[2] !== 'mdat') return no(`第 3 个顶层 box 应为 mdat，实为 ${tops[2]}`);

  // ── mp4a（AudioSampleEntry）：固定部分必须恰好 28 字节，子 box 紧接其后
  //
  // 注意区分两个概念：
  //   mp4aSize   = 整个 box 的字节数（含 8 字节头 + 固定部分 + 子 box）
  //   固定部分   = 从 box 头之后起、到子 box 之前的字段区 = 恒定 28 字节
  //   子 box 起点 = mp4aAt + 8 + 28 = mp4aAt + 36
  // 所以要校验的是【子 box 起点处的 box 头是否合法】，而不是 size-8 的值。
  //
  // ★ 这是本项目真实踩过的坑：固定部分多写了 4 字节 → esds 被挤到 +40
  //   → 解析器在 +36 读到 4 个全零（size=0 的假 box）
  //   → 判定整轨无可用流 → DEMUXER_ERROR_NO_SUPPORTED_STREAMS。
  const mp4aAt = buf.indexOf('mp4a', 0, 'ascii') - 4;
  if (mp4aAt < 4) return no('未找到 mp4a');
  const mp4aSize = buf.readUInt32BE(mp4aAt);
  if (mp4aSize < 36) {
    return no(`mp4a 过小（size=${mp4aSize}），固定部分就已占 36 字节（含 box 头）`);
  }
  const subAt = mp4aAt + 36;
  if (subAt + 8 > buf.length) return no('mp4a 子 box 位置越界');
  const subSize = buf.readUInt32BE(subAt);
  const subTypeStr = buf.toString('ascii', subAt + 4, subAt + 8);
  if (subTypeStr !== 'esds') {
    return no(
      `mp4a 的固定部分应为 28 字节、子 box 在 +36 处为 esds；` +
        `实际 +36 处读到 size=${subSize} type=${JSON.stringify(subTypeStr)}` +
        `（固定部分被多写了几字节，把 esds 往后挤了）`
    );
  }
  if (subSize < 8 || 36 + subSize !== mp4aSize) {
    return no(`mp4a 与 esds 尺寸不自洽（36 + ${subSize} ≠ ${mp4aSize}）`);
  }
  const channels = buf.readUInt16BE(mp4aAt + 24);
  const sampleRate = buf.readUInt32BE(mp4aAt + 32);
  if (channels <= 0 || channels > 8) return no(`mp4a.channelCount 非法（${channels}）`);
  if (sampleRate <= 0) return no(`mp4a.sampleRate 非法（${sampleRate}）`);

  // ── esds：descriptor 链必须能走通，且含非空 DecoderSpecificInfo(ASC)
  const esdsAt = subAt;
  const esdsSize = buf.readUInt32BE(esdsAt);
  if (buf.readUInt32BE(esdsAt + 8) !== 0) return no('esds 的 version/flags 非 0');
  if (buf[esdsAt + 12] !== 0x03) {
    return no(`esds 首个 descriptor 应为 ES_DescrTag(0x03)，实为 0x${buf[esdsAt + 12].toString(16)}`);
  }
  const esdsBody = buf.subarray(esdsAt + 12, esdsAt + esdsSize);
  let hasAsc = false;
  for (let i = 0; i < esdsBody.length - 1; i++) {
    // tag 0x05 = DecoderSpecificInfoTag，其长度字节非 0 即含 ASC
    if (esdsBody[i] === 0x05 && esdsBody[i + 1] > 0 && i + 2 < esdsBody.length) {
      hasAsc = true;
      break;
    }
  }
  if (!hasAsc) return no('esds 内未找到 AudioSpecificConfig（解码器无法得知音频参数）');

  // ── stsz / stts / stsc / stco 自洽，且数据长度闭合
  const stszAt = buf.indexOf('stsz', 0, 'ascii') - 4;
  const sttsAt = buf.indexOf('stts', 0, 'ascii') - 4;
  const stscAt = buf.indexOf('stsc', 0, 'ascii') - 4;
  const stcoAt = buf.indexOf('stco', 0, 'ascii') - 4;
  if (stszAt < 0 || sttsAt < 0 || stscAt < 0 || stcoAt < 0) {
    return no('缺少 stsz/stts/stsc/stco');
  }
  const stszCount = buf.readUInt32BE(stszAt + 16);
  if (stszCount <= 0) return no(`stsz.sampleCount 非法（${stszCount}）`);
  if (buf.readUInt32BE(sttsAt + 16) !== stszCount) {
    return no('stts 采样总数与 stsz 不符');
  }
  if (buf.readUInt32BE(stscAt + 20) !== stszCount) {
    return no('stsc.samplesPerChunk 与 stsz 不符（单 chunk 描述）');
  }
  const stcoFirst = buf.readUInt32BE(stcoAt + 16);
  if (stcoFirst !== mdatDataStart) {
    return no(`stco.firstOffset=${stcoFirst}，应为 mdat 数据起点 ${mdatDataStart}`);
  }
  // 逐样本长度之和必须等于 mdat 载荷长度（数据零丢失的最后一道闸）
  let sum = 0;
  let p = stszAt + 20;
  for (let i = 0; i < stszCount; i++) {
    if (p + 4 > buf.length) return no('stsz 表越界');
    sum += buf.readUInt32BE(p);
    p += 4;
  }
  const mdatBoxAt = buf.indexOf('mdat', 0, 'ascii') - 4;
  const mdatPayload = buf.readUInt32BE(mdatBoxAt) - 8;
  if (sum !== mdatPayload) {
    return no(`stsz 长度之和 ${sum} ≠ mdat 载荷 ${mdatPayload}（帧数据有丢失或错位）`);
  }

  return { ok: true, frameCount: stszCount, channels, sampleRate };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把裸 ADTS AAC 封装成 MP4（fMP4 之外的普通 MP4，moov 在前）
 *
 * @param adts 裸 ADTS 字节（必须是完整帧链，从第 1 帧头开始）
 * @throws 无有效帧或参数不一致时
 */
export function adtsToMp4(adts: Buffer, opts: AdtsToMp4Options = {}): AdtsToMp4Result {
  const log = opts.log ?? (() => {});
  if (adts.length < 128) throw new Error('ADTS 转 MP4 失败：输入过小');

  // 1) 收集帧（去掉 ADTS 头，只留 raw AAC access unit）
  const frames: Buffer[] = [];
  let off = 0;
  let first: AdtsHeader | null = null;
  let mismatchAt = -1;

  while (off + 7 <= adts.length) {
    const h = readAdtsHeader(adts, off);
    if (!h) break;
    if (off + h.frameLength > adts.length) break;

    if (!first) {
      first = h;
    } else if (
      h.profileField !== first.profileField ||
      h.sfIndex !== first.sfIndex ||
      h.channelConfig !== first.channelConfig
    ) {
      mismatchAt = off;
      break;
    }

    frames.push(adts.subarray(off + h.headerLength, off + h.frameLength));
    off += h.frameLength;
  }

  if (!first || frames.length === 0) {
    throw new Error('ADTS 转 MP4 失败：未找到有效 ADTS 帧');
  }
  if (mismatchAt >= 0) {
    throw new Error(
      `ADTS 转 MP4 失败：偏移 ${mismatchAt} 处帧参数变化，数据可能损坏。` +
        `MP4 的 stsd 只能描述单一音轨参数，无法混装。`
    );
  }

  const tail = adts.length - off;
  if (tail > 2048) {
    throw new Error(
      `ADTS 转 MP4 失败：帧链在 ${off} 字节处断裂，剩余 ${tail} 字节无法解析。`
    );
  }

  const sampleRate = SAMPLE_RATES[first.sfIndex];
  const channels = first.channelConfig;
  const aot = first.profileField + 1;        // 2 = AAC-LC
  const asc = buildAsc(aot, first.sfIndex, channels);
  const timescale = sampleRate;
  const n = frames.length;
  const durationTs = Math.round((n * SAMPLES_PER_FRAME * timescale) / sampleRate);

  log(
    `[ADTS→MP4] ${n} 帧 / AOT ${aot} / ${sampleRate}Hz / ${channels}ch / ` +
      `ASC=${asc.toString('hex')} / 丢弃帧尾 ${tail} 字节`
  );

  // 2) stbl 子表
  // AudioSampleEntry：固定部分 28 字节（不含 8 字节 box 头）
  //   reserved(6) + dataRefIdx(2) + reserved(8) + channelCount(2)
  //   + sampleSize(2) + preDefined(2) + reserved(2) + sampleRate(4) = 28
  //
  // ⚠️⚠️ 这里【不能】再补一个 u32(0)。
  //   末尾的 sampleRate 就是固定部分的最后一字段，其后紧跟子 box（esds）。
  //   多写 4 字节会把 esds 从 +36 挤到 +40，解析器在 +36 读到 4 个全零
  //   → 一个 size=0 的假 box → 判定整轨无可用流 → 播放失败：
  //     DEMUXER_ERROR_NO_SUPPORTED_STREAMS: FFmpegDemuxer: no supported streams
  //   注意 mp4a 的 timeScale 字段就是 sampleRate，别另加 timescale。
  const mp4a = box(
    'mp4a',
    zeros(6),          // reserved
    u16(1),            // data_reference_index
    zeros(8),          // reserved（version/revision/vendor）
    u16(channels),     // channelcount
    u16(16),           // samplesize
    u16(0),            // pre_defined
    u16(0),            // reserved
    u32(timescale),    // ⚠️ 音频 sampleRate，用 16.16 定点（此处即采样率）
    buildEsds(asc)     // ← 紧跟固定部分，中间不可插入任何字节
  );
  const stsd = fullBox('stsd', 0, 0, u32(1), mp4a);

  // stts：所有帧同长，一个 entry 即可
  const stts = fullBox('stts', 0, 0, u32(1), u32(n), u32(SAMPLES_PER_FRAME));

  // stsc：1 个 chunk 里放全部样本
  const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1));

  // stsz：逐样本长度
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(n), Buffer.concat(frames.map((f) => u32(f.length))));

  // stco：单 chunk 偏移，稍后回填（moov 在 mdat 之前，需要先知道 moov 大小）
  const stco = fullBox('stco', 0, 0, u32(1), u32(0));

  const stbl = box('stbl', stsd, stts, stsc, stsz, stco);

  // 3) minf / mdia / trak / moov
  //    smhd 是 version0 + flags + balance(u16) + reserved(u16) = 4 + 4 = 8 payload
  const smhd = fullBox('smhd', 0, 0, u16(0), u16(0));
  const dref = fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1));
  const dinf = box('dinf', dref);
  const minf = box('minf', smhd, dinf, stbl);

  // mdhd：creation/modification time, timescale, duration, language(und), pre_defined
  const mdhd = fullBox(
    'mdhd', 0, 0,
    u32(0), u32(0),
    u32(timescale), u32(durationTs),
    u16(0x55c4),   // 'und'
    u16(0)
  );
  const hdlr = fullBox(
    'hdlr', 0, 0,
    u32(0),
    fourcc('soun'),
    zeros(12),                       // reserved
    Buffer.from('SoundHandler\0', 'ascii')
  );
  const mdia = box('mdia', mdhd, hdlr, minf);

  // tkhd（track header，flags=3 表示 enabled+inMovie）
  const tkhd = fullBox(
    'tkhd', 0, 3,
    u32(0), u32(0),
    u32(1),              // track_ID
    u32(0),              // reserved
    u32(durationTs),     // duration（timescale 单位）
    zeros(8),            // reserved
    u16(0), u16(0),      // layer, alternate_group
    u16(0), u16(0),      // volume（音频固定 0）, reserved
    unityMatrix(),
    u32(0), u32(0)       // width / height（音频为 0）
  );
  const trak = box('trak', tkhd, mdia);

  // mvhd（next_track_ID = 2）
  const mvhd = fullBox(
    'mvhd', 0, 0,
    u32(0), u32(0),
    u32(timescale), u32(durationTs),
    u32(0x00010000),   // rate 1.0
    u16(0x0100),       // volume 1.0
    u16(0),            // reserved
    zeros(8),          // reserved
    unityMatrix(),
    zeros(24),         // pre_defined
    u32(2)             // next_track_ID
  );

  const moovTpl = box('moov', mvhd, trak);
  const ftyp = box(
    'ftyp',
    fourcc('isom'), u32(0x200),
    fourcc('isom'), fourcc('iso2'), fourcc('mp41'), fourcc('M4A ')
  );

  const MDAT_HEADER_SIZE = 8;
  const mdatDataStart = ftyp.length + moovTpl.length + MDAT_HEADER_SIZE;

  // 4) 回填 stco 的 first_offset
  const moov = Buffer.from(moovTpl);
  const stcoPos = moov.indexOf('stco', 0, 'ascii');
  if (stcoPos < 0) throw new Error('ADTS 转 MP4 内部错误：未找到 stco');
  moov.writeUInt32BE(mdatDataStart, stcoPos + 12);

  const mdat = box('mdat', Buffer.concat(frames));
  const mp4 = Buffer.concat([ftyp, moov, mdat]);

  // 5) 落盘前结构自检 —— 宁可抛错也不写出播放器解析不了的容器
  //
  // 背景：mp4a 曾多写 4 字节，导致 esds 从 +36 被挤到 +40，解析器在 +36
  // 读到全零假 box → DEMUXER_ERROR_NO_SUPPORTED_STREAMS。而当时的单测只
  // 检查"box 存在"，全部通过，坏文件照样写出去了。
  //
  // 教训：结构自检必须校验【父子尺寸自洽】，而不是"某 box 存在"。
  assertMp4Structure(mp4, n, channels, asc);

  return {
    mp4,
    frameCount: n,
    sampleRate,
    channels,
    aot,
    asc,
    durationMs: Math.round((n * SAMPLES_PER_FRAME * 1000) / sampleRate),
  };
}
