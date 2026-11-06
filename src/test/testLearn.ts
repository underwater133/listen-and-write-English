/**
 * 「词库」学习进度与游标测试
 *
 * 覆盖四件事：
 *   1. 恢复起点（锚词 → 下一个词；锚词丢失 → 退回计数）
 *   2. 跳过逻辑（已收藏/已掌握/脏词条由回调决定；全跳过 → -1）
 *   3. 存储（临时目录真实读写、重置删文件、坏文件兜底）
 *   4. 用户数据保护（vocab.json 进 USER_DATA_RELS / stats 目录受保护）
 *      + 收藏来源字段的旧数据补标
 *
 * 用法：node out/test/testLearn.js
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { EMPTY_PROGRESS, LearnStore, findNextIndex, resumeIndex } from '../core/learn';
import { Dictionary } from '../core/dictionary';
import { FavoriteStore } from '../core/favorites';
import { FAVORITES_FILE, STATS_DIR, VOCAB_FILE, isUserDataEntry, migrateUserData } from '../core/userdata';

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

function tmpRoot(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lt-learn-' + tag + '-'));
}

const WORDS = ['a', 'about', 'apple', 'book', 'zoo'];

console.log('=== 恢复起点（resumeIndex） ===');

check('空词表 → 0', resumeIndex([], EMPTY_PROGRESS) === 0);
check('没有进度 → 从头开始', resumeIndex(WORDS, EMPTY_PROGRESS) === 0);
check(
  '锚词 → 它的下一个（不会重看同一张卡）',
  resumeIndex(WORDS, { anchor: 'apple', learned: 3 }) === 3,
  '实际 ' + resumeIndex(WORDS, { anchor: 'apple', learned: 3 })
);
check(
  '锚词大小写/空白不敏感',
  resumeIndex(WORDS, { anchor: '  APPLE ', learned: 0 }) === 3
);
check(
  '锚词已不在词典 → 退回 learned 计数',
  resumeIndex(WORDS, { anchor: 'gone', learned: 2 }) === 2,
  '实际 ' + resumeIndex(WORDS, { anchor: 'gone', learned: 2 })
);
check(
  'learned 越界 → 夹到词表长度（渲染端据此显示"已刷完"）',
  resumeIndex(WORDS, { anchor: 'gone', learned: 999 }) === WORDS.length
);
check('锚词是最后一个 → 返回长度（等于刷完）', resumeIndex(WORDS, { anchor: 'zoo', learned: 5 }) === 5);

console.log('\n=== frontier（防来回切虚增「已学」） ===');

{
  const root = tmpRoot('frontier');
  const store = new LearnStore(root);
  store.save({ anchor: 'book', learned: 3, frontier: 'book' });
  const p = store.read();
  check('frontier 随 save/read 持久化（小写归一）', p.frontier === 'book' && p.learned === 3);
  store.save({ anchor: 'apple', learned: 3, frontier: 'APPLE ' });
  check('frontier 大小写/空白归一', store.read().frontier === 'apple');
  store.save({ anchor: 'a', learned: 1 });
  check('旧调用不传 frontier → 存空串（退回旧行为）', store.read().frontier === '');
  store.reset();
  check('重置后 frontier 清空', store.read().frontier === '');
}

console.log('\n=== 跳过逻辑（findNextIndex） ===');

check('不跳过时就是 start 本身', findNextIndex(WORDS, 0, () => false) === 0);
check(
  '跳过前两个 → 命中第 3 个',
  findNextIndex(WORDS, 0, (w) => w === 'a' || w === 'about') === 2
);
check('全部跳过 → -1', findNextIndex(WORDS, 0, () => true) === -1);
check('起点越界 → -1', findNextIndex(WORDS, 99, () => false) === -1);
check('负起点按 0 处理（不越界读）', findNextIndex(WORDS, -5, () => false) === 0);

console.log('\n=== 存储（LearnStore） ===');

const rootA = tmpRoot('store');
const storeA = new LearnStore(rootA);
const p0 = storeA.read();
check('新建 store → 未开始', p0.anchor === '' && p0.learned === 0);
storeA.save({ anchor: 'APPLE ', learned: 7 });
const p1 = storeA.read();
check('save / read 往返（锚词归一为小写）', p1.anchor === 'apple' && p1.learned === 7,
  JSON.stringify(p1));
check(
  '落在 stats/vocab.json',
  fs.existsSync(path.join(rootA, STATS_DIR, VOCAB_FILE)),
  path.join(rootA, STATS_DIR, VOCAB_FILE)
);
storeA.reset();
check('reset 直接删文件（不留空壳）', !fs.existsSync(path.join(rootA, STATS_DIR, VOCAB_FILE)));
check('reset 后 read → 未开始', storeA.read().learned === 0);

const rootB = tmpRoot('bad');
fs.mkdirSync(path.join(rootB, STATS_DIR), { recursive: true });
fs.writeFileSync(path.join(rootB, STATS_DIR, VOCAB_FILE), '{ not json', 'utf8');
const storeB = new LearnStore(rootB);
check('坏文件 → 视为未开始，绝不抛错', storeB.read().learned === 0 && storeB.read().anchor === '');
storeB.save({ anchor: 'x', learned: 1 });
check('坏文件之后仍能正常写入', storeB.read().anchor === 'x');

console.log('\n=== 用户数据保护 / 迁移 ===');

check('stats 目录整体受保护（清缓存不删进度）', isUserDataEntry(STATS_DIR));
check('vocab.json 名字不与素材标记 learn.json 冲突', String(VOCAB_FILE) !== 'learn.json');

const from = tmpRoot('from');
const to = tmpRoot('to');
fs.mkdirSync(path.join(from, STATS_DIR), { recursive: true });
fs.writeFileSync(path.join(from, STATS_DIR, VOCAB_FILE), JSON.stringify({ anchor: 'apple', learned: 3 }));
const mv = migrateUserData(from, to);
check(
  '换 materialsDir 时学习进度跟着迁移',
  mv.moved >= 1 && fs.existsSync(path.join(to, STATS_DIR, VOCAB_FILE)),
  'moved=' + mv.moved
);
check('迁移后内容不变', JSON.parse(fs.readFileSync(path.join(to, STATS_DIR, VOCAB_FILE), 'utf8')).anchor === 'apple');

console.log('\n=== 收藏来源（source） ===');

const rootF = tmpRoot('fav');
// 旧数据：没有 source 字段
fs.writeFileSync(
  path.join(rootF, FAVORITES_FILE),
  JSON.stringify({
    version: 1,
    items: [
      {
        id: 'old1',
        type: 'word',
        text: 'apple',
        translation: '苹果',
        pending: false,
        createdAt: 1,
        context: { sentenceText: '', sentenceTranslation: '', talkTitle: 'T', sourceUrl: '', sentenceIndex: 0 },
      },
    ],
  }),
  'utf8'
);
const favStore = new FavoriteStore(rootF);
check('旧收藏没有 source → 读出来补成 listening', favStore.list()[0].source === 'listening');
const added = favStore.add({
  type: 'word',
  text: 'zoo',
  translation: '动物园',
  pending: false,
  context: { sentenceText: '', sentenceTranslation: '', talkTitle: '', sourceUrl: '', sentenceIndex: 0 },
  source: 'wordlist',
});
check('词库收藏写入 source=wordlist', favStore.list().some((f) => f.id === added.fav.id && f.source === 'wordlist'));
check('词库收藏不需要课程上下文（不显示"未知课程"）', added.fav.context.talkTitle === '');

/* ---------------- 词典词表（wordList） ----------------
 * 需要异步（词典是惰性 gunzip 加载），所以放最后，汇总也一起挪进来。
 */

