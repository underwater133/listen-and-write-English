/**
 * 复习（收藏单词的间隔重复）测试
 *
 * 覆盖四件事：
 *   1. 设置解析（阶梯字符串 → 毫秒，逐项容错回退）
 *   2. 组池与组队列（只复习 word、新词额度、到期补足、打散）
 *   3. 评分 → 进度（阶梯升降、重排预算、顶档「已掌握」）
 *   4. 存储（临时目录真实读写、跨日额度、坏文件兜底、跟随 materialsDir 迁移）
 *
 * 用法：node out/test/testReview.js
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  DAY_MS,
  DEFAULT_LADDER_TEXT,
  ReviewCandidate,
  ReviewConfig,
  ReviewState,
  ReviewStore,
  buildExtra,
  buildRound0,
  dateKey,
  gradeRequeue,
  normalizeConfig,
  parseDuration,
  parseLadder,
  reviewKey,
  schedule,
  selectPool,
  shuffle,
} from '../core/review';
import { REVIEW_FILE, STATS_DIR, isUserDataEntry, migrateUserData } from '../core/userdata';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lt-review-' + tag + '-'));
}

/** 只 word + 有释义 的收藏条目（selectPool 的输入） */
function fav(id: string, text: string, extra: any = {}): any {
  return {
    id,
    type: 'word',
    text,
    translation: '释义',
    pending: false,
    createdAt: extra.createdAt ?? 1,
    context: { sentenceText: extra.sentenceText ?? 'a sentence here' },
    ...extra,
  };
}

const CFG: ReviewConfig = normalizeConfig({
  ladder: DEFAULT_LADDER_TEXT,
  newWordsPerDay: 2,
  roundSize: 3,
  maxRequeue: 2,
});

function st(patch: Partial<ReviewState> = {}): ReviewState {
  return {
    level: 0,
    dueAt: 0,
    lastAt: 0,
    firstAt: 0,
    reviews: 0,
    mastered: false,
    ...patch,
  };
}

/* ---------------- 1. 设置解析 ---------------- */

function testParse(): void {
  check("parseDuration('10m') = 600000", parseDuration('10m') === 600000);
  check("parseDuration('2h') = 7200000", parseDuration('2h') === 7200000);
  check("parseDuration('1d') = 一天", parseDuration('1d') === DAY_MS);
  check("parseDuration('1w') = 7 天", parseDuration('1w') === 7 * DAY_MS);
  check('parseDuration 无后缀按【分钟】', parseDuration('5') === 5 * 60000);
  check('parseDuration 大小写不敏感', parseDuration(' 3H ') === 3 * 3600000);
  check('parseDuration 非法 / 0 返回 null', parseDuration('abc') === null && parseDuration('0m') === null && parseDuration('') === null);

  const ladder = parseLadder(['1m', 'oops', '3d']);
  check('parseLadder 长度恒等于默认长度（level 语义稳定）',
    ladder.length === DEFAULT_LADDER_TEXT.length);
  check('parseLadder 逐项生效：第 1 项 = 1 分钟', ladder[0] === 60000);
  check('parseLadder 单项写错 → 该项回退默认值（不整体崩）',
    ladder[1] === parseDuration(DEFAULT_LADDER_TEXT[1]));
  check('parseLadder 第 3 项生效', ladder[2] === 3 * DAY_MS);
  check('parseLadder 缺项 → 用默认值',
    parseLadder(['1m'])[DEFAULT_LADDER_TEXT.length - 1] ===
      parseDuration(DEFAULT_LADDER_TEXT[DEFAULT_LADDER_TEXT.length - 1]));
  check('parseLadder 超长 → 截断', parseLadder(new Array(20).fill('1m')).length === DEFAULT_LADDER_TEXT.length);
  check('parseLadder 非数组 → 全默认',
    JSON.stringify(parseLadder('nope')) === JSON.stringify(DEFAULT_LADDER_TEXT.map((x) => parseDuration(x))));

  const c = normalizeConfig({ roundSize: -5, maxRequeue: 99, newWordsPerDay: 'x' });
  check('normalizeConfig 越界/非法一律回退到安全值',
    c.roundSize === 1 && c.maxRequeue === 5 && c.newWordsPerDay >= 0);
}

/* ---------------- 2. 组池与组队列 ---------------- */

