/**
 * 逐句时间轴修正层测试（core/timing.ts）
 *
 * 为什么值得单独测：
 *   1. 「随时能复原」是这个功能的立身之本 —— 一旦原始时间轴被就地改写，
 *      用户就再也回不去了。这里用「改 → 复原 → 与原始逐字段一致」把它锁死。
 *   2. timing.json 是手工产物，可能被外部编辑器弄坏（JSON 语法错、字段类型错、
 *      句序号越界）。坏数据必须退化成「无修正」，绝不能让素材打不开。
 *   3. 越界修正必须被挡住，否则会造出零长度句：seek 落空、播放器不动，
 *      看起来像「点了播放没反应」，比偏几百毫秒更难排查。
 *
 * 用法：node out/test/testTiming.js
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Sentence } from '../core/types';
import {
  applyTimingOverrides,
  clearAllTimingOverrides,
  clearTimingOverride,
  readTimingOverrides,
  setTimingOverride,
  timingFilePath,
} from '../core/timing';

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

function mkSentences(): Sentence[] {
  return [
    { index: 0, startMs: 1000, endMs: 2000, text: 'one', lineCount: 1 },
    { index: 1, startMs: 2000, endMs: 3000, text: 'two', lineCount: 1 },
    { index: 2, startMs: 3000, endMs: 4000, text: 'three', lineCount: 1 },
  ];
}

function main(): void {
  console.log('=== 逐句时间轴修正层测试 ===\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-timing-'));

  /* ---------- 1. 无修正时的一切行为都应"透明" ---------- */
  check('没有 timing.json 时读到空映射', Object.keys(readTimingOverrides(dir)).length === 0);

  const plain = mkSentences();
  const plainBefore = JSON.stringify(plain);
  const plainOut = applyTimingOverrides(plain, {}, 5000);
  check(
    '无修正时原样返回（不产生副本、不改动）',
    JSON.stringify(plainOut) === plainBefore && plainOut === plain
  );

  /* ---------- 2. 写入 / 读回 ---------- */
  setTimingOverride(dir, 1, { startMs: 2200, endMs: 3100 });
  check('timing.json 已落盘', fs.existsSync(timingFilePath(dir)));

  const ov1 = readTimingOverrides(dir);
  check(
    '读回的值与写入一致',
    ov1['1'] && ov1['1'].startMs === 2200 && ov1['1'].endMs === 3100,
    JSON.stringify(ov1)
  );

  const list = mkSentences();
  const listBefore = JSON.stringify(list);
  const merged = applyTimingOverrides(list, ov1, 5000);
  check(
    '修正句应用了新的起止时间',
    merged[1].startMs === 2200 && merged[1].endMs === 3100,
    `[${merged[1].startMs}, ${merged[1].endMs}]`
  );
  check('被修正的句子带 timingEdited 标记', merged[1].timingEdited === true);
  check('未被修正的句子没有标记', !merged[0].timingEdited && !merged[2].timingEdited);
  check(
    '未被修正的句子时间不变',
    merged[0].startMs === 1000 && merged[2].endMs === 4000
  );
  check(
    '★ 不修改入参数组（原始时间轴仍是原始值）',
    JSON.stringify(list) === listBefore,
    '这一条挂了就意味着"复原"不再可能'
  );

  /* ---------- 3. 复原本句：必须彻底回到原始 ---------- */
  clearTimingOverride(dir, 1);
  const ovAfterClear = readTimingOverrides(dir);
  check('复原本句后映射里没有该条', !ovAfterClear['1']);

  const restored = applyTimingOverrides(mkSentences(), ovAfterClear, 5000);
  check(
    '★ 复原后与原始句子【逐字段完全一致】',
    JSON.stringify(restored) === JSON.stringify(mkSentences()),
    '多出 timingEdited 或时间差 1ms 都算失败'
  );

  /* ---------- 4. 坏文件必须退化成「无修正」 ---------- */
  fs.writeFileSync(timingFilePath(dir), '{ this is not json', 'utf8');
  check('JSON 语法坏掉时读到空映射（不抛错）', Object.keys(readTimingOverrides(dir)).length === 0);

  fs.writeFileSync(timingFilePath(dir), JSON.stringify({ sentences: 'oops' }), 'utf8');
  check('结构不对时读到空映射', Object.keys(readTimingOverrides(dir)).length === 0);

  // 单条非法只丢那一条，其余照常生效
  fs.writeFileSync(
    timingFilePath(dir),
    JSON.stringify({
      sentences: {
        '0': { startMs: 3000, endMs: 2000 },     // 起止倒挂 → 丢弃
        '1': { startMs: 'x', endMs: 3000 },      // 非数字 → 丢弃
        '2': { startMs: 3100, endMs: 3900 },     // 合法 → 保留
        abc: { startMs: 0, endMs: 100 },         // key 不是序号 → 丢弃
      },
    }),
    'utf8'
  );
  const ovBad = readTimingOverrides(dir);
  check(
    '单条非法时只丢该条，合法的仍生效',
    Object.keys(ovBad).length === 1 && !!ovBad['2'],
    JSON.stringify(ovBad)
  );

  /* ---------- 5. 越界修正 ---------- */
  clearAllTimingOverrides(dir);

  // 5a) 终点超出音频长度 → 钳到音频末尾
  setTimingOverride(dir, 0, { startMs: 500, endMs: 9000 });
  const ovClamp = readTimingOverrides(dir);
  const clamped = applyTimingOverrides(mkSentences(), ovClamp, 4000);
  check(
    '终点超出音频长度时钳到末尾',
    clamped[0].endMs === 3999 && clamped[0].startMs === 500,
    `[${clamped[0].startMs}, ${clamped[0].endMs}]`
  );

  // 5b) 钳制后起止贴到一起 → 丢弃该修正，退回原始值
  //     （造出零长度句会让 seek 落空，比偏一点更糟）
  clearAllTimingOverrides(dir);
  setTimingOverride(dir, 0, { startMs: 3900, endMs: 8000 });
  const ovTiny = readTimingOverrides(dir);
  const tiny = applyTimingOverrides(mkSentences(), ovTiny, 3900);
  check(
    '★ 钳制后失去长度意义的修正被丢弃（退回原始值）',
    tiny[0].startMs === 1000 && tiny[0].endMs === 2000 && !tiny[0].timingEdited,
    `[${tiny[0].startMs}, ${tiny[0].endMs}]`
  );

  /* ---------- 6. 复原全部：文件应被删除，目录回到干净状态 ---------- */
  setTimingOverride(dir, 0, { startMs: 1100, endMs: 1900 });
  setTimingOverride(dir, 2, { startMs: 3200, endMs: 3800 });
  check('两条修正都在', Object.keys(readTimingOverrides(dir)).length === 2);

  clearAllTimingOverrides(dir);
  check('复原全部后映射为空', Object.keys(readTimingOverrides(dir)).length === 0);
  check(
    '★ 复原全部会删掉 timing.json（不留空壳文件）',
    !fs.existsSync(timingFilePath(dir))
  );

  /* ---------- 7. 写入的值取整，避免毫秒小数进缓存 ---------- */
  setTimingOverride(dir, 0, { startMs: 1234.6, endMs: 1999.4 });
  const ovRound = readTimingOverrides(dir);
  check(
    '毫秒值写入时取整',
    ovRound['0'].startMs === 1235 && ovRound['0'].endMs === 1999,
    JSON.stringify(ovRound['0'])
  );

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) process.exit(1);
}

main();
