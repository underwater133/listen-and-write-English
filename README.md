# Listen & Write · 听写英语

把「听不懂」变成可追踪的数据。

不是播放器，是**听力 debug 器**：逐句听写 → 词级 diff → 归因到「漏听虚词 / 错听 / 拼写」，
最终告诉你**耳朵的盲区在哪**，而不是笼统的"听力不好"。

---

## 状态

| 模块 | 状态 |
|---|---|
| TED 素材源（元数据 + 字幕） | ✅ 实测可用 |
| TED 音频下载（84 分片 / 7.79MB / ~22s） | ✅ 实测可用 |
| 纯 JS MPEG-TS 解封装（零 ffmpeg） | ✅ 实测可用，**帧链贯穿至末尾 0 残留** |
| Webview 播放（裸 AAC） | ✅ 7 条加载路线全通过（headless Chrome 实测）；已加 CSP + Blob 降级链 |
| Webview UI（样式 + 交互） | ✅ CSP/转义修复，headless 实测无违规、按钮可响应 |
| 时间轴钳制（防越界 seek） | ✅ 实测末尾差 1ms |
| 词级 diff 校验 + 错误归因 | ✅ 16/16 测试通过 |
| 诊断报告（弱读盲区统计） | ✅ 可用 |
| 端到端冒烟测试 | ✅ 全绿（`node out/test/smoke.js`） |
| 本地文件源 + 强制对齐 | ⬜ 未实现 |
| YouTube / 播客源 | ⬜ 未实现 |

### 验证命令

```bash
npm run compile
node out/test/runTests.js          # 单元测试（diff 校验器，16 用例）
node out/test/testCacheGuard.js    # 缓存自检逻辑（5 用例）
node out/test/testWebviewHtml.js   # webview HTML 自检（17 用例）★ 改 UI 后必跑
node out/test/smoke.js             # 端到端（真实拉取 TED，约 5~25s）
node out/test/diagDemux.js         # TS 解封装诊断（单分片，约 2s）
node out/test/diagSeams.js         # 分片接缝诊断（前 6 片，约 3s）
```

> ⚠️ 跑冒烟测试前**先清缓存**，否则会复用旧结果：
> `rm -rf "$TMP/listening-trainer-smoke"`
>
> 改过 demux 后：
> 1. **递增 `AUDIO_CACHE_VERSION`**（否则旧坏缓存会被继续复用）
> 2. 在 VS Code 里 **`Ctrl+Shift+R` 重载窗口**（否则扩展宿主跑的还是旧编译产物）
>
> 改过 webview（`panel.ts` / `sidebar.ts`）后：
> - 先跑 `node out/test/testWebviewHtml.js` 拦掉 CSP / 转义类错误
> - 再 **`Ctrl+Shift+R`** 重载窗口



---

## 快速开始

```bash
npm install
npm run compile
```

在 VS Code 中按 `F5` 启动扩展开发宿主，然后：

- 命令面板 → `Listen & Write: 打开听写练习`
- 或 `Listen & Write: 从 TED 链接加载素材`，粘贴任意 TED talk 链接
- 或点左侧活动栏的 Listen & Write 图标（完整听写练习界面：发现 TED / 素材库 / 诊断）

> **F5 没反应？** 先确认 `.vscode/launch.json` 存在。F5 只是「启动当前调试配置」，
> 没有 `launch.json` 时 VS Code 不知道该用 `extensionHost` 类型启动，所以什么都不会发生。
> 本仓库已包含该文件。

### 首次使用建议

1. **配代理**：设置 `listeningTrainer.proxy`（如 `http://127.0.0.1:7890`）。TED 在国内需代理。
2. 加载一个短 talk 试水（8 分钟约 8MB 音频，串行约 16s）。

---

## 技术要点（踩过的坑）

这些都是实测得出的结论，改代码前请先读 `../ted-probe/TED-API-probe-report.md`。

### 1. ★ TED 反爬：不要伪装浏览器 UA

**这是最容易踩的坑，行为完全违反直觉。**

TED 由 Varnish 保护，对「声称浏览器身份但指纹不符」的请求直接 403：

```
403 Forbidden: automated access to TED.com is not permitted.
```

实测矩阵（GET talk 页面）：

