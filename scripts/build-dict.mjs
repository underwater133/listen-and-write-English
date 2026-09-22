/**
 * 构建 ECDICT 离线词典子集 → assets/dict.json.gz
 *
 * 用法：
 *   node scripts/build-dict.mjs [ecdict.csv 路径]
 *   （默认找 build/ecdict/ECDICT-master/ecdict.csv，即仓库 zip 解压后的位置；
 *     CSV 下载：https://codeload.github.com/skywind3000/ECDICT/zip/refs/heads/master）
 *
 * 选词标准（Q2 决策）：词频（COCA frq / BNC bnc）命中 或 考纲 tag 命中
 *   （zk 中考 / gk 高考 / cet4 / cet6 / ky 考研 / toefl / ielts / gre），
 *   按 frq 升序封顶 MAX_WORDS 条。TED 听写场景的词基本都在这个范围内。
 *
 * 输出（Q9 决策）：单个 gzip JSON，运行时惰性载入内存 Map：
 *   { v, count, words: { word: [phonetic, translation] }, lemma: { 变形: 原形 } }
 * lemma 由 exchange 字段反转生成（Q11：构建期做精确映射，运行时再叠加规则剥离兜底）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_WORDS = 150000;
const EXAM_TAGS = ['zk', 'gk', 'cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre'];

const csvPath =
  process.argv[2] || path.join(ROOT, 'build', 'ecdict', 'ECDICT-master', 'ecdict.csv');
if (!fs.existsSync(csvPath)) {
  console.error('找不到 ECDICT CSV：' + csvPath);
  console.error('先下载仓库 zip 并解压：');
  console.error('  curl -L https://codeload.github.com/skywind3000/ECDICT/zip/refs/heads/master -o build/ecdict-master.zip');
  console.error('  Expand-Archive build/ecdict-master.zip -DestinationPath build/ecdict');
  process.exit(1);
}

/** 流式解析 CSV（字段带引号、引号内可含逗号/换行） */
function* parseCsvRows(text) {
  let row = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(field); yield row; row = []; field = ''; }
    else field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); yield row; }
}

console.log('读取 ' + csvPath + ' …');
const text = fs.readFileSync(csvPath, 'utf8'); // ~63MB，构建脚本一次性读入没问题

const rows = parseCsvRows(text);
const header = rows.next().value;
const col = {};
header.forEach((h, i) => (col[h.trim()] = i));

/** word -> { frq, phonetic, translation }； lemma：变形 -> 原形（exchange 反转） */
const words = Object.create(null);
const lemma = Object.create(null);
let total = 0;

for (const row of rows) {
  const word = (row[col.word] || '').trim();
  if (!word) continue;
  total++;
  const frq = parseInt(row[col.frq] || '0', 10) || 0;
  const bnc = parseInt(row[col.bnc] || '0', 10) || 0;
  const tags = (row[col.tag] || '').toLowerCase();
  const isExam = EXAM_TAGS.some((t) => tags.includes(t));
  if (!(frq > 0 || bnc > 0 || isExam)) continue;

  const phonetic = (row[col.phonetic] || '').trim();
  // ECDICT 的 CSV 用字面 `\n`（反斜杠+n）表示释义内的换行，还原成真换行，
  // 否则 UI 里会把「\n」当正文显示、chip 也拆不开
  const translation = (row[col.translation] || '')
    .replace(/\\n/g, '\n')
    .trim();
  if (!translation) continue;
  words[word] = { frq: frq || 999999, phonetic, translation };

  // exchange 反转：'p:went,d:gone,…' → lemma['went'] = word（'0' 是原形本身，跳过）
  const exchange = (row[col.exchange] || '').trim();
  if (exchange) {
    for (const pair of exchange.split('/')) {
      const sep = pair.indexOf(':');
      if (sep <= 0) continue;
      const inflected = pair.slice(sep + 1).trim();
      if (inflected && inflected !== word && !lemma[inflected]) lemma[inflected] = word;
    }
  }
}

// 词频升序封顶（frq 越小越常用；无词频的排最后）
const kept = Object.keys(words)
  .sort((a, b) => words[a].frq - words[b].frq)
  .slice(0, MAX_WORDS);
const keptSet = new Set(kept);
const outWords = {};
for (const w of kept) {
  const it = words[w];
  outWords[w] = [it.phonetic, it.translation];
}

// lemma 只保留「原形也在词表里」的映射（变形词本身不必在词表）
const outLemma = {};
for (const [inf, base] of Object.entries(lemma)) {
  if (keptSet.has(base)) outLemma[inf] = base;
}

const payload = { v: 1, count: kept.length, words: outWords, lemma: outLemma };
const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });

const outDir = path.join(ROOT, 'assets');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'dict.json.gz');
fs.writeFileSync(outPath, gz);

console.log(
  '扫描词条 ' + total + '，入选 ' + kept.length +
  '，变形映射 ' + Object.keys(outLemma).length
);
console.log('输出 ' + outPath + '（' + (gz.length / 1024 / 1024).toFixed(1) + ' MB）');
