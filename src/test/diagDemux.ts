/**
 * demux 缺陷诊断：用真实 TED 分片验证「假同步」问题是否已修复
 *
 * 用法：node out/test/diagDemux.js
 *
 * 它做四件事：
 *   1. 拉 1 个真实 TS 分片
 *   2. 用旧的「只认同步字」方式找起点，报告落在哪、帧长是否合理
 *   3. 用新的「帧长链自洽」方式找起点，报告落点与帧长分布
 *   4. 把两种方式产出的前几帧长度打出来对比
 */

import { httpGetBuffer } from '../core/http';
import {
  demuxPid,
  parsePat,
  parsePmt,
  findAdtsSync,
  findReliableAdtsStart,
  walkAdtsFrames,
  isPlausibleAdts,
} from '../core/demux';

const PM_ID = '2225';

async function main(): Promise<void> {
  console.log('=== demux 假同步诊断 ===\n');

  // 1. 拿 master manifest 找音频变体
  const masterUrl = `https://hls.ted.com/project_masters/${PM_ID}/manifest.m3u8`;
  let masterText: string;
  try {
    masterText = (await httpGetBuffer(masterUrl)).toString('utf8');
  } catch (e) {
    console.log('拉 manifest.m3u8 失败:', (e as Error).message);
    return;
  }

  const masterLines = masterText.split('\n').map((l) => l.trim());

  // 从 EXT-X-MEDIA:TYPE=AUDIO 里挑中档（NAME="medium"），否则取第一个 AUDIO
  const audioTags = masterLines.filter(
    (l) => l.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(l)
  );
  const pick =
    audioTags.find((l) => /NAME="medium"/i.test(l)) ?? audioTags[0] ?? null;
  const audioUri: string | null = pick ? pick.match(/URI="([^"]+)"/)?.[1] ?? null : null;

  if (!audioUri) {
    console.log('master.m3u8 里找不到音频 URI');
    console.log('--- 所有 EXT-X-MEDIA 行 ---');
    console.log(masterLines.filter((l) => l.startsWith('#EXT-X-MEDIA')).join('\n'));
    return;
  }
  console.log('音频变体 URI:', audioUri);

  const variantUrl = new URL(audioUri, masterUrl).toString();
  const variantText = (await httpGetBuffer(variantUrl)).toString('utf8');
  const variantLines = variantText.split('\n').map((l) => l.trim());

  const segLine = variantLines.find((l) => l.length > 0 && !l.startsWith('#'));
  if (!segLine) {
    console.log('变体播放列表里找不到分片');
    return;
  }
  const segUrl = new URL(segLine, variantUrl).toString();
  console.log('首个分片:', segUrl);

  const ts = await httpGetBuffer(segUrl);
  console.log('分片大小:', ts.length, 'B\n');

  // 2. 解出 ES
  const pmtPid = parsePat(ts);
  if (pmtPid === null) {
    console.log('PAT 解析失败');
    return;
  }
  const streams = parsePmt(ts, pmtPid);
  console.log(
    'PMT PID=' + pmtPid + '，ES 流:',
    streams.map((s) => `type=0x${s.streamType.toString(16)} pid=${s.pid}`).join(', ')
  );

  const audio = streams.find((s) => s.streamType === 0x0f || s.streamType === 0x11);
  if (!audio) {
    console.log('无 AAC 流');
    return;
  }
  const es = demuxPid(ts, audio.pid);
  console.log(`ES 长度: ${es.length} B, audioPid=${audio.pid}\n`);

  // 3. 旧方式
  const oldSync = findAdtsSync(es);
  console.log('--- 旧方式（只认 0xFFF 同步字）---');
  console.log('落点偏移:', oldSync);
  if (oldSync >= 0) {
    const oldEs = es.subarray(oldSync);
    const ow = walkAdtsFrames(oldEs);
    console.log(
      `帧数=${ow.frames} 断链@${ow.brokenAt} 帧长CV=${ow.lengthCv.toFixed(3)} 参数种类=${ow.paramVariants}`
    );
    console.log('帧长序列(前12):', frameLengths(oldEs, 12).join(', '));
    console.log('尾部剩余:', oldEs.length - ow.consumed, 'B');
  }

  // 4. 新方式
  console.log('\n--- 新方式（帧长链自洽）---');
  const newSync = findReliableAdtsStart(es);
  console.log('落点偏移:', newSync);
  if (newSync >= 0) {
    const newEs = es.subarray(newSync);
    const nw = walkAdtsFrames(newEs);
    console.log(
      `帧数=${nw.frames} 断链@${nw.brokenAt} 帧长CV=${nw.lengthCv.toFixed(3)} 参数种类=${nw.paramVariants}`
    );
    console.log('帧长序列(前12):', frameLengths(newEs, 12).join(', '));
    console.log('尾部剩余:', newEs.length - nw.consumed, 'B');
  } else {
    console.log('❌ 未找到可信起点');
  }

  // 5. 展示被跳过的前缀
  if (oldSync > 0) {
    const prefix = es.subarray(0, Math.min(oldSync, 64));
    console.log('\n被跳过前缀 hex:', prefix.toString('hex').match(/.{2}/g)?.join(' '));
    console.log('被跳过前缀 ascii:', prefix.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }

  // 6. 判定
  console.log('\n--- 结论 ---');
  if (oldSync > 0 && newSync > oldSync) {
    console.log('✅ 旧方式确实落在假同步上，新方式跳过了前缀并找到真起点');
  } else if (oldSync === newSync) {
    console.log('ℹ️ 该分片新旧方式结果一致（说明此分片 ES 头部干净）');
  } else {
    console.log('⚠️ 需要人工核对');
  }
  console.log('\n=== 诊断结束 ===');
}

function frameLengths(buf: Buffer, n: number): number[] {
  const out: number[] = [];
  let off = 0;
  while (off + 7 <= buf.length && out.length < n) {
    if (!isPlausibleAdts(buf, off)) break;
    const b3 = buf[off + 3];
    const len = ((b3 & 0x03) << 11) | (buf[off + 4] << 3) | ((buf[off + 5] >> 5) & 0x07);
    out.push(len);
    off += len;
  }
  return out;
}

main().catch((e: unknown) => {
  console.error('诊断失败:', (e as Error).message);
  process.exit(1);
});
