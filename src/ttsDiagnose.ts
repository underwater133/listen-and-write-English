/**
 * TTS 发音诊断（命令：listenAndWrite.ttsDiagnose）
 *
 * 为什么要有这个页面（设计决策 Q15）：
 *   「词库」的发音走的是 webview 里的 Web Speech API（Electron → 系统语音），
 *   而它能不能用、用的是什么声音，完全取决于【运行时的系统语言包】：
 *     - Windows 中文系统常见只有 en-US（Zira/David），没有 en-GB；
 *     - 有些机器一个英文语音都没有，此时拿中文语音读英文单词就是错的；
 *     - Electron 里 getVoices() 是异步的，首屏经常是空数组。
 *   这些问题没法靠读代码判断，只能把真实语音列表和样词放出来让耳朵验。
 *
 * 页面只做三件事：列出全部语音 + 按口音归类 + 播几个易错样词。
 * 不落盘、不读用户数据，纯粹一个排查工具。
 */

import * as vscode from 'vscode';

/** 易错样词：涵盖重音、连读、th/æ 等中文母语者常出问题的音 */
const SAMPLES = ['apple', 'schedule', 'particularly', 'thought', 'comfortable', 'data'];

export function showTtsDiagnostic(): void {
  const panel = vscode.window.createWebviewPanel(
    'listenAndWriteTts',
    'Listen & Write · TTS 发音诊断',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml(panel.webview);
}

function renderHtml(webview: vscode.Webview): string {
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const sampleButtons = SAMPLES.map(
    (w) => `<button class="ghost" data-word="${w}">${w}</button>`
  ).join(' ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TTS 发音诊断</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 12px 16px 24px; line-height: 1.7;
  }
  h2 { font-size: 15px; margin: 18px 0 6px; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .warn { color: var(--vscode-errorForeground); }
  .ok { color: var(--vscode-charts-green, #3fb950); }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 6px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #4444); }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  button {
    font-family: inherit; font-size: 12px; padding: 3px 9px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground, #fff);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    border: none; border-radius: 3px;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  button:disabled { opacity: .4; cursor: default; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 6px 0; }
  code { font-family: var(--vscode-editor-font-family, Consolas, monospace); }
</style>
</head>
<body>
  <div class="hint">检查本机 Web Speech API 能提供哪些英语语音。「词库」的 🔊 美 / 🔊 英
    按钮只认 en-US / en-GB；缺哪个就置灰（不会拿另一个口音代替）。</div>

  <h2>环境</h2>
  <div id="env" class="hint">检测中…</div>

  <h2>按口音归类</h2>
  <div id="accents" class="hint">检测中…</div>

  <h2>样词试听（用选中的语音朗读）</h2>
  <div class="row">
    <select id="voiceSel" style="max-width:340px;padding:3px"></select>
    <button id="allBtn">逐个试听全部语音（前 5 个）</button>
  </div>
  <div class="row">${sampleButtons}</div>

  <h2>全部语音（<span id="count">0</span> 个）</h2>
  <div id="empty" class="hint" style="display:none"></div>
  <table id="tbl" style="display:none">
    <thead><tr><th>名称</th><th>lang</th><th>本地/网络</th><th>默认</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>

<script nonce="${nonce}">
(function () {
  var voices = [];
  var tried = 0;

  function el(id) { return document.getElementById(id); }

  function lang(v) { return String((v && v.lang) || '').toLowerCase().replace('_', '-'); }

  function refresh() {
    var s = window.speechSynthesis;
    if (!s) return false;
    try {
      var list = s.getVoices() || [];
      if (list.length !== voices.length) {
        voices = list;
        render();
      }
      return voices.length > 0;
    } catch (e) { return false; }
  }

  function render() {
    var en = voices.filter(function (v) { return lang(v).indexOf('en') === 0; });
    var us = en.filter(function (v) { return lang(v) === 'en-us'; });
    var gb = en.filter(function (v) { return lang(v) === 'en-gb'; });

    el('env').innerHTML =
      (voices.length
        ? '<span class="ok">Web Speech API 可用</span>，共 ' + voices.length + ' 个语音'
        : '<span class="warn">没有取到任何语音</span>') +
      '<br>UA：<code>' + String(navigator.userAgent).replace(/[<>]/g, '') + '</code>';

    el('accents').innerHTML =
      '美音 en-US：' + (us.length
        ? '<span class="ok">' + us.map(function (v) { return v.name; }).join(' / ') + '</span>'
        : '<span class="warn">无 —— 「🔊 美」在词库里会置灰</span>') +
      '<br>英音 en-GB：' + (gb.length
        ? '<span class="ok">' + gb.map(function (v) { return v.name; }).join(' / ') + '</span>'
        : '<span class="warn">无 —— 「🔊 英」在词库里会置灰（可在 Windows 设置里添加「英语(英国)」语音包）</span>') +
      '<br>其他英语语音 ' + (en.length - us.length - gb.length) + ' 个' +
      (en.length ? '' : '<br><span class="warn">一个英语语音都没有：此时不要用 TTS，改用其它发音来源。</span>');

    var sel = el('voiceSel');
    sel.innerHTML = voices.map(function (v, i) {
      return '<option value="' + i + '">' + v.name + ' · ' + v.lang +
        (v.localService ? ' · 本地' : ' · 网络') + '</option>';
    }).join('');

    el('count').textContent = String(voices.length);
    el('tbl').style.display = voices.length ? '' : 'none';
    el('empty').style.display = voices.length ? 'none' : '';
    if (!voices.length) {
      el('empty').innerHTML = tried > 6
        ? '等了约 3 秒仍为空。可能是本机没有安装任何语音包，或该 Electron 版本不带语音服务。'
        : '语音列表还在加载（Electron 下是异步的）…';
    }
    el('rows').innerHTML = voices.map(function (v, i) {
      return '<tr><td>' + v.name + '</td><td>' + v.lang + '</td><td>' +
        (v.localService ? '本地' : '网络') + '</td><td>' + (v['default'] ? '✓' : '') +
        '</td><td><button data-i="' + i + '">试听</button></td></tr>';
    }).join('');

    Array.prototype.forEach.call(el('rows').querySelectorAll('button'), function (b) {
      b.onclick = function () { speak('apple', voices[Number(b.dataset.i)]); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-word]'), function (b) {
      b.onclick = function () {
        var v = voices[Number(el('voiceSel').value)];
        speak(b.dataset.word, v);
      };
    });
  }

  function speak(text, voice) {
    var s = window.speechSynthesis;
    if (!s || !text) return;
    try {
      s.cancel();
      var u = new SpeechSynthesisUtterance(text);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = 0.9;
      setTimeout(function () { try { s.speak(u); } catch (e) {} }, 30);
    } catch (e) {}
  }

  el('allBtn').onclick = function () {
    var en = voices.filter(function (v) { return lang(v).indexOf('en') === 0; }).slice(0, 5);
    if (!en.length) return;
    var i = 0;
    var t = setInterval(function () {
      if (i >= en.length) { clearInterval(t); return; }
      speak('schedule', en[i]);
      i++;
    }, 1800);
  };

  if (typeof window.speechSynthesis !== 'undefined') {
    try { window.speechSynthesis.addEventListener('voiceschanged', refresh); } catch (e) {}
  }
  refresh();
  var timer = setInterval(function () {
    tried++;
    if (refresh() || tried > 8) clearInterval(timer);
  }, 400);
})();
</script>
</body>
</html>`;
}
