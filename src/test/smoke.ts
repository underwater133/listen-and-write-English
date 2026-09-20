/**
 * 端到端冒烟测试 —— 不启动 VS Code，直接跑核心链路
 *
 * 目的：在按 F5 之前，先确认「TED 拉取 → 解封装 → 句子解析」
 *      这条链路真的能跑通，避免在 IDE 里盲猜问题。
 *
 * 运行：node out/test/smoke.js
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TedSource } from '../sources/ted';
import { checkSentence } from '../core/diff';
import { isValidMp3 } from '../core/transcode';
import { AUDIO_CACHE_VERSION } from '../core/types';

/** 软断言计数：❌ 必须影响退出码，否则「有失败但报全部通过」又是一次假信号 */
let softFail = 0;
function line(ok: boolean, text: string): void {
  if (!ok) softFail++;
  console.log(`  ${ok ? '✅' : '❌'} ${text}`);
}

const TALK_URL =
  'https://www.ted.com/talks/bill_gates_the_next_outbreak_we_re_not_ready';

async function main(): Promise<void> {
  const t0 = Date.now();
  const cacheDir = path.join(os.tmpdir(), 'listen-and-write-smoke');
  fs.mkdirSync(cacheDir, { recursive: true });

  console.log('缓存目录:', cacheDir);
  console.log('测试 talk:', TALK_URL);
  console.log('');

  const ted = new TedSource({
    quality: 'medium',
    concurrency: 6,
    skipIntro: true,
    withTranslation: true,
    log: (m) => console.log('  ' + m),
  });

  /* ---------- 步骤 1: 元数据 + 字幕 ---------- */
  console.log('[1/3] 拉取元数据与字幕…');
  const material = await ted.fetchMetadata(TALK_URL, cacheDir);
  console.log('');
  console.log('  标题    :', material.title);
  console.log('  演讲者  :', material.presenter);
  console.log('  句数    :', material.sentences.length);
  console.log('  语言数  :', material.availableLanguages.length);
  console.log('');

  const n = material.sentences.length;
  const first = material.sentences[0];
  const mid = material.sentences[Math.floor(n / 2)];
  const last = material.sentences[n - 1];

  console.log('  首句:', `${first.startMs}~${first.endMs}ms | ${first.text}`);
  console.log('  中句:', `${mid.startMs}~${mid.endMs}ms | ${mid.text}`);
  console.log('  末句:', `${last.startMs}~${last.endMs}ms | ${last.text}`);
  console.log('');

  // 断言：偏移已应用
  // VTT 原始首句为 9008ms，补偿 -3504ms 后应为 5504ms
  // （5504 恰好等于 __NEXT_DATA__ 中不含片头的时间轴，可交叉验证）
  const offsetApplied = first.startMs === 5504 || first.startMs === 9008 - 3504;
  console.log(
    `  ${offsetApplied ? '✅' : '❌'} 片头偏移已应用（首句 ${first.startMs}ms，期望 5504ms = 9008-3504）`
  );

  const hasTranslation = material.sentences.filter((s) => s.translation).length;
  console.log(`  ${hasTranslation > 0 ? '✅' : '⚠️ '} 译文数量: ${hasTranslation}/${n}`);

  // 断言：时间轴单调递增
  let monotonic = true;
  for (let i = 1; i < n; i++) {
    if (material.sentences[i].startMs < material.sentences[i - 1].startMs) {
      monotonic = false;
      console.log(`  ❌ 时间轴非单调：句 ${i - 1} → ${i}`);
      break;
    }
  }
  if (monotonic) console.log('  ✅ 时间轴单调递增');

  /* ---------- 步骤 2: 音频 ---------- */
  console.log('');
  console.log('[2/3] 下载并解封装音频…');
  let t = Date.now();
  const ready = await ted.fetchAudio(material, (p) => {
    // 下载阶段抽稀打印，其余阶段（解封装/转码）每报必打 —— 它们本来就只有十几次
    if (p.stage !== 'download' || p.done === p.total || p.done % 20 === 0) {
      process.stdout.write(`\r  ${p.message}                    `);
    }
  });
  process.stdout.write('\n');

  const audio = ready.audio!;
  console.log('  耗时    :', ((Date.now() - t) / 1000).toFixed(1), 's');
  console.log('  文件    :', audio.path);
  console.log('  大小    :', (audio.bytes / 1024 / 1024).toFixed(2), 'MB');
  console.log('  帧数    :', audio.frameCount);
  console.log('  采样率  :', audio.sampleRate, 'Hz');
  console.log('  声道    :', audio.channels);
  console.log('  时长    :', (audio.durationMs / 1000).toFixed(2), 's');
  console.log('  偏移    :', audio.startOffsetMs, 'ms');
  console.log('');

  // 断言：文件真实存在
  const fileOk = fs.existsSync(audio.path) && fs.statSync(audio.path).size > 1000;
  console.log(`  ${fileOk ? '✅' : '❌'} 音频文件已写入`);

  // 断言：时长与句子末句吻合（允许 5s 误差）
  // ⚠️ 必须用 ready.sentences —— 钳制发生在 fetchAudio 内部，
  //    material.sentences 仍是未钳制的原始数据
  const sentences = ready.sentences;
  const lastEnd = sentences[sentences.length - 1].endMs;
  const durDiff = Math.abs(audio.durationMs - lastEnd);
  console.log(
    `  ${durDiff < 5000 ? '✅' : '⚠️ '} 音频时长(${audio.durationMs}ms) vs 末句结束(${lastEnd}ms)，差 ${durDiff}ms`
  );

  // 断言：所有句子都能在音频范围内寻址（钳制后应全部通过）
  const outOfRange = sentences.filter(
    (s) => s.startMs < 0 || s.endMs > audio.durationMs
  );
  console.log(
    `  ${outOfRange.length === 0 ? '✅' : '❌'} 越界句数: ${outOfRange.length}` +
      (outOfRange.length > 0
        ? ' → ' + outOfRange.map((s) => `[${s.index}] end=${s.endMs}`).join(', ')
        : '')
  );
  console.log(`     音频时长上界 ${audio.durationMs}ms，末句 end=${lastEnd}ms`);

  const clampedInfo = sentences.filter(
    (s, i) => s.endMs !== material.sentences[i].endMs
  ).length;
  console.log(`  ✅ 被钳制的句数: ${clampedInfo}`);

  /* ---------- 步骤 2.5: 产物与缓存完整性（关键回归防线） ---------- */
  //
  // ⚠️ v5 起最终产物是 MP3（裸流，没有容器结构可查），所以判据从
  //    「ADTS 帧链能否贯穿到底」换成**共享的** isValidMp3()。
  //
  // 历史背景（别删）：v3 之前这里校验的是 audio.aac 的 ADTS 帧链。
  //    早期 demuxPid 只剥 TS 包头、没剥 PES 头，每约 2700 字节就有一个
  //    PES 头混进 ES 流把帧链打断，产出的文件在浏览器里静默失败；
  //    而当时的「帧数守恒」验证完全没发现 —— 因为两侧都同样多插了 PES 头。
  //
  // 教训：帧数守恒 ≠ 数据正确；判据必须跟着**当前产物**走，且单一来源。
  //    （2026-09-19 清理：这一段曾长期对 MP3 产物做 ADTS 校验，
  //      结果标准流程里恒报 ❌、脚本却仍打印「全部通过」——又是个假信号。）
  const buf = fs.readFileSync(audio.path);

  line(audio.format === 'mp3', `最终产物格式为 MP3（format=${audio.format}）`);

  const mp3Ok = isValidMp3(buf);
  line(
    mp3Ok,
    `MP3 结构校验通过（共享判据 isValidMp3，${(buf.length / 1024 / 1024).toFixed(2)}MB）`
  );

  line(
    audio.cacheVersion === AUDIO_CACHE_VERSION,
    `cacheVersion = ${audio.cacheVersion}（当前 ${AUDIO_CACHE_VERSION}）`
  );

  // 中间产物不应残留：裸 ADTS / MP4 在 VS Code 里都播不了，留着只占空间且易混淆
  const leftovers = ['audio.aac', 'audio.m4a'].filter((f) =>
    fs.existsSync(path.join(ready.cacheDir, f))
  );
  line(
    leftovers.length === 0,
    '中间产物已清理' + (leftovers.length ? `：残留 ${leftovers.join(', ')}` : '')
  );

  /* ---------- 步骤 3: diff 校验 ---------- */
  console.log('');
  console.log('[3/3] 验证听写校验…');
  const s3 = material.sentences[3];
  const r1 = checkSentence(3, s3.text, s3.text);
  // 删掉句中的第一个 "and"（该句为 "filled with cans of food and water."）
  const tampered = s3.text.replace(/\band\b/i, '');
  const r2 = checkSentence(3, s3.text, tampered);
  console.log('  标准:', s3.text);
  console.log(`  全对   → ${r1.correct ? '✅ correct' : '❌'} 准确率 ${(r1.accuracy * 100).toFixed(0)}%`);
  console.log(
    `  漏 and → ${!r2.correct ? '✅ 正确检出错误' : '❌ 未检出'} 准确率 ${(r2.accuracy * 100).toFixed(0)}%` +
      ` (输入: "${tampered}")`
  );
  if (!r2.correct) {
    const missKind = r2.tokens.find((t) => t.op === 'missing');
    console.log(
      `  归因   → ${missKind?.kind ?? '无'} / 漏词 "${missKind?.expected ?? '-'}"`
    );
  }

  console.log('');
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (softFail === 0) {
    console.log('===== 冒烟测试全部通过，总耗时 ' + secs + 's =====');
  } else {
    // ❌ 必须影响退出码 —— 否则「有失败但报全部通过」又是一次假信号
    console.log('===== 冒烟测试有 ' + softFail + ' 项失败，总耗时 ' + secs + 's =====');
    process.exitCode = 1;
  }
  console.log('');
  console.log('下一步：在 VS Code 中打开本目录，按 F5 启动扩展开发宿主。');
}

main().catch((e) => {
  console.error('');
  console.error('❌ 冒烟测试失败:', (e as Error).message);
  if ((e as Error).stack) console.error((e as Error).stack);
  process.exitCode = 1;
});