function testPool(): void {
  const src = [
    fav('f1', 'Apple'),
    { ...fav('f2', 'Banana'), type: 'phrase' },
    { ...fav('f3', 'Cherry'), translation: '', pending: true, context: { sentenceText: '' } },
    fav('f4', 'apple'), // 与 f1 同词形（大小写不同）→ 去重
    { ...fav('f5', 'Durian'), translation: '', pending: true }, // 无释义但有例句 → 保留
  ];
  const pool = selectPool(src as any);
  const keys = pool.map((x) => x.key);
  check('selectPool 只留 word（短语/整句不复习）', !keys.includes('banana'));
  check('selectPool 排除「既无释义又无例句」的词', !keys.includes('cherry'));
  check('selectPool 词形去重（Apple / apple 只算一个）', keys.filter((k) => k === 'apple').length === 1);
  check('selectPool 无释义但有例句 → 仍可复习', keys.includes('durian'));

  check('reviewKey 去空白 + 转小写', reviewKey('  Apple  ') === 'apple');
}

function testQueue(): void {
  const now = 1_700_000_000_000;
  const pool: ReviewCandidate[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((w, i) => ({
    key: w,
    favId: 'f' + w,
    text: w,
    createdAt: 1000 + i,
  }));
  const states: Record<string, ReviewState> = {
    // a/b/c/d 已排期且到期；e/f/g 是新词
    a: st({ dueAt: now - 4000 }),
    b: st({ dueAt: now - 3000 }),
    c: st({ dueAt: now - 2000 }),
    d: st({ dueAt: now - 1000 }),
  };

  const r0 = buildRound0(pool, states, CFG, now, 0, () => 0);
  check('buildRound0 总数不超过 roundSize', r0.items.length === CFG.roundSize, '得到 ' + r0.items.length);
  check('buildRound0 按额度引入新词（配额 2）', r0.newWords === 2);
  check('buildRound0 新词 + 到期卡混合出现',
    r0.items.some((x) => !states[x.key]) && r0.items.some((x) => states[x.key]));

  const used = buildRound0(pool, states, CFG, now, 2, () => 0);
  check('buildRound0 今日额度用尽 → 只出到期卡', used.newWords === 0);
  check('buildRound0 到期卡补足剩余名额', used.items.length === CFG.roundSize);

  // 到期卡不足时不该硬凑
  const few: Record<string, ReviewState> = { a: st({ dueAt: now - 1 }) };
  const r2 = buildRound0(pool, few, { ...CFG, newWordsPerDay: 0 }, now, 0, () => 0);
  check('buildRound0 池子不够时不重复填同一张卡',
    r2.items.length === 1 && r2.items[0].key === 'a');

  // 未到期的卡不出现
  const future: Record<string, ReviewState> = { a: st({ dueAt: now + DAY_MS }) };
  const r3 = buildRound0(pool, future, { ...CFG, newWordsPerDay: 0 }, now, 0, () => 0);
  check('buildRound0 未到期的不出现', r3.items.length === 0);

  // 已掌握的不出现（即使是到期时间已过）
  const mastered: Record<string, ReviewState> = { a: st({ dueAt: now - DAY_MS, mastered: true }) };
  const r4 = buildRound0(pool, mastered, { ...CFG, newWordsPerDay: 0 }, now, 0, () => 0);
  check('buildRound0 已掌握的词退出队列', r4.items.length === 0);

  // 「再来 N 张」：排除已出现过的、排除已掌握的
  const extra = buildExtra(pool, states, new Set(['a', 'b', 'c']), 5);
  check('buildExtra 排除本场已出现过的卡', !extra.some((x) => ['a', 'b', 'c'].includes(x.key)));
  check('buildExtra 最多取 count 张', extra.length <= 5);

  // ★ 回归防线：从没复习过的词不能算「提前复习」——
  //   放它们进来会绕过每日新词额度（连点「再来 5 个」就能无限引入新词）
  const extra2 = buildExtra(pool, states, new Set(), 5);
  check('buildExtra 只给已排期的词，绝不给从未复习过的新词',
    extra2.length > 0 && extra2.every((x) => !!states[x.key]),
    '拿到 ' + JSON.stringify(extra2.map((x) => x.key)));
  check('buildExtra 优先给最接近到期的词', extra2[0]?.key === 'a');

  const allMastered: Record<string, ReviewState> = {};
  for (const c of pool) allMastered[c.key] = st({ mastered: true, dueAt: now });
  check('buildExtra 已掌握的全部排除', buildExtra(pool, allMastered, new Set(), 5).length === 0);

  // 池子里全是新词（一个都没引入过）→ 没东西可"提前复习"
  check('buildExtra 全是新词时返回空（交给每日额度，而不是绕过它）',
    buildExtra(pool, {}, new Set(), 5).length === 0);

  // shuffle 不应丢项/增项
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  const sh = shuffle(arr, () => 0.5);
  check('shuffle 不丢项不增项', sh.length === arr.length && sh.slice().sort().join() === arr.slice().sort().join());
  check('shuffle 不改原数组', arr.join() === '1,2,3,4,5,6,7,8');
}

/* ---------------- 3. 评分 → 进度 ---------------- */

function testGrade(): void {
  check('gradeRequeue 认识 → 0', gradeRequeue('know', 0, CFG) === 0);
  check('gradeRequeue 模糊（首次露面）→ 1', gradeRequeue('fuzzy', 0, CFG) === 1);
  check('gradeRequeue 模糊（重排轮中再评模糊）→ 0（不追加）', gradeRequeue('fuzzy', 1, CFG) === 0);
  check('gradeRequeue 不认识（首次）→ maxRequeue', gradeRequeue('unknown', 0, CFG) === 2);
  check('gradeRequeue 不认识（已重排 1 次）→ 还剩 1 次', gradeRequeue('unknown', 1, CFG) === 1);
  check('gradeRequeue 不认识（已重排 2 次）→ 额度用尽', gradeRequeue('unknown', 2, CFG) === 0);
}

function testSchedule(): void {
  const now = 1_700_000_000_000;
  const cfg = CFG;
  const lastLevel = cfg.ladder.length - 1;

  const s1 = schedule(undefined, 'know', 0, cfg, now);
  // ★ 阶梯第 1 档必须真的生效（历史 bug：用 ladder[level+1] 排期，
  //   导致 ladder[0] 从头到尾没人读，成了改也不生效的死配置）
  check('首次评分（认识）→ level 1，dueAt = 阶梯[0]（第 1 档是活的）',
    s1.level === 1 && s1.dueAt === now + cfg.ladder[0]);
  check('首次评分 → firstAt / lastAt / reviews 都记上',
    s1.firstAt === now && s1.lastAt === now && s1.reviews === 1);

  const s2 = schedule(s1, 'know', 0, cfg, now);
  check('再答对 → level 2，dueAt = 阶梯[1]', s2.level === 2 && s2.dueAt === now + cfg.ladder[1]);
  check('reviews 累加、firstAt 不被覆盖', s2.reviews === 2 && s2.firstAt === now);

  const s3 = schedule(s1, 'fuzzy', 0, cfg, now);
  check('模糊 → level 不变，dueAt = 明天', s3.level === 1 && s3.dueAt === now + DAY_MS);

  // ★ 回归防线：评「不认识」绝不能留下 dueAt <= now 的卡。
  //   那会让首页的「待复习 N 个」永远归不了零、今日任务永远显示没做完
  //   （2026-10-16 实测反馈：一直点不认识 → 一直显示「待复习 1 个」）
  const s4 = schedule(s1, 'unknown', 0, cfg, now);
  check('不认识 → level 归 0', s4.level === 0);
  check('不认识 → 明天再来（不能是「立刻到期」，否则今日任务永远做不完）',
    s4.dueAt === now + DAY_MS);

  // ★ 关键取舍：重排轮里的「认识」不升档
  const s5 = schedule(s1, 'know', 1, cfg, now);
  check('重排轮才答对 → level 不变（短时记忆不算掌握）', s5.level === 1);
  check('重排轮才答对 → dueAt = 明天（也不是立刻）', s5.dueAt === now + DAY_MS);

  // 顶档再答对 → 已掌握
  const top = schedule(st({ level: lastLevel, dueAt: now }), 'know', 0, cfg, now);
  check('顶档（30d）再答对 → mastered 退出池', top.mastered === true && top.level === lastLevel);
  check('已掌握后重新到期时间仍是顶档间隔', top.dueAt === now + cfg.ladder[lastLevel]);

  // 已掌握的词再评不认识 → 拉回池
  const back = schedule(st({ level: lastLevel, mastered: true }), 'unknown', 0, cfg, now);
  check('已掌握的词评「不认识」→ 回到 level 0 并重新进池',
    back.mastered === false && back.level === 0);

  // 把整条阶梯从零走一遍：确认每一档都真的生效、且顶档答对才判已掌握
  let cur: ReviewState | undefined = undefined;
  const usedIdx = new Set<number>();
  let masteredAt = -1;
  for (let i = 1; i <= cfg.ladder.length + 2; i++) {
    const before = cur ? cur.level : 0;
    usedIdx.add(Math.min(lastLevel, before));
    const nxt = schedule(cur, 'know', 0, cfg, now);
    if (nxt.mastered) {
      masteredAt = i;
      break;
    }
    cur = nxt;
  }
  check('整条阶梯每一档都被用到（没有改也不生效的死配置）',
    usedIdx.size === cfg.ladder.length,
    '用到 ' + usedIdx.size + ' / ' + cfg.ladder.length);
  check('连续答对 ' + cfg.ladder.length + ' 次即判定已掌握',
    masteredAt === cfg.ladder.length,
    '实际第 ' + masteredAt + ' 次');

  // level 越界（用户把阶梯改短/数据被手改）不能抛错
  const weird = schedule(st({ level: 99 }), 'know', 0, cfg, now);
  check('level 越界时封顶而不是崩', weird.mastered === true && weird.level === lastLevel);
}

/* ---------------- 4. 存储 ---------------- */

function testStore(): void {
  const root = tmpRoot('store');
  try {
    const s = new ReviewStore(root);
    const now = 1_700_000_000_000;

    check('新建 store：空进度', Object.keys(s.all()).length === 0);
    check('新建 store：无任何进度时 get 返回 undefined', s.get('nope') === undefined);

    s.set('apple', st({ level: 2, dueAt: now - 1, lastAt: now, firstAt: now, reviews: 3 }));
    check('set / get 往返', s.get('apple')?.level === 2 && s.get('apple')?.reviews === 3);

    s.set('banana', st({ level: 5, dueAt: now - 1, mastered: true, reviews: 7 }));
    s.set('cherry', st({ level: 0, dueAt: now + 10 * DAY_MS }));
    check('多条进度互不干扰',
      Object.keys(s.all()).length === 3 && s.get('cherry')?.level === 0);

    // 落盘位置：必须落在 stats/ 下（与错题同目录，跟随 materialsDir）
    check('进度文件落在 stats/review.json',
      fs.existsSync(path.join(root, STATS_DIR, REVIEW_FILE)));
    check('isUserDataEntry 保护整个 stats 目录（清缓存不会删进度）',
      isUserDataEntry(STATS_DIR) === true);

    // 跨日额度
    s.addDaily(3, now);
    check('今日额度累加', s.dailyUsed(now) === 3);
    s.addDaily(2, now);
    check('今日额度再累加', s.dailyUsed(now) === 5);
    check('跨自然日额度归零（不改写文件）', s.dailyUsed(now + DAY_MS) === 0);
    s.addDaily(1, now + DAY_MS); // 跨日写入 → 应重置为新的一天
    check('跨日首次写入从 0 开始', s.dailyUsed(now + DAY_MS) === 1);
    check('dateKey 按本地日期', dateKey(now) === dateKey(now) && dateKey(now).indexOf('-') > 0);

    // 重新加入复习
    s.restart('banana', now);
    const b = s.get('banana');
    check('restart：mastered 清掉、level 归 0、立刻到期',
      b?.mastered === false && b?.level === 0 && b?.dueAt === now);
    check('restart 保留历史复习次数（只重新排期，不抹掉历史）', b?.reviews === 7);

    // 坏文件兜底
    fs.writeFileSync(path.join(root, STATS_DIR, REVIEW_FILE), '{ this is not json', 'utf8');
    check('文件损坏 → 视为空进度，绝不抛错', Object.keys(s.all()).length === 0);
    s.set('ok', st({ level: 1 }));
    check('坏文件之后仍能正常写入', s.get('ok')?.level === 1);

    // 结构错位（items 是数组 / 字段类型不对）也不该崩
    fs.writeFileSync(path.join(root, STATS_DIR, REVIEW_FILE),
      JSON.stringify({ items: [1, 2, 3], daily: 'nope' }), 'utf8');
    check('items 非法结构 → 空进度', Object.keys(s.all()).length === 0);
    fs.writeFileSync(path.join(root, STATS_DIR, REVIEW_FILE),
      JSON.stringify({ items: { x: { level: 'NaN', dueAt: null } } }), 'utf8');
    const x = s.get('x');
    check('单条字段非法 → 逐字段兜底成安全值',
      !!x && x.level === 0 && x.dueAt === 0 && x.mastered === false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testMigrate(): void {
  const from = tmpRoot('from');
  const to = tmpRoot('to');
  try {
    fs.mkdirSync(path.join(from, STATS_DIR), { recursive: true });
    fs.writeFileSync(path.join(from, STATS_DIR, REVIEW_FILE), '{"version":1,"items":{}}', 'utf8');
    const r = migrateUserData(from, to);
    check('换 materialsDir 时复习进度跟着迁移',
      fs.existsSync(path.join(to, STATS_DIR, REVIEW_FILE)));
    check('迁移计数正确', r.moved >= 1, 'moved=' + r.moved);
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
}

function main(): void {
  console.log('=== 复习（间隔重复）测试 ===\n');
  testParse();
  testPool();
  testQueue();
  testGrade();
  testSchedule();
  testStore();
  testMigrate();
  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) process.exit(1);
}

main();
