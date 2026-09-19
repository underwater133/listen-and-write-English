/**
 * AAC → MP3 转码
 *
 * ⚠️ 为什么必须做这一步（实测结论，不是猜测）：
 *
 *   VS Code webview 用的 ffmpeg.dll 是 Chromium 的**裁剪版**（2.76 MB / 仅 51 个导出）。
 *   用 FFI 直接查询它的能力：
 *     avcodec_find_decoder(86018, 即 AV_CODEC_ID_AAC) → NULL   ← 没有 AAC 解码器！
 *     avcodec_find_decoder(86017, 即 AV_CODEC_ID_MP3) → 有
 *   音频里【只有 12 个】解码器：
 *     pcm_* / mp3 / vorbis / flac
 *
 *   所以 AAC 音频在 VS Code 里必然报
 *     DEMUXER_ERROR_NO_SUPPORTED_STREAMS（容器开了、音轨也找到了，但没有解码器）
 *   而 Chrome 能播是因为它静态链接了完整 ffmpeg。
 *
 *   容器层（ADTS → MP4）只是必要条件；**编码格式这一层必须换成宿主认识的**。
 *   这里选 MP3：解码器确定存在、体积与源相当、容器是裸流无需再封装。
 *
 * 实现：
 *   - AAC 解码：vendor/libav（libav.js 的 h264parseaacdecode 变体，WASM，约 1.6 MB）
 *   - MP3 编码：vendor/lamejs（纯 JS，约 540 KB）
 *   实测（8.1 MB / 499.7s 的 TED 音频）：解码 0.77s + 编码 22.7s ≈ 23s。
 */

import * as path from 'path';

export interface TranscodeResult {
  mp3: Buffer;
  durationMs: number;
  sampleRate: number;
  channels: number;
  frameCount: number;
}

export interface TranscodeOptions {
  /** MP3 码率，默认 128 kbps（语音够用，体积与源相当） */
  bitrateKbps?: number;
  log?: (msg: string) => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type LibAV = {
  writeFile(p: string, data: Uint8Array): Promise<void>;
  ff_init_demuxer_file(p: string): Promise<[number, any[]]>;
  ff_init_decoder(codecId: number, par: any): Promise<any[]>;
  ff_read_frame_multi(ctx: number, pkt: number): Promise<any[]>;
  ff_decode_multi(c: number, pkt: number, frame: number, packets: any[], fin: boolean): Promise<any[]>;
  avcodec_find_decoder_by_name(name: string): number;
};

/** vendor 目录（out/core/transcode.js → 项目根/vendor） */
function vendorRoot(): string {
  return path.join(__dirname, '..', '..', 'vendor');
}

let libavPromise: Promise<LibAV> | null = null;

/**
 * 加载 libav（只加载一次，复用实例）
 *
 * 注意：本模块只做「AAC 解码」，不做转码以外的任何事。
 * libav 的实例持有 WASM 内存，复用比反复创建划算得多。
 */
async function getLibav(log: (m: string) => void): Promise<LibAV> {
  if (libavPromise) return libavPromise;
  libavPromise = (async () => {
    const glue = path.join(vendorRoot(), 'libav', 'libav-6.4.7.1-h264parseaacdecode.wasm.js');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(glue);
    const factory = mod.LibAV || mod.default || mod;
    const inst: LibAV = await factory({ noworker: true });
    const hasAac = inst.avcodec_find_decoder_by_name('aac');
    if (!hasAac) {
      throw new Error('AAC 解码器不可用：libav 变体缺少 aac 解码器');
    }
    log(`[transcode] libav 就绪（aac 解码器 = ${hasAac}）`);
    return inst;
  })();
  return libavPromise;
}

let lameReady = false;

/**
 * 加载 lamejs
 *
 * ⚠️ lamejs 1.2.1 的 npm 包有坑：src/js/*.js 里用了裸全局名
 *    （MPEGMode / BitStream / …）却没有 require 它们，
 *    直接 require('lamejs') 会报 "MPEGMode is not defined"。
 *    而官方打包文件 lame.min.js / lame.all.js 是浏览器版（挂 window），Node 里取不到。
 *    → 必须按依赖顺序把它们挂到 global，再 require index。
 */
function getLame(): any {
  if (lameReady) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path.join(vendorRoot(), 'lamejs', 'index'));
  }
  const dir = path.join(vendorRoot(), 'lamejs');
  const ORDER = [
    'MPEGMode', 'BitStream', 'LameGlobalFlags', 'Tables', 'Version', 'ATH',
    'LameInternalFlags', 'CalcNoiseResult', 'CalcNoiseData', 'GainAnalysis',
    'PsyModel', 'Presets', 'QuantizePVT', 'Takehiro', 'Reservoir', 'ScaleFac',
    'NewMDCT', 'FFT', 'Quantize', 'VBRTag', 'Encoder', 'Lame',
  ];
  const g = globalThis as any;
  for (const n of ORDER) {
    if (!g[n]) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      g[n] = require(path.join(dir, n + '.js'));
    }
  }
  lameReady = true;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(path.join(dir, 'index.js'));
}

