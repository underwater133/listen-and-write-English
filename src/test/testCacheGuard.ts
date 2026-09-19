/**
 * 缓存校验逻辑测试
 *
 * 覆盖三件事：
 *   1. quickValidateAac 能正确识别坏文件
 *   2. 缓存路径重定位（素材目录被迁移后仍能复用，见 2026-09-19 事故）
 *   3. fetchAudio 的缓存复用闸门判据
 *
 * 用法：node out/test/testCacheGuard.js
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { quickValidateAac } from '../core/demux';
import { relocateAudioPath, AudioInfo, AUDIO_CACHE_VERSION } from '../core/types';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`✅ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? '  ' + detail : ''}`);
  }
}

/** 构造一个合法的 ADTS 帧序列 */
function makeValidAac(frameCount: number, frameLen = 378): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < frameCount; i++) {
    const h = Buffer.alloc(7);
    // sync 0xFFF + MPEG-4 + Layer0 + protection_absent
    h[0] = 0xff;
    h[1] = 0xf1;
    // profile=01(LC) sfi=0100(44100) private=0 ch_cfg 高位=0
    h[2] = 0x50;
    // ch_cfg 低位=10(stereo) + frame_length 高 2 位
    h[3] = 0x80 | ((frameLen >> 11) & 0x03);
    h[4] = (frameLen >> 3) & 0xff;
    h[5] = ((frameLen & 0x07) << 5) | 0x1f;
    h[6] = 0xfc;
    parts.push(h, Buffer.alloc(frameLen - 7, 0x5a));
  }
  return Buffer.concat(parts);
}

function main(): void {
  console.log('=== 缓存自检逻辑测试 ===\n');

  // 1. 合法文件应通过
  const good = makeValidAac(100);
  const r1 = quickValidateAac(good);
  check('合法 ADTS 文件通过校验', r1.ok, `探测 ${r1.probedFrames} 帧`);

  // 2. 文件头非同步字应拒绝（模拟 PES/编码器残留）
  const badHead = Buffer.concat([
    Buffer.from('Lavc58.101.101\0', 'latin1'),
    makeValidAac(50),
  ]);
  const r2 = quickValidateAac(badHead);
  check('文件头有残留时拒绝', !r2.ok, r2.reason ?? '');

  // 3. 帧链中途断裂应拒绝
  const valid = makeValidAac(50);
  const broken = Buffer.concat([valid, Buffer.from([0x17, 0xae, 0x6b, 0x87])]);
  // 在中间插入垃圾（保证落在抽样窗口内）
  const mid = Math.floor(valid.length / 2);
  const brokenMid = Buffer.concat([
    valid.subarray(0, mid),
    Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
    valid.subarray(mid),
  ]);
  const r3 = quickValidateAac(brokenMid);
  check('帧链中断时拒绝', !r3.ok, r3.reason ?? '');

  // 4. 极小文件应拒绝
  const tiny = Buffer.from([0xff, 0xf1, 0x50]);
  const r4 = quickValidateAac(tiny);
  check('过小文件拒绝', !r4.ok, r4.reason ?? '');

  // 5. 真实坏文件的头部模式（实测样本）
  const realBad = Buffer.from(
    'fff15080265ffcde0400' + '4c61766335382e3130312e313031' + '00' + '4235991fdfac00',
    'hex'
  );
  const r5 = quickValidateAac(Buffer.concat([realBad, Buffer.alloc(200, 0x5a)]));
  check('实测坏样本被拒绝', !r5.ok, r5.reason ?? '');

  /* ---------- 6. 素材目录迁移后的路径重定位 ----------
   *
   * 真实事故（2026-09-19）：配置 `listeningTrainer.materialsDir` 后，素材被
   * 自动搬到新目录，但 audio.json 里存的仍是旧绝对路径。点素材库卡片报
   * 「该素材的音频缓存已过期」——而 audio.mp3 就好好躺在当前目录里。
   */
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-relocate-'));
    const oldDir = path.join(root, 'old', 'ted-99');
    const newDir = path.join(root, 'new', 'ted-99');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });

    const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(4096, 0x11)]);
    fs.writeFileSync(path.join(newDir, 'audio.mp3'), mp3);

    const info: AudioInfo = {
      path: path.join(oldDir, 'audio.mp3'), // 旧位置，已随目录搬迁消失
      format: 'mp3',
      durationMs: 1000,
      sampleRate: 44100,
      channels: 2,
      frameCount: 10,
      bytes: mp3.length,
      startOffsetMs: -3504,
      cacheVersion: AUDIO_CACHE_VERSION,
    };

    const relocated = relocateAudioPath(newDir, info);
    check(
      '迁移后能按当前目录重新定位音频（旧绝对路径失效）',
      relocated === path.join(newDir, 'audio.mp3'),
      String(relocated)
    );

    // 反面：真的没有音频文件时必须返回 null，不能瞎猜一个路径
    check('目录里没有音频文件时返回 null', relocateAudioPath(oldDir, info) === null);

    // 路径本来就有效时不应改动
    const fresh: AudioInfo = { ...info, path: path.join(newDir, 'audio.mp3') };
    check(
      '路径仍有效时原样返回',
      relocateAudioPath(oldDir, fresh) === path.join(newDir, 'audio.mp3')
    );

    // 记录里的目录部分不可信：只允许取文件名，不能顺着 ".." 往外跑
    const escaping: AudioInfo = { ...info, path: path.join('..', '..', 'audio.mp3') };
    check('忽略记录里的目录部分（防越界）', relocateAudioPath(newDir, escaping) === path.join(newDir, 'audio.mp3'));

    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) process.exit(1);
}

main();