| UA / Headers | 结果 |
|---|---|
| ❌ Chrome UA + 最简头 | 403 |
| ❌ Chrome UA + 完整 Sec-Fetch-* 头 | 403 |
| ❌ 旧版 Chrome UA | 403 |
| ✅ `curl/8.4.0` | **200** (182,981 B) |
| ✅ 不带 User-Agent | **200** (182,981 B) |

**结论：越努力伪装浏览器，越容易被拦。**
TED 拦截的是「浏览器 UA + 非浏览器 TLS 指纹」的组合特征。
解决方案见 `src/core/http.ts` 的 `pickUserAgent()`：只对 `www.ted.com` 用 `curl/8.4.0`，
其余 CDN 域（`hls.ted.com` / `pu.tedcdn.com`）用常规 UA。

### 2. 提取 `__NEXT_DATA__` 必须用 indexOf

```ts
// ❌ 会失败：页面内其他 </script> 干扰
/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s

// ✅ 正确
html.indexOf(START_TAG) → html.indexOf('</script>', jsonStart)
```

### 3. 时间轴恒差 3504ms

`__NEXT_DATA__.cue.time` **不含片头**，VTT 时间轴 **含片头**，差值恰好是 intro 分片时长 3.527s。

默认 `listeningTrainer.skipIntro = true`：裁掉 intro 分片，所有句子时间 -3504ms。
若改为 `false`，句子时间不再补偿，但用户每句都会多听 3.5s 片头。

### 4. 不要用 `audio.duration` 做时间轴基准

```
<audio> 报 6.090s
Web Audio 报 6.014s   ← 真值（= m3u8 的 #EXTINF:6.014）
```

ADTS 无时长元数据，浏览器按帧数估算，**85 个分片累积会漂移数秒**。
必须用 `frames * 1024 / sampleRate` 自算（见 `AudioInfo.durationMs`）。

### 5. 音频分片 URL 不能猜

`index-a1-v1.m3u8` 之类的猜测 **实测 404**。必须从 master m3u8 的
`#EXT-X-MEDIA:TYPE=AUDIO` 里解析 `URI` 属性。

### 6. ★★ TS 解封装必须剥两层包头（TS 头 + PES 头）

**这是全项目最深的坑，直接导致音频在浏览器里静默播放失败。**

```
PAT (PID 0) → PMT PID 4095 → PMT → 音频 stream_type=0x0f @ PID 256
→ 剥 188 字节 TS 包头 + 适配字段
→ ⚠️ 剥 PES 头（仅 PUSI=1 的包才有！）
→ ADTS 对齐 → 裸 AAC
```

**问题**：TS 包里 `payload_unit_start_indicator (PUSI) = 1` 的包，其 payload
**以 PES 头开头**（AAC 的 PES 头为 `00 00 01 c0 ...`，9 字节固定头 +
`PES_header_data_length` 字节可选头，通常共 14 字节）。

只剥 TS 包头、不剥 PES 头的话，这些 PES 头就被拼进了 ES 流。

实测数据（talk 2225，`segment-1-f8-a1.ts`，105,656 B）：

| 指标 | 值 |
|---|---|
| audioPid 的 TS 包数 | 560 |
| 其中 PUSI=1（带 PES 头） | **37** |
| ES 流里 `00 00 01 c0` 出现次数 | **37**（完全对应） |
| PES 头间隔 | 约 2600–2900 字节 |

**症状与危害**：

- ADTS 帧链每约 2700 字节就被一个 PES 头打断
- 实测修复前：从第 **7 帧**后就断链，尾部残留 **96,167 B** 无法解析
- 产出的 `.aac` Chromium 解码器无法同步 → `<audio>` 触发 error
- 而 `play().catch(() => {})` 把错误吞了 → **UI 上表现为「点击播放没反应」**

开头残留的 `Lavc58.101.101`（FFmpeg 编码器标识）就是 PES 头之后的私有数据，
它是最早暴露问题的线索。

**修复**（见 `demuxPid`）：

```ts
const pusi = (pkt[1] & 0x40) !== 0;
// ...
if (pusi && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
  const skip = 9 + payload[8];        // 9 字节固定头 + header_data_length
  payload = payload.subarray(skip);
}
```

修复后：帧链 **259 帧，贯穿至文件末尾，尾部剩余 0 B**。