/** float32 → int16（clamp，避免削波溢出） */
function clamp16(x: number): number {
  const v = Math.round(x * 32768);
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/**
 * 把 AAC（MP4 或 ADTS 容器）转成 MP3。
 *
 * @param srcAac 完整的容器字节（本项目产出的是 MP4/.m4a）
 * @throws 容器无法解析、无 AAC 解码器、无音频流时
 */
export async function transcodeToMp3(
  srcAac: Buffer,
  opts: TranscodeOptions = {}
): Promise<TranscodeResult> {
  const log = opts.log ?? (() => {});
  const kbps = opts.bitrateKbps ?? 128;
  if (srcAac.length < 1024) throw new Error('转码失败：输入过小');

  const libav = await getLibav(log);

  // 用「每帧唯一」的虚拟路径，避免同一 libav 实例里互相覆盖
  const vpath = `/src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.m4a`;
  await libav.writeFile(vpath, new Uint8Array(srcAac));

  // 1) 解封装
  const [fmtCtx, streams] = await libav.ff_init_demuxer_file(vpath);
  if (!streams || !streams.length) throw new Error('转码失败：没找到音频流');
  const st = streams[0];

  // 2) 解码器
  const initDec = await libav.ff_init_decoder(st.codec_id, st.codecpar);
  const dec = initDec[1];
  const pkt = initDec[2];
  const frame = initDec[3];

  // 3) 读包
  const readRes = await libav.ff_read_frame_multi(fmtCtx, pkt);
  const grouped = readRes[1];
  const pktList: any[] =
    (grouped && Array.isArray(grouped[st.index]) && grouped[st.index]) ||
    (grouped && Object.values(grouped).find((v) => Array.isArray(v))) ||
    [];
  if (!pktList.length) throw new Error('转码失败：没读到任何音频包');

  // 4) 解码全部帧
  const t0 = Date.now();
  const frames = await libav.ff_decode_multi(dec, pkt, frame, pktList, true);
  if (!frames || !frames.length) throw new Error('转码失败：解码后没有音频帧');

  const sampleRate: number = frames[0].sample_rate;
  const channels: number = frames[0].channels;
  log(`[transcode] 解码 ${frames.length} 帧 / ${sampleRate}Hz / ${channels}ch / ${Date.now() - t0}ms`);

  // 5) 编码 MP3
  const lamejs = getLame();
  const enc = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
  const chunks: Buffer[] = [];
  const t1 = Date.now();
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    const L = f.data[0];
    const R = f.data[1] || f.data[0];
    const n: number = f.nb_samples;
    // ⚠️ lamejs 的 encodeBuffer(left, right) 要【分离声道】数组，不是交错数组
    let buf: Int8Array;
    if (channels === 2) {
      const L16 = new Int16Array(n);
      const R16 = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        L16[i] = clamp16(L[i]);
        R16[i] = clamp16(R[i]);
      }
      buf = enc.encodeBuffer(L16, R16);
    } else {
      const M16 = new Int16Array(n);
      for (let i = 0; i < n; i++) M16[i] = clamp16(L[i]);
      buf = enc.encodeBuffer(M16, M16);
    }
    // ⚠️ encodeBuffer 返回 Int8Array，不能 Buffer.from(int8)（会把负数按值转成 255+）
    if (buf.length) chunks.push(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(Buffer.from(tail.buffer, tail.byteOffset, tail.byteLength));

  const mp3 = Buffer.concat(chunks);
  const totalSamples = frames.reduce((a, f) => a + f.nb_samples, 0);
  log(`[transcode] 编码 ${mp3.length} B / ${Date.now() - t1}ms`);

  return {
    mp3,
    durationMs: Math.round((totalSamples * 1000) / sampleRate),
    sampleRate,
    channels,
    frameCount: frames.length,
  };
}

/* ------------------------------------------------------------------ */
/* MP3 校验                                                            */
/* ------------------------------------------------------------------ */

/**
 * 校验一个 MP3（裸流，无容器结构可查）
 *
 * 只看两件事：
 *   1. 文件头是 MPEG 帧同步（0xFFEx）或 ID3 标签
 *   2. 还能继续扫到若干处同步 —— 排除「只有开头碰巧像」的截断文件
 *
 * 不做逐帧解析：帧长依赖比特率表，而产出方是固定码率的 lamejs，
 * 校验到这里足以拦住「空文件 / 被截断 / 根本不是 MP3」这三类。
 *
 * ⚠️ 这个函数是缓存放行与否的**唯一判据**，ted.ts 与 panel.ts 共用。
 *    两处各写一份迟早会漂移 —— 本项目已经踩过「判据漂移导致坏缓存被复用」的坑。
 */
export function isValidMp3(buf: Buffer): boolean {
  if (buf.length < 1024) return false;
  const syncAt = (i: number): boolean => buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0;
  const hasId3 = buf.toString('ascii', 0, 3) === 'ID3';
  if (!hasId3 && !syncAt(0)) return false;
  let n = 0;
  const end = Math.min(buf.length - 1, 65536);
  for (let i = 0; i < end; i++) {
    if (syncAt(i)) {
      n++;
      if (n >= 4) return true;
    }
  }
  return false;
}
