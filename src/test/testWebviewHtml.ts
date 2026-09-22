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
import * as vm from 'vm';

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
const timingPath = path.join(__dirname, '../../src/core/timing.ts');
const extPath = path.join(__dirname, '../../src/extension.ts');
const pkgPath = path.join(__dirname, '../../package.json');

const panel = fs.readFileSync(panelPath, 'utf8');
const sidebar = fs.readFileSync(sidebarPath, 'utf8');
const timingSrc = fs.readFileSync(timingPath, 'utf8');
const extSrc = fs.readFileSync(extPath, 'utf8');
const pkg = fs.readFileSync(pkgPath, 'utf8');

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

/* ---------- 生成物「能不能被解析」：整页报废类 bug 的唯一拦截点 ---------- */

/**
 * 把模板字符串按【运行时的方式】展开（转义序列真实生效）。
 * 模板里只有一处插值 ${csp}，传占位值即可。
 */
function expandTemplate(tpl: string): string | null {
  try {
    return new Function('csp', 'return `' + tpl + '`;')('CSP-PLACEHOLDER') as string;
  } catch {
    return null;
  }
}

/** 返回 JS 的语法错误信息；能解析则返回 null */
function syntaxErrorOf(js: string): string | null {
  try {
    new vm.Script(js, { filename: 'webview-inline.js' });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

if (panelTpl) {
  const html = expandTemplate(panelTpl);
  check('panel.ts: renderHtml 模板能展开成 HTML', !!html);

  const inline = html ? html.match(/<script>([\s\S]*?)<\/script>/) : null;
  check('panel.ts: 生成的页面里有内联 <script>', !!inline);

  if (inline) {
    const err = syntaxErrorOf(inline[1]);
    check(
      'panel.ts: 生成的 webview JS 能被解析（TS 语法 / 转义泄漏检测）',
      err === null,
      err === null ? undefined : err
    );
  }
}

// 反向自检：确认检测器真的能区分好坏样本。
//
// ★ 为什么必须做这一步：真实事故（2026-09-19）——
//   panel.ts 模板里写了一行 `{} as Record<string, boolean>`。
//   tsc 不对模板字符串内容做类型擦除，`as X` 原样进入页面 →
//   SyntaxError: Unexpected identifier 'as' → 整个 <script> 不执行 →
//   所有按钮（含「发现 TED」）点不动。而当时本文件 33 项自检【全绿】。
//   只检测 \n 转义是不够的：TS 专有语法同样会整页报废。
const probeTsLeak = 'var s = { multi: false, selected: {} as Record<string, boolean> };';
check('自检器有效性：能抓到 TS 语法泄漏（as X）', syntaxErrorOf(probeTsLeak) !== null);
check(
  '自检器有效性：不误报合法 JS',
  syntaxErrorOf('var s = { multi: false, selected: {} };') === null
);
// 反面样本 2：模板里写了单反斜杠 n → 展开后字符串被真实换行切断（README 第 13 节的坑）
const BS = String.fromCharCode(92);
const leakTpl = `var a = 'x${BS}n';`;
const leakedJs = expandTemplate(leakTpl);
check(
  '自检器有效性：能抓到模板里单反斜杠 n 造成的断串',
  leakedJs !== null && syntaxErrorOf(leakedJs) !== null
);

/* ---------- 被 webview 静默禁用的浏览器 API ---------- */

/**
 * ★ webview 里禁用 window.confirm / alert / prompt。
 *
 * 原因：VS Code 的 webview 是 sandboxed iframe，没有 allow-modals 标志。
 * 按规范，Chromium 对 sandboxed iframe 会【忽略】这些 modal 调用 ——
 * confirm() 直接返回 false（控制台只有一行 ignored 警告）。
 *
 * 真实事故（2026-09-19）：三处删除都写成
 *     if (!window.confirm('确定删除…？')) return;
 * 于是每次都提前 return，「删除 / 多选删除 / 全部删除」点了全部没反应，
 * 页面不报错、宿主也收不到消息 —— 又是最难查的那种静默失效。
 * 破坏性操作必须由宿主用 vscode.window.showWarningMessage({ modal: true }) 确认。
 */
function findModalCalls(src: string): string[] {
  // 注释里允许描述这个坑（只要不写出完整调用形式），所以先剥块注释
  const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noComment.match(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/g) ?? [];
}

if (panelTpl) {
  const modalCalls = findModalCalls(panelTpl);
  check(
    'panel.ts: webview 内不使用 confirm/alert/prompt（被 Chromium 忽略，恒返回 false）',
    modalCalls.length === 0,
    modalCalls.length ? `发现 ${modalCalls.length} 处：${modalCalls.join(', ')}` : undefined
  );

  // 反向自检：确认检测器真能区分（不能是个永远返回 ✅ 的假检测器）
  check(
    '自检器有效性：能抓到 window.confirm 调用',
    findModalCalls("if (!window.confirm('x')) return;").length === 1
  );
  check(
    '自检器有效性：不误报仅提及名字的注释',
    findModalCalls('/* 不要用 window.confirm 做确认 */').length === 0
  );
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

// ★ 页面级滚动必须锁死。
// 真实事故（2026-09-19）：body 用 100vh，与 webview 实际可视高度差几像素，
// 就会凭空多出一条【页面级】滚动条 —— 它与字幕列表无关，所以"收起列表后依然存在"，
// 极易被误认为是列表的滚动条。滚动只应发生在各视图内部（.list / .discover / .library）。
check(
  'panel.ts: 页面本身禁止滚动（html / body 都 overflow:hidden）',
  /html \{ overflow: hidden; \}/.test(panel) && /height: 100vh; overflow: hidden;/.test(panel),
  '页面级滚动没锁死 —— 100vh 与可视高度的微小差会造出一条消不掉的页面滚动条'
);
check(
  'panel.ts: 滚动条用 VS Code 样式（不要 Chromium 默认的粗黑条）',
  /::-webkit-scrollbar \{ width: 10px/.test(panel) &&
    /::-webkit-scrollbar-thumb \{ background: rgba\(121,121,121,\.4\)/.test(panel),
  '用的是浏览器默认滚动条，看起来像页面被撑破了'
);

// 顶部工具栏 4 个按钮在侧边栏宽度下放不下一行：必须换行，否则被裁掉半截
// （flex 默认 nowrap + 页面 overflow:hidden = 溢出的按钮直接消失）
check(
  'panel.ts: 顶部工具栏窄宽度下换行且按钮不被压缩',
  /\.topbar \{[^}]*flex-wrap: wrap/.test(panel) &&
    /\.topbar button \{ flex: 0 0 auto; \}/.test(panel),
  'topbar 仍是不换行的 flex，窄宽度下按钮会被裁掉'
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

/* ---------- 「发现 TED」显式下载 + 布局切换（2026-09-19 新增能力） ---------- */

// 点卡片不再直接下载：下载必须走『下载』按钮（否则又变成"点一下就下载"）
check(
  'panel.ts: 发现列表有「下载」按钮与 startDiscDownload',
  /class="disc-dl"/.test(panel) && /function startDiscDownload/.test(panel),
  '缺少显式下载入口'
);
check(
  'panel.ts: 发现列表会标注「已下载」徽标',
  /已下载<\/span>|已下载' \+|>已下载</.test(panel),
  '缺少已下载标注'
);
// 列表里下载时不能把页面切走：进度按 origin 分流
check(
  'panel.ts: 列表下载进度按 origin 分流（不切视图）',
  /msg\.origin === 'discover'/.test(panel),
  '缺少来源分流，列表下载会把页面切到练习视图'
);
check(
  'panel.ts: 展开简介走 talkInfo 通道（搜索接口不带简介）',
  /type: 'talkInfo'/.test(panel) && /case 'talkInfo'/.test(panel)
);

// 视图导航：**点哪个去哪个（幂等）**，不做「再点一次回练习」的 toggle。
// 真实事故（2026-09-19）：原来两个按钮都写成 toggle，连点两下「发现 TED」
// 就在列表与精听界面之间来回跳，用户反馈「界面跳来跳去、停不下来」。
check(
  'panel.ts: 顶部有 3 个导航按钮（发现 TED / 素材库 / 诊断报告）',
  /id="discoverBtn"/.test(panel) &&
    /id="libraryBtn"/.test(panel) &&
    /id="report"/.test(panel),
  '缺少导航按钮'
);
// 设计决策（2026-09-19）：导航栏刻意不放「练习」。
// 回精听界面只能从「素材库」点一篇素材（或发现列表里点已下载卡片的「练习」）——
// 这两个入口都会真的去加载素材，不会留下"空转的练习界面"。
check(
  'panel.ts: 导航栏不含「练习」按钮（进练习只能从素材库选素材）',
  !/id="practiceBtn"/.test(panel) && !/navBtn\.practice/.test(panel),
  '又加回了「练习」导航按钮'
);
check(
  'panel.ts: 导航按钮只切换、不做 toggle',
  /navBtn\.discover\.onclick/.test(panel) &&
    /navBtn\.library\.onclick/.test(panel) &&
    !/currentView === '(discover|library)'\) \{ showView\('practice'\)/.test(panel),
  '导航又写成 toggle 了：连点同一个按钮会在两个界面之间来回跳'
);
check(
  'panel.ts: 当前视图的导航按钮高亮（.topbar button.on）',
  /\.topbar button\.on \{/.test(panel) &&
    /classList\.toggle\('on', k === name\)/.test(panel),
  '没有高亮当前视图，用户看不出自己在哪个界面'
);
// 首屏也要有高亮：历史 bug —— 高亮只在 showView() 里更新，
// 而首屏从未调用它，刚打开时三个按钮全是灰的。
check(
  'panel.ts: 首屏就初始化当前视图高亮',
  /showView\(currentView\)/.test(panel),
  '首屏没有初始化高亮，刚打开时看不出自己在哪个界面'
);

/* ---------- 逐句时间轴微调（2026-09-19） ----------
 *
 * 背景：TED 的 VTT 是「粗对齐」，同一篇里各句误差不一致（有的准、有的偏几百
 * 毫秒），全局偏移量修不了 —— 只能让用户在听到对不上时就地微调那一句。
 *
 * 下面每条挂了都不是小事：
 *   - 修正必须单独落 timing.json，绝不回写 material.json ——
 *     原始时间轴是「复原」的唯一基准，而且 material.json 会被
 *     clampSentencesToAudio / 缓存重建等路径重写，混在一起会被冲掉。
 *   - 必须能复原本句与全部，否则改错了就回不去。
 *   - 改完要自动重播：判断依据只有耳朵，不即时回放等于闭着眼调。
 *   - 不做打点按钮、不做试听按钮（2026-09-19 明确：打点有人耳延迟必然不准；
 *     试听由「改完自动重播 + 已有的播放按钮」覆盖）。
 */
check(
  'panel.ts: 有逐句时间轴微调入口（timingHtml / #timingHead）',
  /function timingHtml/.test(panel) && /id="timingHead"/.test(panel),
  '缺少时间轴微调入口'
);
check(
  'panel.ts: 微调经 setTiming 通道落盘',
  /type: 'setTiming'/.test(panel) && /case 'setTiming'/.test(panel),
  '缺少保存通道'
);
check(
  'panel.ts: 提供复原本句 / 复原全部',
  /type: 'resetTiming'/.test(panel) &&
    /type: 'resetAllTiming'/.test(panel) &&
    /case 'resetTiming'/.test(panel) &&
    /case 'resetAllTiming'/.test(panel),
  '缺少复原通道：改错了就回不去'
);
check(
  'panel.ts: 调整后自动重播（带防抖，连点只播一次）',
  /function scheduleTimingPreview/.test(panel) &&
    /clearTimeout\(timingPreviewTimer\)/.test(panel),
  '调完不重播等于闭着眼调'
);
check(
  'panel.ts: 微调条不打点、不设试听按钮',
  !/class="t-set"/.test(panel) && !/id="tPlay"/.test(panel),
  '又加回了打点 / 试听按钮（已明确不要）'
);
check(
  'panel.ts: 加载素材时合并修正层（applyTimingOverrides）',
  /applyTimingOverrides\(/.test(panel),
  '没有应用修正层，改了也不会生效'
);
check(
  'panel.ts: 保存前校验时间轴（起止不倒挂 / 不越界）',
  /normalizeTiming/.test(panel) && /endMs - startMs < 100/.test(panel),
  '没有校验：越界值会让 seek 落空，表现为「点了播放没反应」'
);
check(
  '★ timing.ts: 不修改入参数组（原始时间轴只读，复原才有依据）',
  /return \{ \.\.\.s, startMs, endMs, timingEdited: true \}/.test(timingSrc),
  '若就地改写原始值，复原将不再可能'
);
check(
  'timing.ts: 坏 timing.json 退化为「无修正」而不是抛错',
  /catch \{[\s\S]{0,120}return \{\};/.test(timingSrc),
  '坏文件不能让素材打不开'
);
check(
  'timing.ts: 复原全部会删掉文件（不留空壳 timing.json）',
  /unlinkSync/.test(timingSrc),
  '「复原全部」应让素材目录回到干净状态'
);

// 布局切换
check('panel.ts: 顶部有布局切换按钮 #layoutBtn', /id="layoutBtn"/.test(panel));
check('panel.ts: 布局按钮有点击绑定', /layoutBtn\.onclick/.test(panel));
check(
  'panel.ts: 布局按钮只在精听界面显示',
  /function updateLayoutBtn/.test(panel) &&
    /currentView === 'practice' \? '' : 'none'/.test(panel),
  '布局按钮的显隐没有跟视图绑定'
);
check('panel.ts: 有上下布局样式 .main.stacked', /\.main\.stacked \{/.test(panel));
check(
  'panel.ts: 上下布局排序为 操作区(1) → 收起条(2) → 字幕列表(3)',
  /\.main\.stacked \.practice \{[^}]*order: 1/.test(panel) &&
    /\.main\.stacked \.list-toggle \{[^}]*order: 2/.test(panel) &&
    /\.main\.stacked \.list \{[^}]*order: 3/.test(panel),
  '上下布局的排列顺序不对（收起条要在字幕列表上方）'
);
check(
  'panel.ts: 上下布局的字幕列表不会撑破容器',
  /\.main\.stacked \{ flex-direction: column; overflow: hidden; \}/.test(panel) &&
    /\.main\.stacked \.list \{[^}]*flex: 1 1 auto; min-height: 0/.test(panel),
  '列表没限制在容器内，长字幕会把整页撑出滚动条'
);
check(
  'panel.ts: 上下布局操作栏按内容走、矮容器下可收缩滚动（不设 max-height）',
  /\.main\.stacked \.practice \{[^}]*flex: 0 1 auto/.test(panel) &&
    /\.main\.stacked \.practice \{[^}]*min-height: 0/.test(panel) &&
    !/\.main\.stacked \.practice \{[^}]*max-height/.test(panel),
  '操作栏空间不足时既不收缩也不滚动，内容会被裁掉且滚不到（2026-09-20 反馈）'
);
check(
  'panel.ts: 上下布局收起列表后操作栏同样可收缩滚动',
  /\.main\.stacked\.collapsed \.practice \{ flex: 0 1 auto; min-height: 0; \}/.test(panel),
  '收起后操作栏在矮容器下无法收缩，内容会被裁掉且滚不到'
);
check(
  'panel.ts: 练习区内部滚动且滚动条隐藏（滚轮可滚，不显示滚动条）',
  /\.practice \{[^}]*min-height: 0/.test(panel) &&
    /\.practice \{[^}]*overflow-y: auto/.test(panel) &&
    /\.practice \{[^}]*scrollbar-width: none/.test(panel) &&
    /\.practice::-webkit-scrollbar \{ display: none; \}/.test(panel),
  '练习区缺 min-height:0 会被裁掉且滚不动；滚动条未隐藏则不符合需求'
);

// ★ 分隔条拖拽（2026-09-20）：窄条既能拖也能点，比例要夹紧并持久化
check(
  'panel.ts: list-toggle 是拖拽手柄（col-resize / row-resize 光标）',
  /\.list-toggle \{[^}]*cursor: col-resize/.test(panel) &&
    /\.main\.stacked \.list-toggle \{[^}]*cursor: row-resize/.test(panel),
  '分隔条没有 resize 光标，用户发现不了可以拖'
);
check(
  'panel.ts: 拖拽比例夹紧在 0.2~0.8，双击可恢复默认',
  /function bindListResize/.test(panel) &&
    /Math\.min\(0\.8, Math\.max\(0\.2, /.test(panel) &&
    /state\.listRatio = null/.test(panel) &&
    /state\.stackedRatio = null/.test(panel),
  '拖拽占比没有夹紧，或没有恢复默认的入口'
);
check(
  'panel.ts: 拖拽出的占比会持久化',
  /listRatio: state\.listRatio/.test(panel) &&
    /stackedRatio: state\.stackedRatio/.test(panel) &&
    /typeof saved\.listRatio === 'number'/.test(panel),
  '拖拽占比没存进 setState/getState，重开面板就丢'
);

// ★ 当前句定位（2026-09-20）：scrollIntoView 会连带滚动 overflow:hidden 的
//   祖先（html/body/#root），整页被顶出可视区 —— 必须手动只滚 .list
check(
  'panel.ts: 当前句定位禁用 scrollIntoView（只手动滚 .list 自身）',
  !/scrollIntoView/.test(panel.replace(/\/\/[^\n]*/g, '')) && // 注释里提到名字不算使用
    /list\.scrollTop = Math\.max\(0, /.test(panel),
  '用了 scrollIntoView 会把 overflow:hidden 的祖先一起滚走，整页错位'
);
// ★ 播放按钮二态（2026-09-20）：连播模式下要有暂停/恢复
check(
  'panel.ts: 播放按钮二态（暂停 + 句内原地恢复）',
  /updatePlayBtn/.test(panel) &&
    /player\.addEventListener\('play', updatePlayBtn\)/.test(panel) &&
    /player\.addEventListener\('pause', updatePlayBtn\)/.test(panel) &&
    /if \(!player\.paused\) \{ player\.pause\(\); return; \}/.test(panel) &&
    /ms > s\.startMs && ms < s\.endMs/.test(panel) &&
    // 重建 DOM 时按实际状态渲染初始文案（播放中切句不会再触发 play 事件）
    /'<button id="play">' \+ \(player\.paused \? '▶ 播放' : '⏸ 暂停'\)/.test(panel),
  '播放按钮没有暂停/恢复逻辑，连播模式下只能改播放逻辑才能停下来'
);
check(
  'panel.ts: render 顺序为 renderPractice → applyListFlex → renderList（列表定位依赖最终高度）',
  /renderPractice\(\);\s*\n\s*applyListFlex\(\);\s*\n\s*renderList\(\);/.test(panel),
  '顺序错了会让当前句定位算在虚高的列表高度上（practice 未填充），当前句被挤到视口外'
);
check(
  'panel.ts: 连播切句不丢输入框焦点（重建前记住，重建后原样恢复）',
  /hadInputFocus/.test(panel) &&
    /if \(hadInputFocus\) ta\.focus\(\);/.test(panel) &&
    /setSelectionRange\(prevSel\[0\], prevSel\[1\]\)/.test(panel),
  '连播切句会整体重建 DOM，不恢复焦点的话用户点进输入框的焦点每句都会丢'
);
check(
  'panel.ts: 看答案面板显隐由 state.revealAnswer 驱动（切句/倍速/切模式不重置）',
  /revealAnswer: false/.test(panel) &&
    /id="answerBox" style="display:' \+/.test(panel) &&
    /state\.revealAnswer = !state\.revealAnswer/.test(panel),
  '答案面板显隐挂在会被 render() 重置的 DOM style 上，切句就消失'
);

/* ---------- 收藏（单词/短语/整句 + 百度翻译） ---------- */

const favSrc = fs.readFileSync(path.join(__dirname, '../../src/core/favorites.ts'), 'utf8');

check(
  'package.json: 有 listenAndWrite.baiduAppId / baiduSecret 配置',
  /listenAndWrite\.baiduAppId/.test(pkg) && /listenAndWrite\.baiduSecret/.test(pkg),
  '没有配置项用户就没法填百度翻译凭证'
);
check(
  'favorites.ts: 签名规则 MD5(appid+q+salt+secret) 且 QPS 间隔 ≥1100ms',
  /createHash\('md5'\)/.test(favSrc) &&
    /appId \+ q \+ salt \+ secret/.test(favSrc) &&
    /BAIDU_QPS_INTERVAL_MS = 1100/.test(favSrc),
  '签名或 QPS 间隔不符合百度翻译 API 规范'
);
check(
  'favorites.ts: FavoriteStore 支持去重收藏（同词条更新 context 不新增）',
  /toLowerCase\(\)/.test(favSrc) && /deduped: true/.test(favSrc),
  '重复收藏同一词条会产生脏数据'
);
check(
  'panel.ts(宿主): 收藏通道齐全 favAdd/favRemove/favListRequest/favRetry',
  /case 'favAdd'/.test(panel) && /case 'favRemove'/.test(panel) &&
    /case 'favListRequest'/.test(panel) && /case 'favRetry'/.test(panel),
  'webview 与宿主的收藏消息没接全'
);
check(
  'panel.ts(宿主): 整句译文以宿主素材为权威，单词/短语走队列翻译',
  /sentenceTranslation = this\.material\.sentences\[idx\]\.translation/.test(panel) &&
    /enqueueFavTranslation\(saved, false\)/.test(panel),
  '整句译文必须复用 TED 字幕（不调 API），单词/短语查询必须进串行队列'
);
check(
  'panel.ts(页面): 答案面板 token 化（.tok 可点选，data-tok 序号）',
  /class="tok' \+ \(sel\.indexOf\(wi\)/.test(panel) && /renderAnswerTokens/.test(panel),
  '答案没有 token 化，无法点选单词收藏'
);
check(
  'panel.ts(页面): 收藏视图存在（favBtn 导航 + favView 容器 + renderFavView）',
  /id="favBtn"/.test(panel) && /id="favView"/.test(panel) && /function renderFavView/.test(panel),
  '收藏视图没接进导航'
);
check(
  'panel.ts(页面): 未配置 API 显示提示条；有 pending 且已配置才显示「更新翻译」',
  /单词\/短语的译文需要百度翻译 API/.test(panel) &&
    /id="favRetry"/.test(panel) &&
    /pendingCount > 0/.test(panel),
  '未配置/中途配置 API 的显示状态没处理'
);
check(
  'panel.ts: 收藏视图跳回原句（openCached 带 sentenceIndex，pushMaterial 带 jumpTo）',
  /jumpTo: this\.pendingJumpTo/.test(panel) &&
    /dirName: f\.dirName/.test(panel) &&
    /sourceUrl: this\.material\.sourceUrl \|\| ''/.test(panel) &&
    /state\.currentIndex =\s*\n?\s*Number\.isFinite\(jt\)/.test(panel),
  '跳回原句的链路没接通（含 sourceUrl 下发与 dirName 动态解析），点击收藏卡片只会打开素材第一句'
);

/* ---------- 离线词典（ECDICT 子集） ---------- */

const dictSrc = fs.readFileSync(path.join(__dirname, '../../src/core/dictionary.ts'), 'utf8');

check(
  'dictionary.ts: 词典单例 + 惰性加载 + 失败静默降级（不抛错）',
  /function getDictionary/.test(dictSrc) &&
    /ensureLoaded/.test(dictSrc) &&
    /this\.broken = true/.test(dictSrc),
  '词典加载失败不能把宿主打挂，必须静默降级走百度'
);
check(
  'dictionary.ts: 词形还原三层（精确 → lemma 映射 → 规则剥离）',
  /this\.lemma\.get\(c\)/.test(dictSrc) && /function stripSuffixes/.test(dictSrc),
  'went→go 这类不规则变形必须靠 lemma 映射，规则剥离只是兜底'
);
check(
  'panel.ts(宿主): 查词管线词典优先（单词未命中才走百度）',
  /const entry = await this\.lookupDict\(text\);/.test(panel) &&
    /case 'favWordLookup'/.test(panel) &&
    /baiduTranslateBatch/.test(panel),
  '离线词典必须优先于百度 API'
);
check(
  'panel.ts(页面): 词条显示音标；短语可点词展开',
  /class="phonetic"/.test(panel) && /class="ptok"/.test(panel) &&
    /type: 'favWordLookup'/.test(panel) && /state\.favExpand/.test(panel),
  '音标/短语点词的展示与交互缺失'
);
check(
  '构建: 词典构建脚本与产物存在',
  fs.existsSync(path.join(__dirname, '../../scripts/build-dict.mjs')) &&
    fs.existsSync(path.join(__dirname, '../../assets/dict.json.gz')),
  '词典数据或构建脚本缺失，离线查词会全部走百度'
);
check(
  'panel.ts: 精听快捷键 a/d/空格/w/s（与按钮共用动作函数，输入框聚焦时不抢键）',
  /function (gotoPrev|gotoNext|togglePlayPause|cyclePlayMode|cycleRate)/.test(panel) &&
    /document\.addEventListener\('keydown'/.test(panel) &&
    /case ' ': e\.preventDefault\(\); togglePlayPause\(\); break;/.test(panel) &&
    /ae\.tagName === 'TEXTAREA' \|\| ae\.tagName === 'INPUT'/.test(panel),
  '快捷键没接上，或输入框聚焦时被抢键'
);
check(
  'panel.ts: 输入框不自动聚焦（避免吞掉快捷键）',
  !/ta\.focus\(\);\s*\n?\s*\} catch/.test(panel) === true &&
    !/state\.pendingFocusInput/.test(panel) &&
    /if \(hadInputFocus\) ta\.focus\(\);/.test(panel),
  '切句后自动聚焦输入框会把 a/d/空格 快捷键吞进输入框'
);
check(
  'panel.ts: 收藏整句二态切换，且有选区时隐藏收藏整句',
  /sentFav \? '✓ 已收藏整句（点击取消）' : '⭐ 收藏整句'/.test(panel) &&
    /!\s*selActive\s*\n?\s*\? '<button id="favSentence"/.test(panel) &&
    /type: 'favRemove', id: sentFav\.id/.test(panel),
  '收藏整句不是二态按钮，或选区与整句按钮同时出现'
);
check(
  'favorites.ts: 批量翻译按 \\n 分行合并为单请求，超限自动分块',
  /baiduTranslateBatch/.test(favSrc) &&
    /texts\.join\('\\n'\)/.test(favSrc) &&
    /bytes \+ b > 5000/.test(favSrc),
  '批量翻译没合并请求（N 条 N 个请求会浪费额度还慢）'
);
check(
  'panel.ts: 词条译文按 ； 拆成 chip 展示（整句不拆）',
  /\.split\(\/\[；;/.test(panel) && /class="chip"/.test(panel) && /f\.type === 'sentence'/.test(panel),
  '多义项挤在一个字符串里，看不出是几个释义'
);
check(
  'panel.ts: 点选单词后练习区滚动位置保持（root 重建【前】记录 scrollTop，同句才还原）',
  /const prevPracticeScroll = oldPractice \? oldPractice\.scrollTop : 0;/.test(panel) &&
    /const sameIndex = renderedIndex === state\.currentIndex;/.test(panel) &&
    /if \(newPractice && sameIndex\) newPractice\.scrollTop = prevPracticeScroll;/.test(panel),
  '滚动位置必须在 root.innerHTML 重建前记录（重建后取到的是新元素的 0）'
);
check(
  'panel.ts: 再点已选中的词取消选中，选空后回到初始状态',
  /state\.favSel = sel\.filter\(\(k\) => k !== wi\);/.test(panel) &&
    /if \(state\.favSel\.length === 0\) state\.favSelFor = -1;/.test(panel),
  '已选中的词点不掉'
);

// ★ 回归防线：「已下载」必须按 slug 对齐。
// 真实事故（2026-09-19）：搜索结果 hit.id 是 Algolia objectID（3292），
// 素材库 id 是 ted:<videoData.id>（66），按 id 对齐永远标不上「已下载」。
check(
  'panel.ts: 「已下载」按 slug 对齐（不能用 hit.id）',
  /discCachedDir\(h\.slug\)/.test(panel) &&
    /discState\.cached\[slug\]/.test(panel) &&
    !/discState\.cached\['ted:' \+/.test(panel),
  '又按 id 对齐了 —— 搜索结果与素材库的 id 不同源，标注会永久失效'
);
check(
  'panel.ts: 下载完成回调按 slug 定位卡片',
  /if \(msg\.slug\) discState\.cached\[msg\.slug\]/.test(panel),
  'tedDownloaded 没按 slug 更新，下载完列表不会变成已下载'
);
check(
  'panel.ts: 宿主的已下载清单带 slug',
  /filter\(\(i\) => i\.hasAudio && i\.slug\)/.test(panel) && /function slugFromUrl/.test(panel),
  '宿主没给 slug，页面无法与搜索结果对齐'
);
check(
  'panel.ts: 布局选择会持久化（setState/getState）',
  /vscode\.setState/.test(panel) && /vscode\.getState/.test(panel)
);

// ★ 诊断报告必须是独立视图，不能写进 #root（练习界面）。
// 真实事故（2026-09-19）：报告写进 #root 且不切视图 ——
//   在「发现 TED」/「素材库」里点诊断报告没有任何反应（内容进了隐藏容器），
//   而之后任何一次"切回练习"都会突然显示那份报告，
//   表现为「界面跳来跳去、跳到诊断报告去了」。
check(
  'panel.ts: 诊断报告是独立视图（不写进 #root）',
  /id="reportView"/.test(panel) &&
    /report: reportView/.test(panel) &&
    /reportView\.innerHTML/.test(panel) &&
    !/reportMode/.test(panel),
  '报告又写回 #root 了：会污染练习界面，切视图时莫名显示报告'
);

check('panel.ts: 含 <audio id="player">', /<audio id="player"/.test(panel));
check('panel.ts: 含 url 输入框与 load 按钮', /id="url"/.test(panel) && /id="load"/.test(panel));
check('panel.ts: 含 diagContent 诊断容器', /id="diagContent"/.test(panel));

/* ---------- 音频诊断按钮：改为开发者开关（2026-09-19） ----------
 * 音频链路打通后，🔧 不该再对普通用户暴露 —— 改由
 * listenAndWrite.showAudioDiagnostics 控制（默认关）。
 *
 * 锁这几点，缺一个都会退化：
 *   - 开关默认必须是 false（否则等于没隐藏）
 *   - 按钮与诊断面板都要真的受开关控制，不能无条件渲染
 *   - 绑定必须判空：开关关着时按钮不存在，getElementById 返回 null
 *   - 改设置要即时生效（宿主在配置变更时推送），不必重载窗口
 *   - 播放失败提示不能指向一个不存在的 🔧 按钮
 */
check(
  'package.json: 有 listenAndWrite.showAudioDiagnostics（默认 false）',
  /"listenAndWrite\.showAudioDiagnostics"/.test(pkg) &&
    /"listenAndWrite\.showAudioDiagnostics"[\s\S]{0,220}?"default":\s*false/.test(pkg),
  '缺少开发者开关，或默认值不是 false —— 普通用户仍会看到 🔧'
);
check(
  'panel.ts: 🔧 按钮与诊断面板都受 showAudioDiag 控制',
  /state\.showAudioDiag/.test(panel) &&
    !/'<button id="diag" class="ghost" title="诊断音频加载">🔧<\/button>' \+/.test(panel),
  '诊断按钮被无条件渲染了'
);
check(
  'panel.ts: 诊断按钮的绑定判空（开关关着时按钮不存在）',
  /const diagBtn = document\.getElementById\('diag'\)/.test(panel) &&
    /if \(diagBtn\) \{/.test(panel),
  '开关关闭时绑定会抛 TypeError（getElementById 返回 null）'
);
check(
  'panel.ts + extension.ts: 开关经 config 消息下发（ready 时 + 配置变更时）',
  /type: 'config'/.test(panel) &&
    /case 'ready':[\s\S]{0,160}pushConfig\(\)/.test(panel) &&
    /affectsConfiguration\('listenAndWrite\.showAudioDiagnostics'\)/.test(extSrc),
  '改设置要重载窗口才生效'
);
check(
  'panel.ts: 播放失败提示不指向不存在的 🔧 按钮',
  /state\.showAudioDiag[\s\S]{0,240}请点 🔧/.test(panel),
  '提示里硬提 🔧，开关关着时用户根本找不到该按钮'
);

/* ---------- 空输入不得进入判定（2026-09-19） ----------
 * 症状：输入框空着点「检查」也会判定。
 * 真正的危害不只是"多了一条判定"：checkSentence(idx, 原句, '') 会把原句里
 * 每个词都判成「漏听」，宿主随即把它写进错题库 —— 而错题库是【累积】的，
 * 一次手滑就足以让诊断报告的「弱读盲区 TOP」「最常出错的词」长期失真。
 *
 * 因此页面侧与宿主侧都要拦；页面侧负责给用户一个解释，宿主侧是兜底
 * （错题库的写入点必须自己防住，未来新增入口也走这里）。
 */
check(
  'panel.ts: 页面侧拦截空输入（不发 check，给提示）',
  /function doCheck[\s\S]{0,900}if \(!ta\.value\.trim\(\)\) \{/.test(panel) &&
    /还没输入内容/.test(panel),
  '空输入仍会被送去判定'
);
check(
  'panel.ts: 宿主 check 通道丢弃空输入（兜底，护住错题库）',
  /case 'check':[\s\S]{0,900}if \(!input\.trim\(\)\) return;/.test(panel),
  '错题库写入点没有自我防护：历史污染会一直累积'
);
check(
  'panel.ts: 通用提示与播放错误分开（空输入提示不能带「播放失败：」前缀）',
  /function showNotice/.test(panel) &&
    /showNotice\('播放失败：' \+ text\)/.test(panel),
  '复用 showPlayerError 会让"还没输入内容"看起来像音频坏了'
);

/* ---------- 清空错题库（诊断报告页，2026-09-19） ----------
 * 为什么需要：错题库是**追加累积**的。早期版本允许空输入提交判定，
 * checkSentence 会把整句每个词都判成「漏听」，一次手滑就往库里塞了整句的
 * 假错误；而报告口径是历史累计 —— 这种污染没法逐条挑出来，只能整体重置。
 */
check(
  'extension.ts: MistakeStore 提供 clear()',
  /clear\(\): void \{/.test(extSrc),
  '没有清空能力，被污染的统计只能一直挂着'
);
check(
  'panel.ts: 诊断报告有「清空数据」入口（仅在确有记录时才显示）',
  /id="clearStats"/.test(panel) && /rep\.totalAttempts > 0/.test(panel),
  '缺少入口'
);
check(
  'panel.ts: 清空需宿主弹确认框（webview 的 window.confirm 恒返回 false）',
  /case 'clearMistakes'/.test(panel) &&
    /showWarningMessage\([\s\S]{0,400}'清空'/.test(panel),
  '不可逆操作必须确认，且确认框只能由宿主弹'
);
check(
  'panel.ts: 清空后立即用新数据重绘报告',
  /case 'clearMistakes'[\s\S]{0,900}this\.showReport\(\)/.test(panel),
  '清空了却还显示旧统计'
);
check(
  'panel.ts: 确认框写明将删除的条数（不是盲点「清空」）',
  /case 'clearMistakes'[\s\S]{0,400}readAll\(\)\.length/.test(panel) &&
    /将删除 \$\{count\} 条/.test(panel),
  '确认框没告诉用户后果有多重'
);
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