> ### ⚠️ 由此得出的教训：帧数守恒 ≠ 数据正确
>
> 早期验证只看「多分片拼接前后帧数是否相等」（776 = 259+258+259），
> 结果**完全没发现这个 bug** —— 因为所有分片都同样多插了 PES 头，两侧计数一致。
>
> **正确的验证方式是校验帧链能否贯穿到底，而不是比对计数。**
> 见 `src/test/smoke.ts` 的「ADTS 帧链完整性」断言组，以及
> `demux.ts` 的 `walkAdtsFrames()` 返回值 `brokenAt` / `lengthCv`。

### 7. ★ 句子时间轴必须钳制到音频范围

实测：音频 495.93s，但 VTT 末两句（"Thank you." / "(Applause)"）标注到 **499.87s，超出 3.9s**。

根因：丢弃的 intro 分片时长 `3.527s` 与 VTT 偏移常量 `3.504s` 之间有 23ms 系统误差，
叠加片尾可能的截断，误差累积到末尾。

**不钳制的后果**：UI 会 seek 到不存在的区间，播放器卡住或行为异常。

解法见 `clampSentencesToAudio()`。钳制后末句 end `495931ms` vs 音频 `495932ms`，**差 1ms**。

⚠️ 注意：钳制发生在 `fetchAudio()` 内部，**必须读返回值的 `.sentences`**，
`fetchMetadata()` 的返回值仍是未钳制的原始数据。

### 8. diff 用 LCS 而非 Myers

句子短（几十词），O(n·m) 无压力。Myers 回溯在需要区分「替换」时容易出错
—— 实测初版会把整句误判为大量插入+删除，而非精准定位到个别词。

另外 `del`/`ins` 的顺序取决于回溯走法，**合并为 replace 时必须与顺序无关**
（`deterrents`→`deterents` 就会出现 ins 在前的形式）。

### 9. Webview 加载 globalStorage 里的音频必须声明资源根

`asWebviewUri` 生成的地址只有在 `localResourceRoots` 范围内才被允许加载。
音频存在 `globalStorageUri` 下，如果只声明 `ctx.extensionUri`：

```ts
// ❌ 音频静默加载失败（控制台报 "Not allowed to load local resource"）
localResourceRoots: [ctx.extensionUri]

// ✅
localResourceRoots: [ctx.extensionUri, ctx.globalStorageUri]
```

### 10. 声明了 view 就必须注册 provider

`package.json` 里写了 `viewsContainers.activitybar` + `views[type=webview]`，
但如果 `activate()` 里没有 `registerWebviewViewProvider`，点活动栏图标只会得到**空白面板**——
不报错，也不提示，最难查的那种。见 `src/webview/sidebar.ts`。

### 11. ★ 缓存必须带版本号 + 结构自检

**症状**：demux 明明修好了，单元测试和冒烟测试全绿，但 VS Code 里播放
依然报 `MEDIA_ERR_SRC_NOT_SUPPORTED`。

**原因**：缓存只要「文件存在」就直接复用，不校验内容。旧版 demux 产出的
坏文件会一直躺在缓存里被反复使用 —— **代码改了，但用户跑的还是旧数据**。

这类问题极其迷惑：所有测试都通过，只有实际操作失败。

**两道闸门**（见 `src/sources/ted.ts`）：

```ts
// 闸门 1：版本号比对。改 demux 逻辑时必须递增 AUDIO_CACHE_VERSION
if (info.cacheVersion !== AUDIO_CACHE_VERSION) { /* 重建 */ }

// 闸门 2：文件结构抽样自检（quickValidateAac）
const v = quickValidateAac(fs.readFileSync(aacPath));
if (!v.ok) { /* 重建 */ }
```

外加**落盘前自检**：`fetchAudio` 在 `writeFileSync` 之前调用
`quickValidateAac`，不合格直接抛错 —— **宁可报错也不写出坏文件**。

**连带修复**：`panel.ts::tryRestoreLast` 同样要校验（它绕过 `fetchAudio`
直接读缓存），否则重新打开窗口仍会加载坏文件。

> **推论**：任何「派生数据的缓存」都需要这个机制。
> 只判存在性 = 把 bug 永久固化在用户磁盘上。

### 12. ★★ 播放失败也可能是 CSP 挡了 `media-src`（真凶）

**症状**：文件经独立校验**完全正常**（21519 帧 / 零残留 / 参数唯一），
但 webview 里点播放仍报 `MEDIA_ERR_SRC_NOT_SUPPORTED`。

**排查方法**：把真实音频丢进 headless Chrome，跑 7 条加载路线对照：

