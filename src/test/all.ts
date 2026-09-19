// 跑全部测试套件并汇总
const { execFileSync } = require('child_process');
const path = require('path');

const NODE = process.execPath;
const suites = [
  ['runTests', '主测试（diff / tokenize / 报告）'],
  ['testWebviewHtml', 'webview HTML 生成器自检'],
  ['testCacheGuard', '缓存自检逻辑'],
  ['testMp4', 'MP4 封装器'],
];

let totalPass = 0, totalFail = 0, allOk = true;

for (const [file, label] of suites) {
  // 注意：本文件编译后位于 out/test/，与各套件同级，
  // 所以直接用 __dirname 拼文件名即可（不要再加 out/test）。
  const p = path.join(__dirname, file + '.js');
  console.log('\n' + '='.repeat(64));
  console.log('### ' + label + '  (' + file + '.js)');
  console.log('='.repeat(64));
  try {
    const out = execFileSync(NODE, [p], { encoding: 'utf8' });
    process.stdout.write(out);
    const m = out.match(/结果:\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
    if (m) { totalPass += Number(m[1]); totalFail += Number(m[2]); }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    const m = (err.stdout || '').match(/结果:\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
    if (m) { totalPass += Number(m[1]); totalFail += Number(m[2]); }
    allOk = false;
  }
}

console.log('\n' + '='.repeat(64));
console.log('### 汇总');
console.log('='.repeat(64));
for (const [file, label] of suites) console.log('  ' + label);
console.log('');
console.log('总计: ' + totalPass + ' 通过 / ' + totalFail + ' 失败');
process.exit(totalFail === 0 && allOk ? 0 : 1);