function writeDict(obj: any): string {
  const dir = tmpRoot('dict');
  const file = path.join(dir, 'dict.json.gz');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8')));
  return file;
}

(async () => {
  console.log('\n=== 词典词表（wordList） ===');

  // v2：带词频 → 只取有排名的词条，按排名升序（无排名的 "examonly" 不出现）
  const d2 = new Dictionary(
    writeDict({
      v: 2,
      words: {
        zoo: ['zu:', '动物园', 500],
        apple: ['ˈæpl', '苹果', 10],
        examonly: ['', '考纲词'],
      },
      lemma: {},
    })
  );
  const list2 = await d2.wordList();
  check(
    'v2 词典：只取有词频的词条，按排名升序',
    JSON.stringify(list2) === JSON.stringify(['apple', 'zoo']),
    JSON.stringify(list2)
  );
  const appleEntry = await d2.lookup('apple');
  check('v2 词典：lookup 带出词频排名', appleEntry?.frq === 10, String(appleEntry?.frq));

  // v1（旧词典）：没有排名 → 回退字母序，功能仍可用（兼容旧安装）
  const d1 = new Dictionary(
    writeDict({
      v: 1,
      words: { zoo: ['zu:', '动物园'], apple: ['ˈæpl', '苹果'] },
      lemma: {},
    })
  );
  const list1 = await d1.wordList();
  check(
    'v1 旧词典：没有词频 → 回退字母序（不空表，功能可用）',
    JSON.stringify(list1) === JSON.stringify(['apple', 'zoo']),
    JSON.stringify(list1)
  );
  check('v1 旧词典：lookup 不带 frq（不伪造排名）', (await d1.lookup('apple'))?.frq === undefined);

  // 词典文件缺失 → 空表而不是抛错（页面显示"词典不可用"）
  const missing = new Dictionary(path.join(tmpRoot('none'), 'nope.json.gz'));
  check('词典缺失 → 空词表，不抛错', (await missing.wordList()).length === 0);

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) process.exitCode = 1;
})();