```
OK | R1 相对URL原样        | loadedmetadata dur=499.01s
fetch OK | status=200 | content-type="audio/aac" | magic=ff f1 50 80
OK | R2 Blob audio/aac     | loadedmetadata dur=499.01s
OK | R3 Blob audio/mpeg    | ...
OK | R4 Blob audio/mp4     | ...
OK | R5 Blob audio/x-aac   | ...
OK | R6 Blob 无type        | ...
OK | R7 DataURI(前2MB)     | loadedmetadata dur=128.08s
```

**结论**：数据层完全没问题，Chromium 能解裸 ADTS。
所以失败点只可能在 **webview 的资源策略层**。

**根因**：webview HTML 原本**没有任何 CSP**。看似"没限制"，
但缺 `media-src` 声明的后果是媒体加载走了默认策略；
同时 `asWebviewUri` 返回的地址不保证携带 `Content-Type: audio/aac`，
Chromium 对裸 ADTS 的嗅探就不可靠 —— 于是被判 `SRC_NOT_SUPPORTED`。

**三重修复**（`panel.ts`）：

1. **显式声明 CSP**，含 `media-src ... blob: data:`
2. **加载降级链** `ensurePlayerSource()`：直链 → `Blob(type:'audio/aac')` → 失败则报告
   （Blob 显式带 type 是唯一能 **100% 保证 Content-Type** 的手段）
3. **`<script>` 加 nonce**，与 `script-src` 匹配

> **教训**：`MEDIA_ERR_SRC_NOT_SUPPORTED` 这个名字极具误导性 ——
> 它 90% 的情况**不是**"格式不支持"，而是**资源没被正确交付**
> （路径被拒 / Content-Type 缺失 / CSP 拦截 / 嗅探失败）。
> 先查交付链路，再怀疑数据。
>
> **更重要的教训**：我第一次判断"文件损坏"用的是 PowerShell 脚本，
> 而 PowerShell 的 `-shl` 作用在 `[byte]` 上会**符号扩展**，
> `0x26 << 3` 算出 50（正确值 306）—— 我用**没验证过的工具**得出了
> **错误的结论**，并把它当事实用了两轮。换 Node 重算才发现文件是好的。
> **验证工具本身必须先被验证。**

### 13. ★★ 补 CSP 时踩的连环坑（样式全丢 + 按钮全失效）

上一节加的 CSP **修好了音频，却弄坏了整个界面**：
面板变成无样式的裸 HTML，所有按钮失灵。

原因是两个独立的错误，都很隐蔽：

#### 坑 A：`default-src 'none'` 会连 VS Code 注入的样式一起挡掉

VS Code 会往 webview 注入自己的基础样式表。只写 `default-src 'none'`
就把它一起封了 → **「样式全没了」**。

```ts
// ❌ 错
"default-src 'none'",
`style-src 'nonce-${nonce}'`,

// ✅ 对：必须放行 cspSource
`style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
`script-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
```

#### 坑 B：★ nonce 与 `'unsafe-inline'` 互斥

这是**最反直觉**的一条。CSP 规范规定：**只要 source list 里出现
nonce（或 hash），`'unsafe-inline'` 就被完全忽略。**

Chrome 的警告原文：
```
Note that 'unsafe-inline' is ignored if either a hash or nonce
value is present in the source list.
```

所以 `style-src 'unsafe-inline' 'nonce-xxx'` ≈ `style-src 'nonce-xxx'`，
内联样式照样被拦。而本页有 **21 处内联 `style="..."`** +
`<style>` 块 + JS 里 `el.style.display` 动态赋值 —— 全都失效。

**结论：本页结构无法改成纯 nonce 模式，就必须彻底放弃 nonce。**

#### 坑 C：模板字符串里的 `\n` 会把生成的 JS 切成两半

真正让「点击加载没反应」的原因不在 CSP，而在这里：

```ts
// 外层是 TS 模板字符串，\n 会被【展开成真换行】
if (el) el.textContent = lines.join('\n');   // ❌ 生成 JS 时字符串被切断
if (el) el.textContent = lines.join('\\n');  // ✅ 必须双重转义
```

展开后生成的 JS 变成 `lines.join('` + 真换行 + `')` →
`SyntaxError: Invalid or unexpected token` → **整个 `<script>` 报废**，
后续所有 `onclick` 绑定全部不执行。

