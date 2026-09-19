/**
 * 定位 audio.aac 接缝损坏问题
 *
 * 逐个分片解封装，检查每片首尾是否帧边界对齐：
 * - 若某片首字节不是 0xFFF → 该片从帧中间开始（前一片的尾巴被切到这片）
 * - 若某片尾部有残余非整帧 → 该片的最后一个帧被切到下一片
 *
 * 用法：node out/test/diagSeams.js
 */

import { httpGetBuffer } from '../core/http';
import { demuxTsToAac } from '../core/demux';

const PM_ID = '2225';

async function main(): Promise<void> {
  // 复现 ted.ts 的分片获取逻辑
  const masterUrl = `https://hls.ted.com/project_masters/${PM_ID}/manifest.m3u8?intro_master_id=9294&preview=true`;
  const master = (await httpGetBuffer(masterUrl)).toString('utf8');

  const lines = master.split('\n').map((l) => l.trim());
  const audioTags = lines.filter(
    (l) => l.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(l)
  );
  const pick = audioTags.find((l) => /NAME="medium"/i.test(l)) ?? audioTags[0];
  const uri = pick.match(/URI="([^"]+)"/)?.[1]!;
  const variantUrl = new URL(uri, masterUrl).toString();
  const variant = (await httpGetBuffer(variantUrl)).toString('utf8');

  // 解析分片列表（含 EXTINF 与 DISCONTINUITY）
  const vlines = variant.split('\n').map((l) => l.trim());
  const segs: Array<{ url: string; isIntro: boolean }> = [];
  let introFlag = false;
  for (const l of vlines) {
    if (l.startsWith('#EXT-X-DISCONTINUITY')) introFlag = true;
    else if (l.length > 0 && !l.startsWith('#')) {
      segs.push({ url: new URL(l, variantUrl).toString(), isIntro: introFlag });
      introFlag = false;
    }
  }
  console.log('分片总数:', segs.length, ' 其中 intro:', segs.filter((s) => s.isIntro).length);

  // 只查前 6 个非 intro 分片即可定位接缝问题
  const check = segs.filter((s) => !s.isIntro).slice(0, 6);
  console.log('');

  const parts: Buffer[] = [];
  for (let i = 0; i < check.length; i++) {
    const ts = await httpGetBuffer(check[i].url);
    let r;
    try {
      r = demuxTsToAac(ts);
    } catch (e) {
      console.log(`片#${i} ❌ 解封装抛错: ${(e as Error).message}`);
      continue;
    }
    const b = r.audio;
    const headOk = b[0] === 0xff && (b[1] & 0xf0) === 0xf0;

    // 尾部是否整帧结尾
    let off = 0,
      frames = 0;
    while (off + 7 <= b.length) {
      if (b[off] !== 0xff || (b[off + 1] & 0xf0) !== 0xf0) break;
      const b3 = b[off + 3];
      const len = ((b3 & 0x03) << 11) | (b[off + 4] << 3) | ((b[off + 5] >> 5) & 0x07);
      if (len < 12 || off + len > b.length) break;
      frames++;
      off += len;
    }
    const tail = b.length - off;

    console.log(
      `片#${i} ts=${ts.length}B es=${b.length}B frames=${r.frameCount} ` +
        `head=${headOk ? 'ok' : '❌非帧头'} tail=${tail}B ${tail !== 0 ? '❌尾部有残余' : 'ok'} ` +
        `首字节=${b.subarray(0, 2).toString('hex')}`
    );
    parts.push(b);
  }

  // 模拟拼接后检查第一个断链点
  const joined = Buffer.concat(parts);
  let off = 0,
    frames = 0,
    broken = -1;
  while (off + 7 <= joined.length) {
    if (joined[off] !== 0xff || (joined[off + 1] & 0xf0) !== 0xf0) {
      broken = off;
      break;
    }
    const b3 = joined[off + 3];
    const len = ((b3 & 0x03) << 11) | (joined[off + 4] << 3) | ((joined[off + 5] >> 5) & 0x07);
    if (len < 12 || off + len > joined.length) {
      broken = off;
      break;
    }
    frames++;
    off += len;
  }
  console.log('');
  console.log(`拼接后: frames=${frames} brokenAt=${broken} 尾部剩余=${joined.length - off} B`);
  if (broken >= 0) {
    const ctx = joined.subarray(Math.max(0, broken - 12), broken + 12);
    console.log(`断链处上下文 hex: ${ctx.toString('hex').match(/.{2}/g)?.join(' ')}`);
  }
}

main().catch((e: unknown) => {
  console.error('失败:', (e as Error).message);
  process.exit(1);
});
