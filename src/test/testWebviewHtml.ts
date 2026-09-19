/**
 * Webview HTML 生成器自检
 *
 * 背景：webview 的 HTML 是「TypeScript 模板字符串里的 JS 源码」，
 * 一旦漏了转义就会生成语法错误的页面 —— 而且失败方式极其误导：
 *   - 整个 <script> 挂掉 → 所有按钮失效（「点了没反应」）
 *   - CSP 配错 → 样式全丢（「样式都没了」）
 *
 * 这两类问题在 TS 编译期都【不会】报错，只能在运行时暴露。
 * 所以这里做静态自检，把它们拦在编译阶段。
 */

import * as fs from 'fs';
import * as path from 'path';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? '  ← ' + detail : ''}`);
  }
}

const panelPath = path.join(__dirname, '../../src/webview/panel.ts');
const sidebarPath = path.join(__dirname, '../../src/webview/sidebar.ts');

const panel = fs.readFileSync(panelPath, 'utf8');
const sidebar = fs.readFileSync(sidebarPath, 'utf8');

console.log('=== webview HTML 生成器自检 ===\n');

/**
 * 提取 renderHtml() 返回的模板字符串正文。
 *
 * 做法：从 `private renderHtml(` 找到第一个 `return \`<!DOCTYPE html>`，
 * 到结尾的 `\`;`。返回的是「源码里的原文」（转义序列尚未展开）。
 */
function extractTemplate(src: string): string | null {
  const startMarker = 'return `<!DOCTYPE html>';
  const s = src.indexOf(startMarker);
  if (s < 0) return null;
  const bodyStart = s + 'return `'.length;

  // 模板字符串结束：`</html>` 后面的那个反引号
  const rest = src.slice(bodyStart);
  const endIdx = rest.indexOf('`;');
  if (endIdx < 0) return null;
  return rest.slice(0, endIdx);
}

/**
 * 检测模板字符串里「会产生运行时语法错误」的转义。
 *
 * 关键判据：模板字符串里写 `\n`（单反斜杠）→ 展开后是【真换行】。
 * 如果这个真换行落在一个 JS 字符串字面量 '...' 或 "..." 中间，
 * 生成的 JS 就会出现未闭合字符串 → SyntaxError → 整个脚本失效。
 *
 * 这里只看「单引号/双引号字符串内部是否出现了裸 \n 转义」，
 * 因为那才是致命场景；模板里正常的换行排版不受影响。
 */
function findFatalEscapes(tpl: string): Array<{ line: number; text: string; seq: string }> {
  const bad: Array<{ line: number; text: string; seq: string }> = [];
  const lines = tpl.split('\n');

  lines.forEach((line, idx) => {
    // 找本行内所有 '...' / "..." 字符串字面量
    const re = /(['"])((?:[^'"\\]|\\.)*)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const inner = m[2];
      // 找出其中「单反斜杠 + 转义字符」（不是 \\ 开头的）
      const escRe = /(^|[^\\])\\([nrtvfb0-9dwsux])/g;
      let e: RegExpExecArray | null;
      while ((e = escRe.exec(inner)) !== null) {
        bad.push({ line: idx + 1, text: line.trim(), seq: e[2] });
      }
    }
  });

  return bad;
}

const panelTpl = extractTemplate(panel);
check('panel.ts: 能定位 renderHtml 模板字符串', !!panelTpl);

if (panelTpl) {
  const fatal = findFatalEscapes(panelTpl);
  check(
    'panel.ts: 模板内字符串字面量无未双重转义的 \\n 等（否则生成 JS 会 SyntaxError）',
    fatal.length === 0,
    fatal.map((f) => `行${f.line}[\\${f.seq}] ${f.text.slice(0, 50)}`).join(' | ')
  );

  // 反向自检：故意构造坏样本 / 好样本，确认检测器真的能区分。
  // 注意：样本必须用 String.fromCharCode 拼出来，否则在本文件里
  // 就已经被 TS 解析成真实字符，检测器根本看不到转义序列。
  const BS = String.fromCharCode(92); // 反斜杠
  const probeBad = `  el.textContent = lines.join('${BS}n');`;        // 单反斜杠 n → 坏
  const probeGood = `  el.textContent = lines.join('${BS}${BS}n');`;  // 双反斜杠 n → 好
  const caughtBad = findFatalEscapes(probeBad).length > 0;
  const allowsGood = findFatalEscapes(probeGood).length === 0;
  check('自检器有效性：能抓到坏样本 join(单反斜杠 n)', caughtBad);
  check('自检器有效性：不误报好样本 join(双反斜杠 n)', allowsGood);
}

/* ---------- CSP 与内联样式的一致性 ---------- */

function cspOf(src: string): string {
  const m = src.match(/const csp = \[([\s\S]*?)\]\.join\('; '\)/);
  return m ? m[1] : '';
}

function countInlineStyles(src: string): number {
  const tpl = extractTemplate(src);
  return tpl ? (tpl.match(/style="/g) || []).length : 0;
}

const panelCsp = cspOf(panel);
const panelInline = countInlineStyles(panel);
const panelHasNonceInCsp = /'nonce-\$\{nonce\}'/.test(panelCsp);
const panelHasUnsafeInline = /unsafe-inline/.test(panelCsp);

// CSP 规范：source list 里出现 nonce 时，'unsafe-inline' 被完全忽略。
// 所以「有内联样式」+「CSP 带 nonce」= 内联样式必然被拦。
check(
  'panel.ts: 有内联样式时 CSP 不应带 nonce（nonce 会让 unsafe-inline 失效）',
  !(panelInline > 0 && panelHasNonceInCsp),
  panelInline > 0 && panelHasNonceInCsp
    ? `有 ${panelInline} 处内联样式但 CSP 含 nonce → 内联样式会被 CSP 拦截`
    : undefined
);

check(
  'panel.ts: 有内联样式时必须放行 unsafe-inline',
  panelInline === 0 || panelHasUnsafeInline,
  panelInline > 0 && !panelHasUnsafeInline ? `${panelInline} 处内联样式但无 unsafe-inline` : undefined
);

check(
  'panel.ts: <style> / <script> 标签不应带 nonce（与 CSP 保持一致）',
  !/<style nonce=/.test(panel) && !/<script nonce=/.test(panel)
);

check(
  'panel.ts: style-src / script-src 必须放行 cspSource（否则 VS Code 注入样式被挡）',
  /style-src \$\{this\.webview\.cspSource\}/.test(panel) &&
    /script-src \$\{this\.webview\.cspSource\}/.test(panel)
);

check(
  'panel.ts: media-src 必须放行 blob:（音频降级链的前提）',
  /media-src[^\n]*blob:/.test(panel)
);

/* ---------- sidebar 一致性（它以纯 nonce 模式工作，前提是没有内联样式） ---------- */

const sidebarCsp = cspOf(sidebar);
const sidebarAnyInline = ((sidebar.match(/style="/g) || []).length);

check(
  'sidebar.ts: 使用纯 nonce 模式的前提是没有内联样式',
  !/'nonce-\$\{nonce\}'/.test(sidebarCsp) || sidebarAnyInline === 0,
  `sidebar 含 ${sidebarAnyInline} 处 style=" 但 CSP 用 nonce（会失效）`
);

/* ---------- 关键元素与容器 ---------- */

check('panel.ts: 含 <audio id="player">', /<audio id="player"/.test(panel));
check('panel.ts: 含 url 输入框与 load 按钮', /id="url"/.test(panel) && /id="load"/.test(panel));
check('panel.ts: 含 diagContent 诊断容器', /id="diagContent"/.test(panel));
check('panel.ts: 绑定了 load 按钮点击', /getElementById\('load'\)\.onclick/.test(panel));
check('panel.ts: 绑定了 report 按钮点击', /getElementById\('report'\)\.onclick/.test(panel));
check('panel.ts: 含 audio error 监听', /player\.addEventListener\('error'/.test(panel));
check('panel.ts: play() 错误未被吞掉', /player\.play\(\)[\s\S]{0,120}\.catch\(/.test(panel));

/* ---------- 回归防护：本会话踩过的具体坑 ---------- */

// 坑：用 player.src !== src 判断是否需要重新 load。
// player.src 是浏览器绝对化后的值，自定义协议（vscode-webview://）规范化后
// 可能与传入值不相等 -> 无谓地重新 load -> 元数据被丢弃 -> currentTime 被忽略。
// 注意：要排除注释行，否则连「不要这么写」的告诫注释都会被误报。
const panelCode = panel
  .split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
check(
  'panel.ts: 不用 player.src !== src 判断重载（应该用 currentSrc / readyState）',
  !/player\.src\s*!==\s*src/.test(panelCode),
  '发现 player.src !== src 写法，会导致自定义协议下重复 load'
);

// 坑：seek 前不检查 seekable 是否就绪，赋值会被静默忽略。
check(
  'panel.ts: seek 前检查 seekable 长度',
  /player\.seekable/.test(panel) && /sk\.length/.test(panel),
  '未检查 player.seekable 长度，seek 可能被静默忽略'
);

// 坑：页面日志不回传宿主 -> 用户报障时宿主侧什么都看不到。
check(
  'panel.ts: 页面日志有回传宿主的通道（type: log）',
  /type:\s*'log'/.test(panel) && /case 'log':/.test(panel),
  'webview 内的日志没有回传宿主，排查时不可见'
);

// 坑：asWebviewUri 产出的 vscode-cdn.net 地址可能被 401 拒绝，
// 必须有一条「宿主直读字节」的兜底路线。
check(
  'panel.ts: 有宿主直读字节的兜底路线（requestAudioBytes / audioBytes）',
  /requestAudioBytes/.test(panel) && /audioBytes/.test(panel) && /loadViaHostBytes/.test(panel),
  '缺少绕过 webview 资源协议的兜底路线'
);

// 坑：诊断器自己用 new Audio() 探测 -> Chromium 媒体并发限制 -> 全部超时，
// 得出「所有路线都失败」的假结论（本会话真实踩过）。
check(
  'panel.ts: 诊断器不复用 new Audio() 探测（应复用主 player）',
  !/new Audio\(\)/.test(panelCode),
  '发现 new Audio() 探测，会因媒体并发限制互相饿死'
);

/* ---------- 回归防护：容器（ADTS vs MP4）相关 ---------- */

// 坑：把 MP4 字节贴上 audio/aac 标签。
// 本会话的核心教训是「字节完全正确但容器不对 → 解不开」，
// MIME 必须跟随实际容器走，不能写死。
check(
  'panel.ts: MIME 不写死 audio/aac（应随容器变化）',
  /function audioMime\(\)/.test(panel) && !/type:\s*'audio\/aac'/.test(panelCode),
  '发现硬编码 type: audio/aac，容器换成 MP4 后会与实际字节不符'
);

check(
  'panel.ts: data URI 也使用动态 MIME',
  !/data:audio\/aac;base64/.test(panelCode),
  '可见 data:audio/aac 硬编码，应与 audioMime() 保持一致'
);

// 坑：缓存校验用 ADTS 校验器去检查 MP4 文件 ->
// 所有正常缓存都被判为损坏 -> 每次打开都重新下载，且日志像是文件坏了。
check(
  'panel.ts: 缓存校验不对 MP4 用 ADTS 校验器',
  !/quickValidateAac\s*\(/.test(panelCode),
  '仍对 MP4 缓存调用 quickValidateAac，会把正常缓存判为损坏'
);

// 宿主直传字节时要能识别容器，否则页面侧无从判断（也不利于定位旧缓存）。
check(
  'panel.ts: 宿主传字节时自检容器（ADTS/MP4 都报告）',
  /MP4\(ftyp\)|isMp4/.test(panel),
  '缺少容器自检，旧版裸 ADTS 缓存会被误当作正常数据传给页面'
);

// ★★ 缓存校验必须用结构化判据（inspectMp4），不能只查 box 是否存在。
//
// 真实事故：mp4a 多写 4 字节 → esds 从 +36 被挤到 +40 → 解析器读到
// size=0 的假 box → 播放报 NO_SUPPORTED_STREAMS。而当时的校验只查
// 「ftyp/moov/mdat 存在不存在」—— 坏文件这三个也都有，于是被判为合格
// 并反复复用，表现为「代码明明修了但播放依旧失败」。
//
// 同一判据必须单一来源（core/transcode.ts 的 isValidMp3），否则两处实现会漂移。
//
// v5 起最终产物是 MP3（裸流），判据从 inspectMp4 换成 isValidMp3 ——
// 但「单一来源」这个要求不变：两份各写一份校验器，迟早会漂移成
// 「坏缓存被判为合格并反复复用」。
check(
  'panel.ts: 缓存校验走共享的 isValidMp3',
  /isValidMp3\s*\(/.test(panelCode),
  '缓存校验未用共享的 isValidMp3'
);
check(
  'panel.ts: 不再保留本地 MP4/MP3 校验实现',
  !/function isValidMp4File/.test(panelCode) && !/function isValidMp3/.test(panelCode),
  '仍有本地校验器 —— 判据会与共享实现漂移'
);

// ted.ts 的缓存闸门同理
const tedCode = fs
  .readFileSync(path.join(__dirname, '../../src/sources/ted.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
check(
  'ted.ts: 缓存校验走共享的 isValidMp3',
  /isValidMp3\s*\(/.test(tedCode),
  'ted.ts 缓存闸门未用共享的 isValidMp3'
);
check(
  'ted.ts: 不再保留本地 MP4/MP3 校验实现',
  !/function isValidMp4\b/.test(tedCode) && !/function isValidMp3\b/.test(tedCode),
  'ted.ts 仍有本地校验器'
);

// 坑：诊断报告里不写播放器能力与容器结论，
// 用户贴回来的报告看不出「VS Code 与 Chrome 的 ffmpeg 不同」这件事。
check(
  'panel.ts: 诊断报告包含容器判定与播放器能力',
  /canPlayType\(/.test(panel) && /容器判定/.test(panel),
  '诊断报告缺少容器/能力信息，难以一眼定位容器问题'
);

// 页面要能知道宿主给的容器格式（决定了挑哪个 MIME）。
check(
  'panel.ts: 宿主把 audioFormat 推给页面',
  /audioFormat/.test(panel),
  '页面拿不到容器格式，无法正确选 MIME'
);

// 旧写法：用 on* 属性赋值（onloadedmetadata = fn）在复用元素时会超时。
check(
  'panel.ts: 不为 player 用 on* 属性赋值',
  !/player\.onloadedmetadata\s*=/.test(panelCode) && !/player\.onerror\s*=/.test(panelCode),
  '发现 player.on* 属性赋值，复用元素时不可靠（应改用 addEventListener）'
);

/* ---------- 结果 ---------- */

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
