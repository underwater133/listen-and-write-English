/**
 * diff 校验器测试
 *
 * 用真实 TED 句子测，覆盖各类错误场景。
 * 运行：node out/test/runTests.js（编译后）
 */

import {
  checkSentence,
  tokenize,
  buildReport,
  MistakeRecord,
} from '../core/diff';

interface Case {
  name: string;
  expected: string;
  actual: string;
  expectCorrect: boolean;
  /** 期望出现的错误类型（至少包含） */
  expectKinds?: string[];
  expectMissingWord?: string;
}

const CASES: Case[] = [
  {
    name: '完全正确',
    expected: 'When I was a kid,',
    actual: 'When I was a kid',
    expectCorrect: true,
  },
  {
    name: '标点/大小写差异不算错',
    expected: 'the disaster we worried about most was a nuclear war.',
    actual: 'The disaster we worried about most was a nuclear war',
    expectCorrect: true,
  },
  {
    name: '漏听虚词 of',
    expected: 'part of the reason for this',
    actual: 'part the reason for this',
    expectCorrect: false,
    expectKinds: ['missing-function-word'],
    expectMissingWord: 'of',
  },
  {
    name: '漏听虚词 the',
    expected: 'we have a system to stop an epidemic',
    actual: 'we have a system to stop epidemic',
    expectCorrect: false,
    expectKinds: ['missing-function-word'],
    expectMissingWord: 'an',
  },
  {
    name: '拼写错误',
    expected: 'we invested in nuclear deterrents',
    actual: 'we invested in nuclear deterents',
    expectCorrect: false,
    expectKinds: ['spelling'],
  },
  {
    name: '错听实词',
    expected: 'Not missiles, but microbes.',
    actual: 'Not missiles but microbots',
    expectCorrect: false,
    expectKinds: ['misheard'],
  },
  {
    name: '多写词',
    expected: 'Thank you.',
    actual: 'Thank you very much',
    expectCorrect: false,
    expectKinds: ['extra'],
  },
  {
    name: '缩略词 gonna = going to 不算错',
    expected: 'we are going to be ready',
    actual: 'we are gonna be ready',
    expectCorrect: true,
  },
  {
    name: '缩略词 dont = do not 不算错',
    expected: 'I do not have an exact budget',
    actual: "I dont have an exact budget",
    expectCorrect: true,
  },
  {
    name: '空输入',
    expected: 'When I was a kid,',
    actual: '',
    expectCorrect: false,
  },
];

let pass = 0;
let fail = 0;

console.log('=== diff 校验器测试 ===\n');

CASES.forEach((c, i) => {
  const r = checkSentence(i, c.expected, c.actual);
  const problems: string[] = [];

  if (r.correct !== c.expectCorrect) {
    problems.push(`correct 期望 ${c.expectCorrect} 实际 ${r.correct}`);
  }

  if (c.expectKinds) {
    const actualKinds = new Set(r.tokens.filter((t) => t.op !== 'equal').map((t) => t.kind));
    for (const k of c.expectKinds) {
      if (!actualKinds.has(k as any)) {
        problems.push(`缺少错误类型 ${k}（实际: ${[...actualKinds].join(',') || '无'}）`);
      }
    }
  }

  if (c.expectMissingWord) {
    const found = r.tokens.some(
      (t) => t.op === 'missing' && t.expected === c.expectMissingWord
    );
    if (!found) {
      const missing = r.tokens.filter((t) => t.op === 'missing').map((t) => t.expected);
      problems.push(`未识别出漏听 ${c.expectMissingWord}（实际漏听: [${missing.join(', ')}]）`);
    }
  }

  const ok = problems.length === 0;
  if (ok) pass++;
  else fail++;

  console.log(`${ok ? '✅' : '❌'} ${c.name}`);
  console.log(`   期望: "${c.expected}"`);
  console.log(`   实写: "${c.actual}"`);
  console.log(`   准确率: ${(r.accuracy * 100).toFixed(0)}%`);
  if (!ok) {
    console.log(`   问题: ${problems.join('; ')}`);
    console.log(
      `   实际 tokens: ${r.tokens
        .filter((t) => t.op !== 'equal')
        .map((t) => `${t.op}[${t.expected ?? ''}|${t.actual ?? ''}|${t.kind ?? ''}]`)
        .join(' ')}`
    );
  }
  console.log();
});

/* ---------------- tokenize 测试 ---------------- */

console.log('=== tokenize 测试 ===');
const tokCases: Array<[string, string[]]> = [
  ["When I was a kid,", ['when', 'i', 'was', 'a', 'kid']],
  ["Not missiles, but microbes.", ['not', 'missiles', 'but', 'microbes']],
  ["don't stop", ['don\u2019t'.replace('\u2019', "'"), 'stop']],
  ["well-known fact", ['well-known', 'fact']],
  ["\u201Csmart quotes\u201D here", ['smart', 'quotes', 'here']],
];

tokCases.forEach(([input, want], i) => {
  const got = tokenize(input);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} "${input}" → [${got.join(', ')}]`);
  if (!ok) console.log(`   期望 [${want.join(', ')}]`);
});

/* ---------------- 报告测试 ---------------- */

console.log('\n=== 诊断报告测试 ===');
const records: MistakeRecord[] = [
  { timestamp: 1, materialId: 'ted:1', sentenceIndex: 0, kind: 'missing-function-word', expected: 'of' },
  { timestamp: 2, materialId: 'ted:1', sentenceIndex: 0, kind: 'missing-function-word', expected: 'of' },
  { timestamp: 3, materialId: 'ted:1', sentenceIndex: 1, kind: 'missing-function-word', expected: 'the' },
  { timestamp: 4, materialId: 'ted:1', sentenceIndex: 1, kind: 'spelling', expected: 'deterrents', actual: 'deterents' },
  { timestamp: 5, materialId: 'ted:1', sentenceIndex: 2, kind: 'misheard', expected: 'microbes', actual: 'microbots' },
];

const rep = buildReport(records);
console.log(`错误类型分布: ${JSON.stringify(rep.byKind)}`);
console.log(`弱读盲区 TOP: ${rep.functionWordBlindSpots.slice(0, 3).map((w) => `${w.word}(${w.count})`).join(', ')}`);
console.log(`最常出错: ${rep.topMissedWords.slice(0, 3).map((w) => `${w.word}(${w.count})`).join(', ')}`);

const reportOk =
  rep.byKind['missing-function-word'] === 3 &&
  rep.functionWordBlindSpots[0]?.word === 'of' &&
  rep.functionWordBlindSpots[0]?.count === 2;
if (reportOk) pass++; else fail++;
console.log(reportOk ? '✅ 报告统计正确' : '❌ 报告统计错误');

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exitCode = 1;