**这类 bug 在 TS 编译期完全不报错**，只在运行时炸，且症状与 CSP 问题
高度相似（都是"页面不动了"），极易误判。

#### 怎么一次性验证（不用启动 VS Code）

把 `renderHtml()` 的**真实产物**抽出来，注入假的 `acquireVsCodeApi`，
丢进 headless Chrome 看控制台：

```bash
chrome --headless=new --enable-logging=stderr --v=1 --dump-dom page.html
# 过滤 INFO:CONSOLE 行 → 能直接看到 CSP 违规和 SyntaxError
```

**判定信号**：
| 现象 | 含义 |
|---|---|
| `violates ... Content Security Policy` | CSP 配置错 |
| `SyntaxError: Invalid or unexpected token` | 模板转义漏了 |
| `STYLE_SHEET_RULES=0` / BLOCKED | 样式表被拦 |
| 无任何 CONSOLE 报错 + 按钮可 postMessage | ✅ 正常 |

#### 已加自动化防线

`src/test/testWebviewHtml.ts`（**17 项**）静态检查：
- 模板字符串内字符串字面量是否有未双重转义的 `\n` 等
- CSP 是否在「有内联样式」时错误地带上 nonce
- `style-src` / `script-src` 是否放行 `cspSource`
- `media-src` 是否放行 `blob:`
- 关键元素与事件绑定是否存在

并带**自检器有效性验证**（故意构造好坏样本，确认检测器真能区分）——
因为我自己就写出过一个"永远返回 ✅"的假检测器。

```bash
node out/test/testWebviewHtml.js   # 17 通过 / 0 失败
```

---

## 架构

```
src/
├── core/
│   ├── types.ts      # ListeningMaterial / Sentence 统一模型 + VTT 解析
│   ├── demux.ts      # MPEG-TS 解封装 → AAC（纯 JS）
│   ├── diff.ts       # 词级 diff + 错误归因 + 诊断报告  ← 产品灵魂
│   └── http.ts       # 带代理/重试的 HTTP + 并发控制
├── sources/
│   └── ted.ts        # TED 适配器
├── webview/
│   ├── panel.ts      # 练习面板 UI（独立标签页，完整练习界面）
│   └── sidebar.ts    # 侧边栏视图（完整练习界面，与编辑器面板共享宿主逻辑）
├── test/
│   ├── runTests.ts   # diff 校验器测试（16 用例）
│   └── smoke.ts      # 端到端冒烟测试（真实拉取 TED）
└── extension.ts      # 入口 + 错误记录持久化
```

### 新增素材源

实现 `MaterialSourceAdapter` 接口即可，下游全部复用：

```ts
interface MaterialSourceAdapter {
  readonly source: MaterialSource;
  canHandle(input: string): boolean;
  fetchMetadata(input: string, cacheDir: string): Promise<ListeningMaterial>;
  fetchAudio(m: ListeningMaterial, onProgress?): Promise<ListeningMaterial>;
}
```

---

## 数据存储

```
<globalStorage>/
├── materials/
│   └── ted-<talkId>/
│       ├── material.json   # 元数据 + 句子（含译文）
│       ├── audio.aac       # 解封装后的裸 AAC
│       └── audio.json      # 音频信息（帧数/时长/offset）
└── stats/
    └── mistakes.jsonl      # 错误记录（append-only，可长期累积）
```

`mistakes.jsonl` 每次只记错误（正确的不记），便于统计且不膨胀。

---

## 已知限制

- **TED 无官方字幕 API**：只能解析 HTML，TED 改版会导致解析失败（已做友好报错）。
- **国内需代理**：未配代理时首次加载会失败。
- **本地文件源未实现**：需要强制对齐（Whisper / aeneas），是下一步工作。
- **不做**：视频播放、AI 摘要、语法分析、词库管理。这是一个训练器，不是学习平台。

---

## 设计取舍

| 决策 | 理由 |
|---|---|
| 只做精听，不做泛听 | 越窄越有活路 |
| 不拼播放体验 | 浏览器和播客 App 更强，没必要 |
| diff 是核心而非附属 | 诊断能力才是差异化 |
| 零 ffmpeg 依赖 | 用户装环境是最大的流失点 |
| 错误记录 append-only | 长期累积才能看出进步曲线 |
| 不用 base64 内联音频 | 8MB 会让 webview 卡死，走 `asWebviewUri` |
