/**
 * MP4 封装器测试
 *
 * 为什么这个测试特别重要：
 *   本会话的核心 bug 是「音频字节完全正确、MIME 也对，但容器不对 →
 *   播放器解不开」。这类问题在字节层面查不出来，只能验证容器结构。
 *   所以这里不满足于「函数没抛异常」，而是逐项校验 MP4 的 box 结构 ——
 *   一个字段写错就会让浏览器报 MEDIA_ERR_SRC_NOT_SUPPORTED。
 *
 * 实测背景（VS Code 内置 ffmpeg.dll，2.76MB 裁剪版）：
 *   "mov,mp4,m4a,3gp,3g2,mj2"           ✅ 有 MP4/QuickTime 解复用器
 *   "MPEG-TS (MPEG-2 Transport Stream)" ❌ 缺
 *   "adts"                              ❌ 缺
 *   所以裸 ADTS 播不了，必须 MP4。
 */

import { adtsToMp4, inspectMp4 } from '../core/mp4';
import { demuxTsToAac } from '../core/demux';
import { AUDIO_CACHE_VERSION } from '../core/types';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? '  ← ' + detail : ''}`);
  }
}

console.log('=== MP4 封装器测试 ===\n');

/** 造一个合法的 ADTS 帧（7 字节头 + payload） */
function makeAdtsFrame(payloadLen: number, profileField = 1, sfIndex = 4, chanCfg = 2): Buffer {
  const frameLen = 7 + payloadLen;
  const b = Buffer.alloc(frameLen);
  b[0] = 0xff;
  b[1] = 0xf1; // MPEG-4, layer 0, protection_absent=1
  b[2] = ((profileField & 0x03) << 6) | ((sfIndex & 0x0f) << 2) | ((chanCfg >> 2) & 0x01);
  b[3] = ((chanCfg & 0x03) << 6) | ((frameLen >> 11) & 0x03);
  b[4] = (frameLen >> 3) & 0xff;
  b[5] = ((frameLen & 0x07) << 5) | 0x1f; // + buffer_fullness 高位
  b[6] = 0xfc;
  // payload 填非零数据，便于确认是否被原样搬运
  for (let i = 0; i < payloadLen; i++) b[7 + i] = (i * 7 + 13) & 0xff;
  return b;
}

/** 造一段可播放长度的 ADTS 流（多帧，帧长有变化，更接近真实） */
function makeAdtsStream(frameCount: number): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < frameCount; i++) {
    // 帧长在 200~400 之间波动，模拟真实 VBR
    parts.push(makeAdtsFrame(200 + ((i * 37) % 200)));
  }
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ */
/* 1. 基本转换                                                         */
/* ------------------------------------------------------------------ */

const stream = makeAdtsStream(50);
const r = adtsToMp4(stream);

check('能完成 ADTS → MP4 转换', r.mp4.length > 0);
check('帧数正确（50 帧）', r.frameCount === 50, `实际 ${r.frameCount}`);
check('采样率解析正确（44100）', r.sampleRate === 44100, `实际 ${r.sampleRate}`);
check('声道数解析正确（2）', r.channels === 2, `实际 ${r.channels}`);
check('AOT 解析正确（2 = AAC-LC）', r.aot === 2, `实际 ${r.aot}`);
check(
  'ASC 字节正确（LC/44.1k/stereo → 12 10）',
  r.asc.toString('hex') === '1210',
  `实际 ${r.asc.toString('hex')}`
);
check(
  '时长由帧数自算（50 帧 × 1024 / 44100）',
  r.durationMs === Math.round((50 * 1024 * 1000) / 44100),
  `实际 ${r.durationMs}`
);

/* ------------------------------------------------------------------ */
/* 2. MP4 box 结构（关键 —— 结构错就会 SRC_NOT_SUPPORTED）              */
/* ------------------------------------------------------------------ */

const mp4 = r.mp4;

check('以 ftyp box 开头', mp4.toString('ascii', 4, 8) === 'ftyp');

// 遍历顶层 box，确认 moov / mdat 齐全
function topLevelBoxes(buf: Buffer): Array<{ type: string; at: number; size: number }> {
  const out: Array<{ type: string; at: number; size: number }> = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const size = buf.readUInt32BE(o);
    if (size < 8 || o + size > buf.length) break;
    out.push({ type: buf.toString('ascii', o + 4, o + 8), at: o, size });
    o += size;
  }
  return out;
}

const top = topLevelBoxes(mp4);
const topTypes = top.map((b) => b.type);
check('顶层 box 顺序为 ftyp, moov, mdat', topTypes.join(',') === 'ftyp,moov,mdat', topTypes.join(','));
check(
  'moov 在 mdat 之前（保证元数据先于数据可用）',
  top.findIndex((b) => b.type === 'moov') < top.findIndex((b) => b.type === 'mdat')
);
check('所有顶层 box 长度自洽（无越界）', top.length === 3, `解析出 ${top.length} 个`);

// stsd 必须存在 —— 之前漏掉它就导致 code=4
//
// 注意：这里只需要「有没有这个 box」，用 indexOf 在 Buffer 上找即可。
// 不要对整个 Buffer 调 toString() —— 真实文件 8MB，转字符串既慢又占内存。
const mp4Ascii = mp4; // Buffer.indexOf 支持直接搜字符串

check('stbl 内含 stsd（采样描述，缺失会立即 SRC_NOT_SUPPORTED）', mp4Ascii.indexOf('stsd', 0, 'ascii') >= 0);
check('stsd 内是 mp4a 条目', mp4Ascii.indexOf('mp4a', 0, 'ascii') >= 0);
check('含 esds（DecoderConfig，告诉解码器这是 AAC-LC）', mp4Ascii.indexOf('esds', 0, 'ascii') >= 0);

// ⚠️⚠️ 光「box 存在」远远不够 —— 下面这组才是真正的防线。
//
// 血泪教训：mp4a 固定部分曾多写 4 字节（末尾多补了个 u32(0)），把 esds 从
// +36 挤到 +40。此时 stsd / mp4a / esds **三个 box 依然全部存在**，
// 上面三条断言全绿 —— 但解析器在 +36 读到 4 个全零（一个 size=0 的假 box），
// 判定整轨无可用流，播放失败：
//   DEMUXER_ERROR_NO_SUPPORTED_STREAMS: FFmpegDemuxer: no supported streams
//
// 所以必须校验【位置】与【父子尺寸自洽】，而不是存在性。
const mp4aAt = mp4Ascii.indexOf('mp4a', 0, 'ascii') - 4;
if (mp4aAt >= 0) {
  const mp4aSize = mp4.readUInt32BE(mp4aAt);
  // AudioSampleEntry 固定部分恒为 28 字节 → 子 box 起点 = box头(8) + 28 = +36
  const subAt = mp4aAt + 36;
  const subSize = mp4.readUInt32BE(subAt);
  const subType = mp4.readUInt32BE(subAt + 4).toString(16);
  check(
    'mp4a 的子 box 落在 +36 且是 esds（固定部分恰 28 字节）',
    subType === '65736473', // "esds"
    `+36 处读到 size=${subSize} type=0x${subType}` +
      (subSize === 0 ? '（全零 → 固定部分多写了字节）' : '')
  );
  check(
    'mp4a 与子 box 尺寸自洽（36 + 子box == mp4a）',
    36 + subSize === mp4aSize,
    `36 + ${subSize} = ${36 + subSize} vs mp4a=${mp4aSize}`
  );
  // 字段错位会让这两个值变成 0
  check(
    'mp4a 内 channelCount / sampleRate 字段未错位',
    mp4.readUInt16BE(mp4aAt + 24) === r.channels && mp4.readUInt32BE(mp4aAt + 32) === r.sampleRate,
    `ch=${mp4.readUInt16BE(mp4aAt + 24)} sr=${mp4.readUInt32BE(mp4aAt + 32)}`
  );
} else {
  check('mp4a 可定位', false, '未找到 mp4a');
}

// esds 里必须带上 AudioSpecificConfig
check('esds 里嵌入了 ASC（12 10）', mp4.includes(r.asc), '未找到 ASC 字节');

// stco 的偏移必须精确指向 mdat 数据区
const stcoAt = mp4Ascii.indexOf('stco', 0, 'ascii');
if (stcoAt >= 0) {
  const firstOffset = mp4.readUInt32BE(stcoAt + 12);
  const mdatBox = mp4Ascii.indexOf('mdat', 0, 'ascii');
  const mdatDataStart = mdatBox - 4 + 8;
  check(
    'stco 偏移精确指向 mdat 数据区',
    firstOffset === mdatDataStart,
    `stco=${firstOffset} 期望=${mdatDataStart}`
  );
} else {
  check('stco 存在', false, '未找到 stco');
}

// stsz 的样本数必须等于帧数
const stszAt = mp4Ascii.indexOf('stsz', 0, 'ascii');
if (stszAt >= 0) {
  const sampleCount = mp4.readUInt32BE(stszAt + 12);
  check('stsz 样本数与帧数一致', sampleCount === r.frameCount, `stsz=${sampleCount} 帧数=${r.frameCount}`);

  // ★ 数据零丢失的最后一道闸：逐样本长度之和必须恰等于 mdat 载荷长度。
  //   这条能同时抓住「帧丢了」「帧长写错」「mdat 尺寸不对」三类问题，
  //   比单纯比帧数可靠 —— 帧数守恒并不代表数据正确。
  const mdatBoxAt = mp4Ascii.indexOf('mdat', 0, 'ascii') - 4;
  const mdatPayload = mp4.readUInt32BE(mdatBoxAt) - 8;
  let sum = 0;
  let p = stszAt + 16;
  for (let i = 0; i < sampleCount; i++) {
    sum += mp4.readUInt32BE(p);
    p += 4;
  }
  check(
    'stsz 逐样本长度之和 == mdat 载荷长度（帧数据零丢失）',
    sum === mdatPayload,
    `${sum} vs ${mdatPayload}`
  );
} else {
  check('stsz 存在', false, '未找到 stsz');
}

/* ------------------------------------------------------------------ */
/* 3. 数据完整性：payload 必须逐字节保留                               */
/* ------------------------------------------------------------------ */

// MP4 里应当能找到原始 payload 序列（第一帧 payload 前 32 字节）
const firstFrame = makeAdtsFrame(200);
const firstPayload = firstFrame.subarray(7, 7 + 32);
check(
  '首帧 payload 被原样写入 MP4（未重编码、未改动）',
  mp4.includes(firstPayload),
  'payload 字节被改动，封装过程引入了数据变化'
);

// 体积模型（实测标定，别凭直觉断言）
//
// 省掉 7 字节/帧的 ADTS 头，付出 4 字节/帧的 stsz 表 + 约 800 字节固定容器开销。
// 实测（payload 200~400 字节/帧）：
//     n=10    diff=+569    perFrame=+56.9
//     n=100   diff=+299    perFrame=+2.99
//     n=500   diff=−901    perFrame=−1.80
//     n=21519 diff=−63958  perFrame=−2.97   ← 收敛到 (4−7)=−3
// 交叉点在约 270 帧。真实 TED talk 都是 2 万帧量级，所以净收益是负的（更小）。
//
// 这里断言的是「边际成本收敛于 −3 字节/帧」这个结构性事实，
// 而不是某个具体百分比 —— 后者会随 payload 大小变化而漂移。
const adtsBytes = stream.length;
const fixedOverhead = mp4.length - adtsBytes; // 小 N 时体现为固定开销
check(
  '小帧数时开销有上界（固定容器开销 < 1KB）',
  fixedOverhead < 1024,
  `固定开销约 ${fixedOverhead} 字节`
);

const bigAdts = makeAdtsStream(5000);
const bigMp4 = adtsToMp4(bigAdts);
const marginal = (bigMp4.mp4.length - bigAdts.length) / 5000;
check(
  '边际成本约 −3 字节/帧（= 4 字节 stsz − 7 字节 ADTS 头）',
  marginal < -2 && marginal > -4,
  `实测 ${marginal.toFixed(2)} 字节/帧`
);

check(
  '达到真实素材量级（2 万帧）时 MP4 明显更小',
  (() => {
    const a = makeAdtsStream(20000);
    return adtsToMp4(a).mp4.length < a.length;
  })(),
  '2 万帧量级的 MP4 未小于 ADTS，开销模型不符'
);

/* ------------------------------------------------------------------ */
/* 4. 结构自检本身必须可信（防止"检测器永远返回绿"）                   */
/* ------------------------------------------------------------------ */

// 产出的 MP4 必须能通过结构自检 —— 自检失败会直接抛错，
// 所以上面所有 adtsToMp4() 调用成功本身就已经证明了这一点。
// 这里额外确认：自检的判据对坏样本确实会拒绝。

// 人为把 mp4a 固定部分撑成 32 字节（在 +36 插入 4 个 0），
// 复现「esds 被挤到 +40」这个真实 bug，确认判据能识别。
const good = adtsToMp4(makeAdtsStream(64)).mp4;
const mp4aPos = good.indexOf('mp4a', 0, 'ascii') - 4;
const bad = Buffer.concat([
  good.subarray(0, mp4aPos + 36),
  Buffer.alloc(4),
  good.subarray(mp4aPos + 36),
]);
bad.writeUInt32BE(good.readUInt32BE(mp4aPos) + 4, mp4aPos);

const badSubAt = bad.indexOf('mp4a', 0, 'ascii') - 4 + 36;
check(
  '自检判据能区分好坏：坏样本在 +36 处读到 size=0',
  bad.readUInt32BE(badSubAt) === 0 && good.readUInt32BE(mp4aPos + 36) > 0,
  `坏=${bad.readUInt32BE(badSubAt)} 好=${good.readUInt32BE(mp4aPos + 36)}`
);

check(
  '好样本在 +36 处确实是 esds',
  good.readUInt32BE(mp4aPos + 40) === 0x65736473, // "esds"
  '0x' + good.readUInt32BE(mp4aPos + 40).toString(16)
);

/* ------------------------------------------------------------------ */
/* 5. 参数一致性与错误处理                                             */
/* ------------------------------------------------------------------ */

// 参数变化必须报错（MP4 的 stsd 只能描述单一轨）
const mixed = Buffer.concat([
  makeAdtsFrame(200, 1, 4, 2),
  makeAdtsFrame(200, 1, 3, 2), // sfIndex 变了
]);
let mixedErr = '';
try {
  adtsToMp4(mixed);
} catch (e) {
  mixedErr = (e as Error).message;
}
check('帧参数变化时报错（不产出坏 MP4）', mixedErr.includes('帧参数变化'), mixedErr || '未报错');

// 空/过小输入必须报错
let smallErr = '';
try {
  adtsToMp4(Buffer.alloc(10));
} catch (e) {
  smallErr = (e as Error).message;
}
check('输入过小时报错', smallErr.length > 0, '未报错');

// 没有 ADTS 帧（纯垃圾）必须报错，而不是产出空 MP4
let junkErr = '';
try {
  adtsToMp4(Buffer.alloc(1024, 0x41));
} catch (e) {
  junkErr = (e as Error).message;
}
check('无有效 ADTS 帧时报错', junkErr.length > 0, '未报错');

// 帧尾少量残留（<2048）应容忍；大量残留应报错
const withSmallTail = Buffer.concat([makeAdtsStream(10), Buffer.alloc(100, 0x00)]);
let tailOk = true;
try {
  adtsToMp4(withSmallTail);
} catch {
  tailOk = false;
}
check('容忍少量帧尾残留（<2048 字节）', tailOk);

const withBigTail = Buffer.concat([makeAdtsStream(10), Buffer.alloc(5000, 0x00)]);
let bigTailErr = '';
try {
  adtsToMp4(withBigTail);
} catch (e) {
  bigTailErr = (e as Error).message;
}
check('大量无法解析的尾部数据时报错', bigTailErr.includes('帧链'), bigTailErr || '未报错');

/* ------------------------------------------------------------------ */
/* 5. 与 demux 串联（端到端形状检查）                                  */
/* ------------------------------------------------------------------ */

// 造一个最小可解的 MPEG-TS 包（含 PAT + PMT + 音频 PID），验证
// demux → mp4 的衔接不会丢参数
function makeMinimalTs(): Buffer {
  const PKT = 188;
  const pkts: Buffer[] = [];

  function tsPacket(pid: number, payload: Buffer, pusi: boolean): Buffer {
    const p = Buffer.alloc(PKT, 0xff);
    p[0] = 0x47;
    p[1] = (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
    p[2] = pid & 0xff;
    p[3] = 0x10; // payload only
    payload.copy(p, 4, 0, Math.min(payload.length, PKT - 4));
    return p;
  }

  // PAT: program 1 → PMT PID 4095
  const patSection = Buffer.from([
    0x00, // pointer_field
    0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00,
    0x00, 0x01, 0xef, 0xff, // program 1 → PID 0x0fff = 4095
    0x00, 0x00, 0x00, 0x00,
  ]);
  pkts.push(tsPacket(0, patSection, true));

  // PMT: stream_type 0x0f (AAC ADTS) @ PID 256
  const pmtSection = Buffer.from([
    0x00, // pointer_field
    0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00,
    0xe1, 0x00, 0xf0, 0x00, // PCR PID 0x100, program_info_length 0
    0x0f, 0xe1, 0x00, 0xf0, 0x00, // stream_type=0x0f, PID 0x100, es_info_len 0
    0x00, 0x00, 0x00, 0x00,
  ]);
  pkts.push(tsPacket(4095, pmtSection, true));

  // 音频 ES：PES 头 + 一批 ADTS 帧，跨多个 TS 包
  const frames = makeAdtsStream(40);
  const pesHeader = Buffer.from([
    0x00, 0x00, 0x01, 0xc0, 0x00, 0x00, 0x84, 0x80, 0x05,
    0x21, 0x00, 0x01, 0x00, 0x01,
  ]);
  const es = Buffer.concat([pesHeader, frames]);
  for (let o = 0; o < es.length; o += PKT - 4) {
    pkts.push(tsPacket(256, es.subarray(o, o + PKT - 4), o === 0));
  }

  return Buffer.concat(pkts);
}

let e2eOk = false;
let e2eDetail = '';
try {
  const ts = makeMinimalTs();
  const demuxed = demuxTsToAac(ts);
  const packed = adtsToMp4(demuxed.audio);
  e2eOk =
    packed.sampleRate === demuxed.frameInfo.sampleRate &&
    packed.channels === demuxed.frameInfo.channels &&
    packed.mp4.toString('ascii', 4, 8) === 'ftyp';
  e2eDetail = `demux ${demuxed.frameCount} 帧 → mp4 ${packed.frameCount} 帧`;
} catch (e) {
  e2eDetail = (e as Error).message;
}
check('TS → demux → MP4 串联可跑通且参数一致', e2eOk, e2eDetail);

/* ------------------------------------------------------------------ */
/* 6. 缓存版本护栏                                                     */
/* ------------------------------------------------------------------ */

// 从裸 ADTS 换成 MP4 是【容器】层面的变更，旧缓存必须失效，
// 否则会继续喂给播放器裸 ADTS，问题看起来「修了但没好」。
//
// v4 的缘由：v3 产出的 MP4 结构不合法（mp4a 固定部分多写 4 字节，
// esds 错位到 +40），必须让这批文件也失效重封。
//
// v5 的缘由：最终产物从「MP4(内含AAC)」换成「MP3」。
//   根因是 VS Code 的 ffmpeg 没有 AAC 解码器（实测
//   avcodec_find_decoder(86018) = NULL），AAC 无论怎么封装都播不了；
//   而 mp3 解码器存在。所以必须让 v4 的 MP4 缓存全部失效、重新转码。
check(
  'AUDIO_CACHE_VERSION 已升到 5（最终产物改为 MP3）',
  AUDIO_CACHE_VERSION === 5,
  `实际 ${AUDIO_CACHE_VERSION}，须为 5 才能让 AAC 时代的缓存全部失效`
);

// ★ 缓存校验必须用结构化判据，不能只查 box 是否存在。
//   这里确认 inspectMp4 是导出的（缓存校验与落盘自检的单一判据来源）。
check(
  'inspectMp4 已导出（缓存校验与落盘自检共用同一判据）',
  typeof inspectMp4 === 'function',
  'inspectMp4 未导出'
);

// 真实事故回归：mp4a 多写 4 字节的文件必须被 inspectMp4 判为不合格。
// （这是 v3 缓存能被复用的根本原因 —— 当时的校验只查 ftyp/moov/mdat。）
{
  const goodMp4 = adtsToMp4(makeAdtsStream(64)).mp4;
  const at = goodMp4.indexOf('mp4a', 0, 'ascii') - 4;
  const broken = Buffer.concat([
    goodMp4.subarray(0, at + 36),
    Buffer.alloc(4),
    goodMp4.subarray(at + 36),
  ]);
  broken.writeUInt32BE(goodMp4.readUInt32BE(at) + 4, at);
  const r1 = inspectMp4(goodMp4);
  const r2 = inspectMp4(broken);
  check('inspectMp4 放行结构正确的 MP4', r1.ok, r1.reason || '');
  check(
    'inspectMp4 拒绝结构错位的 MP4（esds 被挤到 +40）',
    !r2.ok,
    r2.ok ? '竟然判为合格 —— 坏缓存会被复用！' : '理由：' + r2.reason
  );
  check(
    'inspectMp4 能从合格文件读出帧数/声道/采样率',
    r1.frameCount > 0 && r1.channels === 2 && r1.sampleRate === 44100,
    `frames=${r1.frameCount} ch=${r1.channels} sr=${r1.sampleRate}`
  );
}

/* ---------- 结果 ---------- */

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
