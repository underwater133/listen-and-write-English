/**
 * 精听练习面板
 *
 * UI 结构（单 webview，侧边栏或独立面板）：
 *   ┌──────────────────────────┐
 *   │ 句子列表（可滚动）        │
 *   │  ▸ [0] When I was a kid  │
 *   │  ▸ [1] the disaster...   │  ← 点击播放
 *   │                          │
 *   ├──────────────────────────┤
 *   │ 当前句                       │
 *   │ ▶ ⟲ 0.75x   句 3/137      │
 *   │ ┌──────────────────────┐ │
 *   │ │ 听写输入框            │ │
 *   │ └──────────────────────┘ │
 *   │ [检查]                   │
 *   │ diff 结果高亮显示          │
 *   └──────────────────────────┘
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ListeningMaterial, MaterialSourceAdapter, AudioInfo, clampSentencesToAudio, AUDIO_CACHE_VERSION } from '../core/types';
import { checkSentence, SentenceResult, buildReport } from '../core/diff';
import { isValidMp3 } from '../core/transcode';
import { tedApiSearch, TedSort } from '../core/tedSearch';
import { MistakeStore, trace } from '../extension';

export interface PanelDeps {
  adapters: MaterialSourceAdapter[];
  cacheRoot: string;
  storage: string;
}

/** 素材库列表项（已缓存素材的概要） */
export interface CachedMaterial {
  id: string;
  /**
   * 磁盘上的目录名。⚠️ 必须用它拼路径，不能用 id！
   * 真实事故：adapter 建目录用 `ted-66`（连字符），而 material.json 里的
   * id 是 `ted:66`（冒号）—— Windows 目录名不允许冒号，用 id 拼
   * materials/ted:66/ 直接 ENOENT。id 里的冒号是素材逻辑标识，
   * 目录名才是磁盘事实，两者不能混用。
   */
  dirName: string;
  title: string;
  sentenceCount: number;
  hasAudio: boolean;
  durationMs: number;
  fetchedAt: number;
}

/**
 * 音频缓存校验统一走 core/transcode.ts 的 isValidMp3()。
 *
 * ⚠️ v5 起最终产物是 MP3（VS Code 的 ffmpeg 没有 AAC 解码器，AAC 播不了）。
 *    拿 MP4/ADTS 校验器去查 MP3 会把所有正常缓存判为损坏，
 *    表现为「每次打开都要重新下载」，且日志看起来像文件坏了。
 *
 * 这里曾有两份各自实现的 MP4 校验器，最终漂移成「坏缓存被判为合格」
 * 并反复复用。判据必须单一来源。
 */

export class PracticePanel {
  public static current: PracticePanel | undefined;
  /** 侧边栏实例（WebviewView 承载的完整练习 UI） */
  public static sidebar: PracticePanel | undefined;

  /** 编辑器标签页容器（侧边栏实例时为 undefined） */
  private readonly panel: vscode.WebviewPanel | undefined;
  /**
   * webview 本体。WebviewPanel 与 WebviewView 的 .webview 是同一个接口
   * （html / onDidReceiveMessage / postMessage / asWebviewUri / cspSource），
   * 所以练习 UI 的全部宿主逻辑对两种容器一视同仁。
   */
  private readonly webview: vscode.Webview;
  private readonly kind: 'panel' | 'sidebar';
  private readonly ctx: vscode.ExtensionContext;
  private readonly deps: PanelDeps;
  private readonly store: MistakeStore;
  private material: ListeningMaterial | undefined;
  private audioUri: string | undefined;
  private disposables: vscode.Disposable[] = [];

  static createOrShow(ctx: vscode.ExtensionContext, deps: PanelDeps): PracticePanel {
    const column = vscode.ViewColumn.Beside;

    if (PracticePanel.current) {
      PracticePanel.current.panel!.reveal(column);
      return PracticePanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'listeningTrainer',
      'Listen & Write · 听写英语',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // ⚠️ 音频存在 globalStorageUri 下，必须把 storage 根也加进来，
        // 否则 asWebviewUri 生成的 audio 地址会被 webview 拒绝加载（静默失败）
        localResourceRoots: [ctx.extensionUri, ctx.globalStorageUri],
      }
    );

    const inst = new PracticePanel(
      panel.webview,
      panel.onDidDispose,
      ctx,
      deps,
      'panel',
      panel
    );
    PracticePanel.current = inst;
    return inst;
  }

  /**
   * 把完整练习 UI 挂到侧边栏视图（WebviewView）。
   *
   * 复用 PracticePanel 的全部宿主逻辑 —— WebviewView 的 .webview 与
   * WebviewPanel 的 .webview 是同一个接口，练习 UI 不感知容器差异。
   * 侧边栏收起时通过 postMessage 通知页面暂停播放（音频不会自己停）。
   */
  static attachToSidebar(
    ctx: vscode.ExtensionContext,
    deps: PanelDeps,
    view: vscode.WebviewView
  ): PracticePanel {
    if (PracticePanel.sidebar) return PracticePanel.sidebar;

    const inst = new PracticePanel(
      view.webview,
      view.onDidDispose,
      ctx,
      deps,
      'sidebar',
      undefined
    );

    // 侧边栏收起/隐藏时暂停播放 —— webview 隐藏后音频不会自己停。
    // ⚠️ 本项目 @types/vscode 里该事件回调参数声明为 void，
    //    不能依赖参数，要用 view.visible 属性判断可见性。
    view.onDidChangeVisibility(() => {
      if (!view.visible) {
        inst.webview
          .postMessage({ type: 'pausePlayback' })
          .then(undefined, () => {});
      }
    }, null, inst.disposables);

    PracticePanel.sidebar = inst;
    return inst;
  }

  private constructor(
    webview: vscode.Webview,
    onDispose: vscode.Event<void>,
    ctx: vscode.ExtensionContext,
    deps: PanelDeps,
    kind: 'panel' | 'sidebar',
    panel: vscode.WebviewPanel | undefined
  ) {
    this.webview = webview;
    this.panel = panel;
    this.kind = kind;
    this.ctx = ctx;
    this.deps = deps;
    this.store = new MistakeStore(deps.storage);

    this.webview.html = this.renderHtml();

    onDispose(() => this.dispose(), null, this.disposables);

    this.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);

    // 自动恢复上次素材
    this.tryRestoreLast();
  }

  /* ---------------- 对外接口 ---------------- */

  loadMaterial(material: ListeningMaterial): void {
    this.material = material;
    if (material.audio) {
      // ⚠️ 用 asWebviewUri 指向本地文件，不要 base64 内联大文件
      const fileUri = vscode.Uri.file(material.audio.path);
      const webUri = this.webview.asWebviewUri(fileUri);
      this.audioUri = webUri.toString();
      trace('[LT-TRACE] loadMaterial:');
      trace('[LT-TRACE]   fileUri  = ' + fileUri.toString());
      trace('[LT-TRACE]   audioUri = ' + this.audioUri);
      trace('[LT-TRACE]   bytes    = ' + material.audio.bytes);
      trace('[LT-TRACE]   root     = ' + this.ctx.globalStorageUri.toString());
      trace('[LT-TRACE]   roots    = ' + JSON.stringify(this.webview.options.localResourceRoots?.map((u) => u.toString())));
      trace('[LT-TRACE]   existsAtPath = ' + fs.existsSync(material.audio.path));
    } else {
      trace('[LT-TRACE] loadMaterial: material.audio 为空，音频不可用');
    }
    this.pushMaterial();
  }

  showReport(): void {
    const records = this.store.readAll();
    const report = buildReport(records);
    this.webview.postMessage({ type: 'report', report });
  }

  /**
   * 恢复上次使用的素材
   *
   * 优先选「音频已就绪」的素材（可直接练习）；
   * 若都未就绪，则恢复最近的元数据（UI 会提示需下载）。
   *
   * ⚠️ 恢复时对句子时间轴再钳制一次，防止旧版缓存
   *    （钳制逻辑加入之前生成的 material.json）导致越界 seek。
   */
  private tryRestoreLast(): void {
    try {
      const dirs = fs
        .readdirSync(this.deps.cacheRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory());

      const candidates: Array<{ m: ListeningMaterial; hasAudio: boolean; ts: number }> = [];

      for (const d of dirs) {
        const p = path.join(this.deps.cacheRoot, d.name, 'material.json');
        if (!fs.existsSync(p)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(p, 'utf8')) as ListeningMaterial;
          const audioInfoPath = path.join(this.deps.cacheRoot, d.name, 'audio.json');
          let hasAudio = false;
          if (fs.existsSync(audioInfoPath)) {
            const info = JSON.parse(fs.readFileSync(audioInfoPath, 'utf8')) as AudioInfo;

            // ⚠️ 必须校验缓存版本，否则会继续复用旧版 demux 产出的坏文件 ——
            //    表现为「重新打开还是播放失败」，而代码其实已经修好了。
            if (info.cacheVersion !== AUDIO_CACHE_VERSION) {
              continue;
            }
            // 再校验文件本身（版本对但文件被截断/损坏的情况）
            //
            // ⚠️ v5 起最终产物是 MP3（裸流，没有容器结构可查）。
            //    不能拿 MP4/ADTS 校验器去查 —— 那会把所有正常缓存判为损坏。
            //    isValidMp3 看文件头帧同步 + 是否还能扫到若干处同步，
            //    足以挡住「空文件 / 被截断 / 根本不是 MP3」。
            try {
              const buf = fs.readFileSync(info.path);
              if (!isValidMp3(buf)) {
                trace('[LT-TRACE] 缓存 MP3 校验不合格（非 MP3 或被截断），跳过');
                continue;
              }
            } catch {
              continue;
            }

            m.audio = info;
            // 旧缓存兜底钳制
            if (m.audio?.durationMs) {
              m.sentences = clampSentencesToAudio(m.sentences, m.audio.durationMs);
            }
            hasAudio = true;
          }
          candidates.push({ m, hasAudio, ts: m.fetchedAt ?? 0 });
        } catch {
          /* 单个素材损坏，跳过 */
        }
      }

      if (candidates.length === 0) return;

      // 有音频的优先，其次按时间倒序
      candidates.sort((a, b) => {
        if (a.hasAudio !== b.hasAudio) return a.hasAudio ? -1 : 1;
        return b.ts - a.ts;
      });

      const best = candidates[0];
      if (best.hasAudio) {
        this.loadMaterial(best.m);
      }
    } catch {
      /* 忽略恢复失败 */
    }
  }

  /* ---------------- 消息处理 ---------------- */

  /**
   * 扫描缓存目录，列出已缓存素材概要（素材库视图的数据源）。
   * 音频就绪与否以 audio.json 的 cacheVersion 为准 —— 过期缓存按缺音频处理，
   * 避免点了卡片才发现要重新下载。
   */
  /**
   * 删除素材目录（素材库的删除入口，单删/多选/全删统一走这里）。
   *
   * 防御：
   *   - dirName 必须通过文件名合法性检查（id 里的冒号事故已证明不能信任外部输入）
   *   - 删除的是「当前正在练习的素材」时，通知页面停播并清空界面
   *   - 结束后重推列表，页面无需自行刷新
   */
  private deleteCachedDirs(dirNames: string[]): void {
    const valid = dirNames.filter((n) => n && !/[\\/:*?"<>|]/.test(n));
    let removedCurrent = false;
    for (const dn of valid) {
      const dir = path.join(this.deps.cacheRoot, dn);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        trace('[LT-TRACE] 已删除素材目录: ' + dn);
        const curBase = this.material?.cacheDir
          ? path.basename(this.material.cacheDir)
          : '';
        if (dn === curBase) removedCurrent = true;
      } catch (e: any) {
        trace('[LT-TRACE] 删除失败 ' + dn + ': ' + String(e?.message ?? e));
      }
    }
    if (removedCurrent) {
      this.material = undefined;
      this.audioUri = undefined;
      this.webview.postMessage({ type: 'materialRemoved' });
    }
    // 删除后重推列表（即使部分失败，列表也反映实际磁盘状态）
    this.webview.postMessage({ type: 'cachedList', error: null, items: this.scanCached() });
  }

  private scanCached(): CachedMaterial[] {
    if (!fs.existsSync(this.deps.cacheRoot)) return [];
    const out: CachedMaterial[] = [];
    for (const d of fs.readdirSync(this.deps.cacheRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(this.deps.cacheRoot, d.name);
      const metaPath = path.join(dir, 'material.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ListeningMaterial;
        const infoPath = path.join(dir, 'audio.json');
        let hasAudio = false;
        let durationMs = 0;
        if (fs.existsSync(infoPath)) {
          const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as AudioInfo;
          if (info.cacheVersion === AUDIO_CACHE_VERSION) {
            hasAudio = true;
            durationMs = info.durationMs ?? 0;
          }
        }
        out.push({
          id: m.id,
          // ⚠️ 恢复素材必须用目录名，不能用 m.id（id 里可能含冒号等
          //    Windows 目录名非法字符，见 CachedMaterial.dirName 的注释）
          dirName: d.name,
          title: m.title || m.id,
          sentenceCount: m.sentences?.length ?? 0,
          hasAudio,
          durationMs,
          fetchedAt: m.fetchedAt ?? 0,
        });
      } catch {
        /* 跳过损坏素材 */
      }
    }
    out.sort((a, b) => b.fetchedAt - a.fetchedAt);
    return out;
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      // webview 内的日志回传到宿主的输出通道，
      // 否则「页面里为什么加载失败」在宿主侧完全不可见。
      case 'log':
        trace('[LT-PAGE] ' + String(msg.text ?? ''));
        break;

      case 'ready':
        trace('[LT-TRACE] webview ready，回推素材');
        this.pushMaterial();
        break;

      case 'check': {
        const idx: number = msg.sentenceIndex;
        const input: string = msg.input ?? '';
        const m = this.material;
        if (!m || !m.sentences[idx]) return;

        const result = checkSentence(idx, m.sentences[idx].text, input);
        // 只有有错误才记录，避免污染统计
        if (!result.correct) {
          this.store.append(m.id, result);
        }
        this.webview.postMessage({ type: 'checkResult', result });
        break;
      }

      case 'requestReport':
        this.showReport();
        break;

      /**
       * ★ 终极兜底：由扩展宿主直接读音频文件，把字节交给 webview。
       *
       * 为什么需要它：
       *   asWebviewUri() 产出的 vscode-cdn.net 地址在部分环境下会被
       *   webview 资源服务拒绝（实测 fetch 返回 401 + 12 字节 "Unauthorized"，
       *   <audio> 报 MEDIA_ERR_SRC_NOT_SUPPORTED / code=4）。
       *   这条路径完全绕开 webview 的 CDN 权限层，
       *   用扩展宿主自己的 fs 读文件 —— 宿主对 globalStorage 有天然读权限。
       *
       * 8MB 的音频转 base64 约 11MB，postMessage 可以承受。
       * 只作为最后一道降级，正常情况仍优先走 asWebviewUri（更省内存）。
       */
      case 'requestAudioBytes': {
        await this.sendAudioBytes();
        break;
      }

      case 'loadFromInput': {
        const input = String(msg.input ?? '').trim();
        if (!input) return;
        await this.loadFromInput(input);
        break;
      }

      /**
       * TED 浏览/搜索（宿主代理）：webview 不能跨域，且 TED 有 UA 反爬，
       * 必须由宿主 POST api/search 再把结果 postMessage 回来。
       */
      case 'tedSearch': {
        try {
          const sort: TedSort = ['relevance', 'popular', 'newest', 'oldest'].includes(msg.sort)
            ? msg.sort
            : 'popular';
          const page = Number(msg.page) || 0;
          const r = await tedApiSearch(String(msg.query ?? ''), sort, page);
          this.webview.postMessage({ type: 'tedResults', reqId: msg.reqId, error: null, ...r });
        } catch (e: any) {
          this.webview.postMessage({
            type: 'tedResults',
            reqId: msg.reqId,
            error: String(e?.message ?? e),
          });
        }
        break;
      }

      // 素材库删除：dirNames 为目录名数组（单删/多选删/全删统一入口）
      case 'deleteCached': {
        const names: string[] = Array.isArray(msg.dirNames)
          ? msg.dirNames.map(String)
          : [];
        this.deleteCachedDirs(names);
        break;
      }

      // 「发现 TED」卡片点击：slug → talk 页面 URL，走与手输链接相同的加载流程
      case 'loadTedUrl': {
        const url = String(msg.url ?? '').trim();
        if (/^https?:\/\/(www\.)?ted\.com\/talks\//i.test(url)) {
          await this.loadFromInput(url);
        }
        break;
      }

      // 「素材库」：列出已缓存素材 / 点击卡片恢复
      case 'listCached': {
        try {
          this.webview.postMessage({ type: 'cachedList', error: null, items: this.scanCached() });
        } catch (e: any) {
          this.webview.postMessage({
            type: 'cachedList',
            error: String(e?.message ?? e),
            items: [],
          });
        }
        break;
      }

      case 'openCached': {
        // ⚠️ 用目录名定位（scanCached 返回的 dirName），不能用素材 id 拼
        //    路径 —— id 形如 ted:66，Windows 目录名不允许冒号（ENOENT 实测）
        const dirName = String(msg.dirName ?? '');
        if (!dirName || /[\\/:*?"<>|]/.test(dirName)) {
          this.webview.postMessage({ type: 'error', message: '素材目录名非法：' + dirName });
          return;
        }
        try {
          const dir = path.join(this.deps.cacheRoot, dirName);
          const m = JSON.parse(
            fs.readFileSync(path.join(dir, 'material.json'), 'utf8')
          ) as ListeningMaterial;
          const infoPath = path.join(dir, 'audio.json');
          if (!fs.existsSync(infoPath)) {
            this.webview.postMessage({
              type: 'error',
              message: '该素材还没有音频缓存，请到「发现 TED」重新加载。',
            });
            return;
          }
          const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as AudioInfo;
          // 与 tryRestoreLast 同一判据：版本 + MP3 文件本身都要合格
          if (info.cacheVersion !== AUDIO_CACHE_VERSION || !fs.existsSync(info.path)) {
            this.webview.postMessage({
              type: 'error',
              message: '该素材的音频缓存已过期，请到「发现 TED」重新加载一次。',
            });
            return;
          }
          if (!isValidMp3(fs.readFileSync(info.path))) {
            this.webview.postMessage({
              type: 'error',
              message: '该素材的音频缓存损坏，请到「发现 TED」重新加载一次。',
            });
            return;
          }
          const clamped = clampSentencesToAudio(m.sentences, info.durationMs);
          this.loadMaterial({ ...m, sentences: clamped, audio: info, status: 'ready' });
        } catch (e: any) {
          this.webview.postMessage({
            type: 'error',
            message: '打开素材失败：' + String(e?.message ?? e),
          });
        }
        break;
      }
    }
  }

  /**
   * 读取当前素材的音频文件并回传字节。
   * 走宿主 fs，不经过 webview 资源协议，因此不受 401 影响。
   */
  private async sendAudioBytes(): Promise<void> {
    const audioPath = this.material?.audio?.path;
    if (!audioPath) {
      this.webview.postMessage({ type: 'audioBytes', error: 'no-path' });
      return;
    }
    try {
      const buf = await fs.promises.readFile(audioPath);
      trace('[LT-TRACE] sendAudioBytes: 读取 ' + buf.byteLength + ' 字节 <- ' + audioPath);

      // 容器自检：v3 起应当是 MP4（box size + 'ftyp'）。
      // 如果这里发现裸 ADTS（0xFFF 同步字），说明缓存还是旧版 ——
      // 那在 VS Code 的 webview 里必报 DEMUXER_ERROR_COULD_NOT_OPEN，
      // 与其让页面侧去猜，不如在这里就把原因说清楚。
      const isAdts = buf.length > 2 && buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0;
      const isMp4 = buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp';
      trace('[LT-TRACE] sendAudioBytes: 容器 ADTS=' + isAdts + ' MP4(ftyp)=' + isMp4);
      if (isAdts && !isMp4) {
        trace(
          '[LT-TRACE] ⚠️ 缓存仍是裸 ADTS，VS Code 内置 ffmpeg 无 ADTS 解复用器，' +
            '播放必然失败。请删除该素材缓存后重新下载（cacheVersion 需为 ' +
            AUDIO_CACHE_VERSION + '）。'
        );
      }

      this.webview.postMessage({
        type: 'audioBytes',
        base64: buf.toString('base64'),
        bytes: buf.byteLength,
        // 页面据此选 MIME
        format: this.material?.audio?.format ?? null,
      });
    } catch (e: any) {
      trace('[LT-TRACE] sendAudioBytes 失败: ' + (e?.message ?? e));
      this.webview.postMessage({ type: 'audioBytes', error: String(e?.message ?? e) });
    }
  }

  private async loadFromInput(input: string): Promise<void> {
    const adapter = this.deps.adapters.find((a) => a.canHandle(input));
    if (!adapter) {
      this.webview.postMessage({
        type: 'error',
        message: '暂时只支持 TED 链接。请粘贴 https://www.ted.com/talks/... 形式的地址。',
      });
      return;
    }

    this.webview.postMessage({ type: 'progress', message: '解析页面…', percent: 5 });
    try {
      const material = await adapter.fetchMetadata(input, this.deps.cacheRoot);
      this.webview.postMessage({
        type: 'progress',
        message: `已解析 ${material.sentences.length} 句，下载音频…`,
        percent: 20,
      });

      const ready = await adapter.fetchAudio(material, (done, total) => {
        this.webview.postMessage({
          type: 'progress',
          message: `下载音频 ${done}/${total}`,
          percent: 20 + Math.round((done / total) * 75),
        });
      });

      this.loadMaterial(ready);
      this.webview.postMessage({ type: 'progress', message: '就绪', percent: 100 });
      this.webview.postMessage({ type: 'done' });
    } catch (e) {
      this.webview.postMessage({ type: 'error', message: (e as Error).message });
    }
  }

  private pushMaterial(): void {
    if (!this.material) return;
    // 【现场取证】把推给 webview 的关键字段打进输出通道。
    // 排查「点击播放没反应」时，第一件事就是确认 audioUri 到底是什么。
    trace('[LT-TRACE] pushMaterial:');
    trace('[LT-TRACE]   title     = ' + this.material.title);
    trace('[LT-TRACE]   audioUri  = ' + this.audioUri);
    trace('[LT-TRACE]   sentences = ' + this.material.sentences?.length);
    trace('[LT-TRACE]   durationMs= ' + this.material.audio?.durationMs);
    trace('[LT-TRACE]   offsetMs  = ' + this.material.audio?.startOffsetMs);
    trace('[LT-TRACE]   rawPath   = ' + this.material.audio?.path);
    trace('[LT-TRACE]   format    = ' + this.material.audio?.format +
      '  (v3 起应为 m4a/MP4；aac=裸 ADTS 在 VS Code 里播不了)');

    this.webview.postMessage({
      type: 'material',
      material: {
        id: this.material.id,
        title: this.material.title,
        presenter: this.material.presenter,
        sentences: this.material.sentences,
        audioUri: this.audioUri,
        durationMs: this.material.audio?.durationMs,
        startOffsetMs: this.material.audio?.startOffsetMs ?? 0,
        // 页面据此挑 MIME（audio/aac vs audio/mp4）。
        // 传 null 时页面按 MP4 处理 —— v3 之后只会有 MP4。
        audioFormat: this.material.audio?.format ?? null,
      },
    });
  }

  /* ---------------- HTML ---------------- */

  private renderHtml(): string {
    // ⚠️⚠️ CSP 的坑（吃过三次亏，务必别改回去）
    //
    // 【坑 1】default-src 'none' 会把 VS Code 注入的基础样式表一起挡掉，
    //         表现是「样式全没了，退回浏览器默认 HTML 样式」。
    //         所以 style-src / script-src 必须带上 cspSource。
    //
    // 【坑 2】nonce 与 'unsafe-inline' 互斥！
    //         CSP 规范：只要 source list 里出现 nonce（或 hash），
    //         'unsafe-inline' 就被【完全忽略】。Chrome 会明确警告：
    //           "Note that 'unsafe-inline' is ignored if either a hash
    //            or nonce value is present in the source list."
    //         本页有 <style> 块 + 21 处内联 style="..." + JS 动态
    //         el.style.display 赋值，这些都只能靠 'unsafe-inline' 放行。
    //         既然本页无法改成纯 nonce 结构，就【必须放弃 nonce】。
    //
    // 【坑 3】media-src 要放行 cspSource + blob: + data:，
    //         否则 <audio src> 被挡住 → MEDIA_ERR_SRC_NOT_SUPPORTED。
    //         blob: 是「显式 MIME 降级路线」的前提。
    //
    // 结论：这里的 CSP 只负责「把资源限制在本地」这一件事，
    //       不对内联样式/脚本做强约束（webview 内容全部由扩展自己生成，
    //       不存在注入面，safe）。
    const csp = [
      `default-src 'none'`,
      `style-src ${this.webview.cspSource} 'unsafe-inline'`,
      `script-src ${this.webview.cspSource} 'unsafe-inline'`,
      `media-src ${this.webview.cspSource} blob: data:`,
      // img-src 放行 https:：「发现 TED」的封面图来自 TED 的多个 CDN 域
      //（pe.tedcdn.com / talkstar-photos.s3.amazonaws.com / talkstar-assets…），
      // 且域名可能变化，逐一枚举反而脆弱。图片是只读资源，风险可控。
      `img-src ${this.webview.cspSource} data: blob: https:`,
      `font-src ${this.webview.cspSource} data:`,
      `connect-src ${this.webview.cspSource} blob: data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Listen &amp; Write · 听写英语</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --panel: var(--vscode-sideBar-background);
    --border: var(--vscode-panel-border);
    --accent: var(--vscode-button-background);
    --accent-fg: var(--vscode-button-foreground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border);
    --muted: var(--vscode-descriptionForeground);
    --ok: #4ec9b0;
    --err: #f48771;
    --warn: #dcdcaa;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg); background: var(--bg);
    height: 100vh; display: flex; flex-direction: column;
  }
  .topbar {
    padding: 8px 12px; border-bottom: 1px solid var(--border);
    display: flex; gap: 8px; align-items: center; flex: 0 0 auto;
  }
  .topbar input {
    flex: 1; padding: 5px 8px; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 3px; outline: none;
    font-family: inherit; font-size: inherit;
  }
  button {
    padding: 5px 12px; background: var(--accent); color: var(--accent-fg);
    border: none; border-radius: 3px; cursor: pointer;
    font-family: inherit; font-size: inherit; white-space: nowrap;
  }
  button:hover { opacity: .9; }
  button.ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  button:disabled { opacity: .5; cursor: default; }

  .meta { padding: 8px 12px; border-bottom: 1px solid var(--border); flex: 0 0 auto; }
  .meta h2 { margin: 0 0 2px; font-size: 14px; font-weight: 600; }
  .meta .sub { color: var(--muted); font-size: 12px; }

  .main { flex: 1 1 auto; display: flex; min-height: 0; }

  /* 左：句子列表 */
  .list {
    flex: 1 1 45%; overflow-y: auto; border-right: 1px solid var(--border);
    padding: 4px 0;
  }
  .item {
    padding: 6px 12px; cursor: pointer; display: flex; gap: 8px;
    align-items: baseline; border-left: 2px solid transparent;
  }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.active { background: var(--vscode-list-activeSelectionBackground); border-left-color: var(--ok); }
  .item .idx { color: var(--muted); font-size: 11px; min-width: 26px; }
  .item .txt { flex: 1; line-height: 1.4; }

  /* 右：练习区 */
  .practice { flex: 1 1 55%; display: flex; flex-direction: column; padding: 12px; gap: 10px; overflow-y: auto; }
  .player { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .player .pos { color: var(--muted); font-size: 12px; margin-left: auto; }
  .answer {
    padding: 10px; border-radius: 4px; background: var(--panel);
    border: 1px solid var(--border); line-height: 1.6;
  }
  .answer .lbl { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
  textarea {
    width: 100%; min-height: 64px; padding: 8px; resize: vertical;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 3px;
    font-family: inherit; font-size: inherit; line-height: 1.5; outline: none;
  }
  .diff { line-height: 2; font-size: 14px; }
  .diff .equal { color: var(--ok); }
  .diff .missing {
    color: var(--err); text-decoration: underline;
    text-decoration-style: wavy; background: rgba(244,135,113,.1);
  }
  .diff .misheard { color: var(--warn); background: rgba(220,220,170,.12); padding: 0 3px; border-radius: 2px; }
  .diff .spelling { color: var(--warn); border-bottom: 1px dotted var(--warn); }
  .diff .extra { color: var(--muted); text-decoration: line-through; }
  .legend { display: flex; gap: 12px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
  .legend i { font-style: normal; }

  .hint { color: var(--muted); font-size: 12px; }
  .bar { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; }
  .bar > div { height: 100%; width: 0; background: var(--accent); transition: width .2s; }

  .player-err {
    display: none; margin-top: 8px; padding: 8px 10px;
    border-radius: 3px; font-size: 12px; line-height: 1.5;
    color: var(--err);
    background: rgba(244,135,113,.1);
    border: 1px solid var(--err);
  }

  .report { padding: 12px; }
  .report table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .report td, .report th { padding: 4px 8px; border-bottom: 1px solid var(--border); text-align: left; }
  .center { text-align: center; color: var(--muted); padding: 40px 20px; }

  /* ---- 视图容器：练习(#root) / 发现 TED(#discover) / 素材库(#library) ----
   *
   * ★ 高度链的关键：body 是 100vh flex column，三个视图作为 flex 子项
   *   必须各自 flex:1 + min-height:0 + overflow:hidden，
   *   否则 #root 高度随内容增长 → 整页滚动 → .main/.list 的内部滚动
   *   永不触发 → 列表一滚就把 practice 的操作栏滚出视野
   *   （2026-09-18 侧边栏实测，根因就是缺 #root 这层规则）。
   *   视图互斥用 .visible 类控制，JS 统一走 showView()。
   */
  #root {
    display: none;
    flex: 1 1 auto; min-height: 0; overflow: hidden;
    flex-direction: column;
  }
  #root.visible { display: flex; }

  /* ---- 字幕列表收缩 ---- */
  .main.collapsed .list { display: none; }
  .main.collapsed .practice { flex: 1 1 100%; }
  .list-toggle {
    flex: 0 0 auto; width: 18px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; color: var(--muted);
    border-right: 1px solid var(--border);
    user-select: none; font-size: 12px;
  }
  .list-toggle:hover { color: var(--fg); background: rgba(128,128,128,.12); }

  /* ---- 「发现 TED」视图 ---- */
  .discover { display: none; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px; gap: 8px; }
  .discover.visible { display: flex; }
  .disc-bar { display: flex; gap: 6px; }
  .disc-bar select { flex: 0 0 auto; }
  .disc-bar input { flex: 1 1 auto; }
  .disc-url { display: flex; gap: 6px; }
  .disc-url input { flex: 1 1 auto; }
  .disc-meta { color: var(--muted); font-size: 11px; }
  .disc-card {
    display: flex; gap: 8px; padding: 6px;
    border: 1px solid var(--border); border-radius: 4px;
    cursor: pointer; align-items: center;
  }
  .disc-card:hover { border-color: var(--accent); }
  .disc-card img { width: 96px; height: 54px; object-fit: cover; border-radius: 3px; flex: 0 0 auto; background: rgba(128,128,128,.15); }
  .disc-card .t { font-size: 12px; font-weight: 600; line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .disc-card .m { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .disc-foot { display: flex; gap: 6px; justify-content: center; padding: 6px 0; }

  /* ---- 「素材库」视图（已缓存素材）---- */
  .library { display: none; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px; gap: 8px; }
  .library.visible { display: flex; }
  .lib-card {
    padding: 8px; margin-bottom: 6px;
    border: 1px solid var(--border); border-radius: 4px; cursor: pointer;
  }
  .lib-card:hover { border-color: var(--accent); }
  .lib-card .t {
    font-weight: 600; font-size: 12px; line-height: 1.35;
    display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden;
  }
  .lib-card .meta { margin-top: 4px; color: var(--muted); font-size: 11px; padding: 0; border: none; }
  .badge {
    display: inline-block; padding: 1px 5px;
    margin-left: 4px; border-radius: 8px;
    font-size: 10px; vertical-align: middle;
  }
  .badge.ok { color: var(--ok); border: 1px solid currentColor; }
  .badge.no { color: var(--muted); border: 1px dashed currentColor; }
  .lib-card.selected { border-color: var(--accent); background: rgba(128,128,128,.08); }
  .lib-card > div { flex: 1 1 auto; min-width: 0; }
  .lib-del {
    flex: 0 0 auto; padding: 4px 6px; font-size: 12px;
    background: transparent; color: var(--muted);
    border: 1px solid var(--border); border-radius: 3px;
  }
  .lib-del:hover { color: var(--err); border-color: var(--err); }
  .lib-mark { font-size: 16px; color: var(--accent); min-width: 22px; text-align: center; }
</style>
</head>
<body>

<div class="topbar">
  <button id="discoverBtn" class="ghost">发现 TED</button>
  <button id="libraryBtn" class="ghost">素材库</button>
  <button id="report" class="ghost">诊断报告</button>
</div>

<div id="root" class="visible">
  <div class="center" id="empty">
    点上方「发现 TED」浏览站内演讲，或从「素材库」继续上次的练习
  </div>
</div>

<div id="discover" class="discover">
  <div class="disc-bar">
    <select id="discSort">
      <option value="popular">最热门</option>
      <option value="relevance">相关度</option>
      <option value="newest">最新</option>
      <option value="oldest">最早</option>
    </select>
    <input id="discQuery" placeholder="搜索 TED 演讲…" />
    <button id="discGo" class="ghost">搜索</button>
  </div>
  <div class="disc-url">
    <input id="url" placeholder="或直接粘贴 TED talk 链接后回车…" />
    <button id="load" class="ghost">加载</button>
  </div>
  <div class="disc-meta" id="discMeta"></div>
  <div id="discList"></div>
  <div class="disc-foot" id="discFoot"></div>
</div>

<div id="library" class="library">
  <div class="disc-bar" id="libBar"></div>
  <div class="disc-meta" id="libMeta">读取中…</div>
  <div id="libList"></div>
  <div class="disc-foot" id="libFoot"></div>
</div>

<audio id="player" preload="auto"></audio>

<script>
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const player = document.getElementById('player');

// 当前 player 上真正生效的 src，以及它对应的逻辑 Uri（可能是 blob:）。
// 用于避免重复加载同一素材，也用于在切换 Blob 路线时回收旧的 objectURL。
let activeSrc = null;
let lastLoadedUrl = null;

// 页面内日志回传到宿主输出通道。
// 排查音频加载时，宿主侧必须能看到「哪条路线、什么错误码、多少毫秒」。
function pageLog() {
  try {
    const parts = Array.prototype.slice.call(arguments).map(function (a) {
      if (a instanceof Error) return a.message;
      if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch (e) { return String(a); } }
      return String(a);
    });
    vscode.postMessage({ type: 'log', text: parts.join(' ') });
  } catch (e) { /* 日志失败不能影响主流程 */ }
}

// 音频元素自身的错误必须暴露出来。
// <audio> 加载失败时没有任何视觉反馈，表现为「点了播放没反应」。
// 注意：code=4 (SRC_NOT_SUPPORTED) 多数情况不是「格式不支持」，
// 而是资源没被正确交付（CSP / Content-Type / 路径）—— 见下方降级链。
player.addEventListener('error', () => {
  const err = player.error;
  let detail = '未知错误';
  if (err) {
    const names = {
      1: 'MEDIA_ERR_ABORTED 加载被中止',
      2: 'MEDIA_ERR_NETWORK 网络错误',
      3: 'MEDIA_ERR_DECODE 解码错误（文件可能损坏）',
      4: 'MEDIA_ERR_SRC_NOT_SUPPORTED 格式或路径不受支持',
    };
    detail = names[err.code] || ('code=' + err.code);
  }
  // ★ src 归属检查：error 必须属于「当前生效源」才值得打扰用户。
  //
  //   ensurePlayerSource 的三条路线都复用同一个 player 元素，
  //   路线 1/2 的探测失败是【预期内的】——流程内部有自己的 onErr 捕获
  //   并继续尝试下一条路线。但挂在这个元素上的全局监听也会同时收到
  //   error，如果无条件弹 toast，就会出现「页面一打开先闪一下报错、
  //   随后路线 3 成功又恢复正常」的假警报（2026-09-18 实测）。
  //
  //   判据：error 触发时 currentSrc 指向的是失败的那个资源；
  //   它若不是当前生效源（activeSrc），说明只是探测/换源中间态。
  const failedSrc = player.currentSrc || '';
  const isActive = !!activeSrc && failedSrc === activeSrc;
  if (!isActive) {
    pageLog('[LT-PAGE] 忽略非当前源的 error（探测/换源中间态）：failedSrc =',
      failedSrc || '(空)', '| detail =', detail);
    console.log('[listening-trainer] 过渡性 audio error（不弹提示）', detail, failedSrc);
    return;
  }
  showPlayerError(detail);
  console.error('[listening-trainer] audio error', err);
});

let state = {
  material: null,
  currentIndex: 0,
  results: {},
  rate: 1,
  loop: false,
  listCollapsed: false,
};

document.getElementById('load').onclick = () => {
  const v = document.getElementById('url').value.trim();
  if (v) { showProgress('加载中…'); vscode.postMessage({ type: 'loadFromInput', input: v }); }
};
document.getElementById('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('load').click();
});
document.getElementById('report').onclick = () => vscode.postMessage({ type: 'requestReport' });

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'material') { state.material = msg.material; state.currentIndex = 0; render(); }
  if (msg.type === 'checkResult') { state.results[msg.result.sentenceIndex] = msg.result; render(); }
  if (msg.type === 'progress') { showProgress(msg.message, msg.percent); }
  if (msg.type === 'done') { render(); }
  if (msg.type === 'error') { showError(msg.message); }
  if (msg.type === 'report') { renderReport(msg.report); }
  if (msg.type === 'audioBytes') { onAudioBytes(msg); }
  if (msg.type === 'pausePlayback') {
    // 侧边栏收起时宿主发来 —— 音频不会因 webview 隐藏而自己停
    try { player.pause(); } catch (err) { /* 未初始化时忽略 */ }
  }
  if (msg.type === 'tedResults') { onTedResults(msg); }
  if (msg.type === 'cachedList') { onCachedList(msg); }
  if (msg.type === 'materialRemoved') {
    // 正在练习的素材被删除：停播并清空界面
    try { player.pause(); } catch (err) { /* 忽略 */ }
    state.material = null;
    activeSrc = null; lastLoadedUrl = null;
    root.innerHTML =
      '<div class="center">该素材已被删除。<br>从「发现 TED」加载新素材，或在「素材库」选择其他素材继续。</div>';
  }
  // 加载流程开始/结束时都要回到练习视图（「发现 TED」只是浏览入口）
  if (msg.type === 'progress' || msg.type === 'done' || msg.type === 'error') {
    showPracticeView();
  }
});

/* ---------------- 「发现 TED」浏览/搜索 ---------------- */

const discView = document.getElementById('discover');
const libView = document.getElementById('library');
const libList = document.getElementById('libList');
const libMeta = document.getElementById('libMeta');
const discList = document.getElementById('discList');
const discMeta = document.getElementById('discMeta');
const discFoot = document.getElementById('discFoot');
const discQuery = document.getElementById('discQuery');
const discSort = document.getElementById('discSort');
let discState = { sort: 'popular', query: '', page: 0, nbPages: 0, reqId: 0, loading: false };

/* 三视图统一切换：practice / discover / library 互斥显示 */
const viewEls = {
  practice: document.getElementById('root'),
  discover: discView,
  library: libView,
};
let currentView = 'practice';
function showView(name) {
  currentView = name;
  for (const k of Object.keys(viewEls)) {
    viewEls[k].classList.toggle('visible', k === name);
  }
}
function showPracticeView() { showView('practice'); }

document.getElementById('discoverBtn').onclick = () => {
  if (currentView === 'discover') { showView('practice'); return; }
  showView('discover');
  if (!discList.children.length) discLoad(0);
};

document.getElementById('libraryBtn').onclick = () => {
  if (currentView === 'library') { showView('practice'); return; }
  showView('library');
  libMeta.textContent = '读取中…';
  libList.innerHTML = '';
  vscode.postMessage({ type: 'listCached' });
};

function discLoad(page) {
  if (discState.loading) return;
  discState.loading = true;
  discState.page = page;
  discState.reqId++;
  discMeta.textContent = '搜索中…';
  discFoot.innerHTML = '';
  vscode.postMessage({
    type: 'tedSearch',
    reqId: discState.reqId,
    query: discState.query,
    sort: discState.sort,
    page: page,
  });
}

function onTedResults(msg) {
  if (msg.reqId !== discState.reqId) return; // 只认最新一次请求
  discState.loading = false;
  if (msg.error) { discMeta.textContent = '搜索失败：' + msg.error; return; }

  discState.nbPages = msg.nbPages;
  discMeta.textContent = '共 ' + msg.nbHits + ' 个演讲 · 第 ' + (msg.page + 1) + ' / ' +
    msg.nbPages + ' 页';

  const hits = msg.hits || [];
  if (!hits.length) {
    discList.innerHTML = '<div class="center" style="padding:20px">没有匹配的演讲</div>';
    discFoot.innerHTML = '';
    return;
  }

  discList.innerHTML = hits.map((h) => {
    const img = h.thumb
      ? '<img src="' + esc(h.thumb) + '" loading="lazy">'
      : '<img src="" style="visibility:hidden">';
    return '<div class="disc-card" data-slug="' + esc(h.slug) + '">' + img +
      '<div><div class="t">' + esc(h.title) + '</div>' +
      '<div class="m">' + esc(h.speakers || '') +
      ' · ' + Math.round(h.durationSec / 60) + ' 分钟</div></div></div>';
  }).join('');

  discList.querySelectorAll('.disc-card').forEach((el) => {
    el.onclick = () => {
      const slug = el.dataset.slug;
      if (!slug) return;
      showPracticeView();
      vscode.postMessage({
        type: 'loadTedUrl',
        url: 'https://www.ted.com/talks/' + slug,
      });
    };
  });

  let foot = '';
  if (msg.page > 0) foot += '<button class="ghost" id="discPrev">上一页</button>';
  if (msg.page + 1 < msg.nbPages) foot += '<button class="ghost" id="discNext">下一页</button>';
  discFoot.innerHTML = foot;
  const prev = document.getElementById('discPrev');
  const next = document.getElementById('discNext');
  if (prev) prev.onclick = () => discLoad(msg.page - 1);
  if (next) next.onclick = () => discLoad(msg.page + 1);
}

document.getElementById('discGo').onclick = () => {
  discState.query = discQuery.value.trim();
  discState.sort = discSort.value;
  discLoad(0);
};
discQuery.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('discGo').click();
});
discSort.addEventListener('change', () => {
  discState.sort = discSort.value;
  discLoad(0);
});

/* ---------------- 「素材库」：已缓存素材 ---------------- */

let libState = { multi: false, selected: {} as Record<string, boolean> };
let lastCachedItems = [];

function renderLibBar() {
  const bar = document.getElementById('libBar');
  if (libState.multi) {
    bar.innerHTML =
      '<button id="libDoDelete">删除所选 (' + Object.keys(libState.selected).length + ')</button>' +
      '<button id="libCancelMulti" class="ghost">取消</button>';
    document.getElementById('libDoDelete').onclick = () => {
      const names = Object.keys(libState.selected);
      if (!names.length) return;
      if (!window.confirm('确定删除所选 ' + names.length + ' 个素材？\\n其音频缓存将一并删除，不可恢复。')) return;
      libState.multi = false;
      libState.selected = {};
      vscode.postMessage({ type: 'deleteCached', dirNames: names });
    };
    document.getElementById('libCancelMulti').onclick = () => {
      libState.multi = false;
      libState.selected = {};
      renderLib();
    };
  } else {
    bar.innerHTML =
      '<button id="libMulti" class="ghost">多选删除</button>' +
      '<button id="libDeleteAll" class="ghost">全部删除</button>';
    document.getElementById('libMulti').onclick = () => {
      libState.multi = true;
      libState.selected = {};
      renderLib();
    };
    document.getElementById('libDeleteAll').onclick = () => {
      if (!lastCachedItems.length) return;
      if (!window.confirm('确定删除全部 ' + lastCachedItems.length + ' 个素材？\\n其音频缓存将一并删除，不可恢复。')) return;
      vscode.postMessage({
        type: 'deleteCached',
        dirNames: lastCachedItems.map((it) => it.dirName),
      });
    };
  }
}

function onCachedList(msg) {
  if (msg.error) { libMeta.textContent = '读取缓存失败：' + msg.error; return; }
  lastCachedItems = msg.items || [];
  renderLibBar();

  if (!lastCachedItems.length) {
    libMeta.textContent = '还没有已缓存的素材。去「发现 TED」挑一篇开始。';
    libList.innerHTML = '';
    return;
  }
  libMeta.textContent = libState.multi
    ? '多选模式：点卡片勾选，然后点「删除所选」'
    : '已缓存 ' + lastCachedItems.length + ' 篇 · 点卡片继续练习';

  libList.innerHTML = lastCachedItems.map((it) => {
    const badge = it.hasAudio
      ? '<span class="badge ok">音频就绪</span>'
      : '<span class="badge no">缺音频</span>';
    let lead = '';
    if (libState.multi) {
      lead = '<span class="lib-mark">' + (libState.selected[it.dirName] ? '☑' : '☐') + '</span>';
    } else {
      lead = '<button class="lib-del" data-dirname="' + esc(it.dirName) + '" title="删除该素材">🗑</button>';
    }
    return '<div class="lib-card' + (libState.selected[it.dirName] ? ' selected' : '') +
      '" data-dirname="' + esc(it.dirName) + '">' + lead +
      '<div><div class="t">' + esc(it.title) + badge + '</div>' +
      '<div class="meta">' + it.sentenceCount + ' 句 · ' + fmtTime(it.durationMs) + '</div></div>' +
      '</div>';
  }).join('');

  libList.querySelectorAll('.lib-card').forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest('.lib-del')) return; // 删除按钮有自己的处理
      const dn = el.dataset.dirname;
      if (libState.multi) {
        if (libState.selected[dn]) delete libState.selected[dn];
        else libState.selected[dn] = true;
        renderLib();
      } else {
        showView('practice');
        vscode.postMessage({ type: 'openCached', dirName: dn });
      }
    };
  });
  libList.querySelectorAll('.lib-del').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      const dn = el.dataset.dirname;
      if (!window.confirm('确定删除该素材？\\n其音频缓存将一并删除，不可恢复。')) return;
      vscode.postMessage({ type: 'deleteCached', dirNames: [dn] });
    };
  });
}

/** 选中态/模式切换后用最近一次列表数据重渲染 */
function renderLib() {
  onCachedList({ items: lastCachedItems, error: null });
}

function showProgress(text, percent) {
  root.innerHTML =
    '<div class="center">' +
    '<div style="max-width:380px;margin:0 auto;">' +
    '<div class="hint" style="margin-bottom:8px;">' + esc(text) + '</div>' +
    '<div class="bar"><div style="width:' + (percent ?? 30) + '%"></div></div>' +
    '</div></div>';
}

function showError(text) {
  root.innerHTML =
    '<div class="center"><div style="max-width:460px;margin:0 auto;">' +
    '<div style="color:var(--err);margin-bottom:6px;">加载失败</div>' +
    '<div class="hint">' + esc(text) + '</div>' +
    '<div class="hint" style="margin-top:12px;">如果是网络问题，请在设置中配置 listeningTrainer.proxy</div>' +
    '</div></div>';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(ms) {
  if (ms == null) return '--:--';
  const s = Math.max(0, ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' +
         String(Math.floor(s % 60)).padStart(2, '0');
}

/* ---------------- 渲染 ---------------- */

function render() {
  const m = state.material;
  if (!m) return;

  root.innerHTML =
    '<div class="meta">' +
      '<h2>' + esc(m.title) + '</h2>' +
      '<div class="sub">' + esc(m.presenter || '') + ' · ' + m.sentences.length + ' 句 · ' +
        fmtTime(m.durationMs) + '</div>' +
    '</div>' +
    '<div class="main' + (state.listCollapsed ? ' collapsed' : '') + '">' +
      '<div class="list-toggle" id="listToggle" title="' +
        (state.listCollapsed ? '展开字幕列表' : '收起字幕列表') + '">' +
        (state.listCollapsed ? '»' : '«') + '</div>' +
      '<div class="list" id="list"></div>' +
      '<div class="practice" id="practice"></div>' +
    '</div>';

  renderList();
  renderPractice();

  // 字幕列表收缩开关：侧边栏/窄编辑器里收起后听写区独占整行
  document.getElementById('listToggle').onclick = () => {
    state.listCollapsed = !state.listCollapsed;
    render();
  };
}

function renderList() {
  const m = state.material;
  const list = document.getElementById('list');
  list.innerHTML = m.sentences.map((s, i) => {
    const r = state.results[i];
    const mark = r ? (r.correct ? '<span style="color:var(--ok)">✓</span>'
                               : '<span style="color:var(--err)">✗</span>') : '';
    return '<div class="item' + (i === state.currentIndex ? ' active' : '') + '" data-i="' + i + '">' +
      '<span class="idx">' + (i + 1) + '</span>' +
      '<span class="txt">' + esc(s.text) + '</span>' +
      '<span class="idx">' + mark + '</span>' +
    '</div>';
  }).join('');

  list.querySelectorAll('.item').forEach((el) => {
    el.onclick = () => {
      state.currentIndex = Number(el.dataset.i);
      render();
      playCurrent();
    };
  });

  const active = list.querySelector('.item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function renderPractice() {
  const m = state.material;
  const i = state.currentIndex;
  const s = m.sentences[i];
  if (!s) return;

  const r = state.results[i];
  const p = document.getElementById('practice');

  let diffHtml = '';
  if (r) {
    diffHtml = '<div class="answer"><div class="lbl">逐词对照 · 准确率 ' +
      Math.round(r.accuracy * 100) + '%</div><div class="diff">' +
      r.tokens.map((t) => {
        if (t.op === 'equal') return '<span class="equal">' + esc(t.expected) + '</span>';
        if (t.op === 'missing') return '<span class="missing">' + esc(t.expected) + '</span>';
        if (t.op === 'replace') {
          const cls = t.kind === 'spelling' ? 'spelling' : 'misheard';
          return '<span class="' + cls + '">' + esc(t.actual) + '</span>';
        }
        return '<span class="extra">' + esc(t.actual) + '</span>';
      }).join(' ') +
      '</div><div class="legend" style="margin-top:8px">' +
        '<i style="color:var(--err)">下划线=漏听</i>' +
        '<i style="color:var(--warn)">黄色=错听/拼写</i>' +
        '<i style="color:var(--muted)">删除线=多写</i>' +
        '<i style="color:var(--ok)">绿色=正确</i>' +
      '</div></div>';
  }

  p.innerHTML =
    '<div class="player">' +
      '<button id="play">▶ 播放</button>' +
      '<button id="prev" class="ghost">上一句</button>' +
      '<button id="next" class="ghost">下一句</button>' +
      '<button id="rate" class="ghost">' + state.rate + 'x</button>' +
      '<button id="loop" class="ghost">' + (state.loop ? '循环开' : '循环关') + '</button>' +
      '<button id="diag" class="ghost" title="诊断音频加载">🔧</button>' +
      '<span class="pos">' + (i + 1) + ' / ' + m.sentences.length +
        ' · ' + fmtTime(s.startMs) + '–' + fmtTime(s.endMs) + '</span>' +
    '</div>' +

    '<div class="answer" id="diagBox" style="display:none">' +
      '<div class="lbl">音频加载诊断</div>' +
      '<div id="diagContent" class="hint" style="white-space:pre-wrap;font-size:11px"></div>' +
      '<div class="player" style="margin-top:8px">' +
        '<button id="diagBlob" class="ghost">用 Blob 重载</button>' +
        '<button id="diagData" class="ghost">用 DataURI 重载</button>' +
      '</div>' +
    '</div>' +

    '<textarea id="input" placeholder="听写这一句，按 Ctrl+Enter 检查…">' +
      esc(state.results[i] ? state.results[i].raw : '') + '</textarea>' +
    '<div class="player">' +
      '<button id="check">检查 (Ctrl+Enter)</button>' +
      '<button id="reveal" class="ghost">看答案</button>' +
      '<button id="replay" class="ghost">⟲ 重播</button>' +
    '</div>' +

    '<div class="answer" id="answerBox" style="display:none">' +
      '<div class="lbl">标准答案</div>' + esc(s.text) +
      (s.translation ? '<div class="lbl" style="margin-top:8px">译文</div>' + esc(s.translation) : '') +
    '</div>' +

    diffHtml;

  document.getElementById('play').onclick = playCurrent;
  document.getElementById('replay').onclick = playCurrent;
  document.getElementById('prev').onclick = () => { if (i > 0) { state.currentIndex = i - 1; render(); playCurrent(); } };
  document.getElementById('next').onclick = () => { if (i < m.sentences.length - 1) { state.currentIndex = i + 1; render(); playCurrent(); } };
  document.getElementById('rate').onclick = () => {
    const rates = [1, 0.75, 0.5, 1.25];
    state.rate = rates[(rates.indexOf(state.rate) + 1) % rates.length];
    player.playbackRate = state.rate;
    render();
  };
  document.getElementById('loop').onclick = () => {
    state.loop = !state.loop;
    player.loop = state.loop;
    render();
  };
  document.getElementById('reveal').onclick = () => {
    const b = document.getElementById('answerBox');
    b.style.display = b.style.display === 'none' ? 'block' : 'none';
  };
  document.getElementById('check').onclick = doCheck;

  document.getElementById('diag').onclick = () => {
    const box = document.getElementById('diagBox');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
    if (box.style.display === 'block') runDiag();
  };
  document.getElementById('diagBlob').onclick = () => reloadAsBlob();
  document.getElementById('diagData').onclick = () => reloadAsDataUri();

  const ta = document.getElementById('input');
  ta.focus();
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doCheck(); }
  });

  player.playbackRate = state.rate;
  player.loop = state.loop;
}

function doCheck() {
  const ta = document.getElementById('input');
  if (!ta) return;
  vscode.postMessage({
    type: 'check',
    sentenceIndex: state.currentIndex,
    input: ta.value,
  });
}

/* ---------------- 播放 ---------------- */

function showPlayerError(text) {
  // 播放错误必须可见 —— 早期用 .catch(() => {}) 静默吞掉，
  // 结果「点击播放没反应」完全无从排查。
  let box = document.getElementById('playerErr');
  if (!box) {
    box = document.createElement('div');
    box.id = 'playerErr';
    box.className = 'player-err';
    const p = document.getElementById('practice');
    if (p) p.appendChild(box);
  }
  box.textContent = '播放失败：' + text;
  box.style.display = 'block';
}

function clearPlayerError() {
  const box = document.getElementById('playerErr');
  if (box) box.style.display = 'none';
}

/**
 * 确保 player 能加载到音频源，返回可用的 src；全失败返回 null。
 *
 * ⚠️ 实测教训（2026-09-18，务必别改回「用一次性 Audio 探测」的写法）：
 *
 * 1. 不要为探测新建 Audio()。Chromium 对媒体加载有全局并发限制，
 *    连续创建多个 Audio 元素会互相饿死 —— 表现为「所有路线都 40s 超时」，
 *    而单独测同一个文件却只要 30ms。探测必须复用同一个 player 元素。
 *
 * 2. 不要用 a.onloadedmetadata = fn 这种 on* 属性赋值。
 *    实测同一文件：on* 属性写法超时，addEventListener 30ms 成功。
 *    on* 属性会被后续赋值覆盖，在复用元素时尤其不可靠。
 *    一律用 addEventListener。
 *
 * 3. fetch 成功 ≠ 音频能播。fetch 只验证「字节可读」，
 *    真正的判据是媒体元素的 loadedmetadata。
 *
 * 【注意】上面原本用反引号包住 on* ，导致 TS 把反引号当成模板字符串定界符，
 * 出现「奇数个反引号」后整个注释块被误解析（TS1005 连锁报错）。
 * 注释里不要用反引号。（同理，本文件下方 JS 字符串里的 \\n 必须双反斜杠。）
 */

/**
 * 当前素材应有的音频 MIME。
 *
 * ⚠️ 不要写死 audio/aac。
 *   v3 起宿主产出的是 MP4 容器（.m4a）。给 MP4 字节贴 audio/aac 标签，
 *   虽然多数情况浏览器仍会嗅探内容，但这是把「容器」和「编码」混为一谈 ——
 *   一旦宿主换了容器而这里没跟着改，就会出现「字节正确但解不开」的
 *   极难排查的问题（正是本文件反复踩的坑）。
 *   MIME 必须与实际容器一致：MP4 → audio/mp4，裸 ADTS → audio/aac。
 */
function audioMime() {
  const f = state.material && state.material.audioFormat;
  // v5 起最终产物是 MP3（因为 VS Code 的 ffmpeg 没有 AAC 解码器）。
  // 仍保留 aac/mp4 分支：万一上游换了源或旧缓存漏网，MIME 至少要跟容器一致。
  if (f === 'aac') return 'audio/aac';
  if (f === 'mp3') return 'audio/mpeg';
  return 'audio/mp4';
}

async function ensurePlayerSource(uri) {
  if (lastLoadedUrl === uri && activeSrc) return activeSrc;

  pageLog('[LT-PAGE] ensurePlayerSource 入参 uri =', uri);

  // 路线 1：直接把这个地址交给 player（asWebviewUri 本身是合法的 webview 资源 URL）
  const r1 = await loadIntoPlayer(uri);
  pageLog('[LT-PAGE] 路线1 直链结果 =', r1);
  if (r1.ok) {
    activeSrc = uri; lastLoadedUrl = uri;
    clearPlayerError();
    return uri;
  }

  // 路线 2：fetch 成 Blob，显式声明 MIME
  // （应对 asWebviewUri 未携带正确 Content-Type 的情况）
  try {
    const res = await fetch(uri);
    pageLog('[LT-PAGE] 路线2 fetch status =', res.status, 'ok =', res.ok, 'ct =', res.headers.get('content-type'));
    if (res.ok) {
      const ab = await res.arrayBuffer();
      pageLog('[LT-PAGE] 路线2 读到字节 =', ab.byteLength);
      const blob = new Blob([ab], { type: audioMime() });
      const burl = URL.createObjectURL(blob);
      const r2 = await loadIntoPlayer(burl);
      pageLog('[LT-PAGE] 路线2 Blob 结果 =', r2);
      if (r2.ok) {
        if (activeSrc && activeSrc.startsWith('blob:')) URL.revokeObjectURL(activeSrc);
        activeSrc = burl; lastLoadedUrl = uri;
        clearPlayerError();
        return burl;
      }
      URL.revokeObjectURL(burl);
    }
  } catch (e) {
    pageLog('[LT-PAGE] 路线2 异常:', e);
  }

  // ★ 路线 3（终极兜底）：请扩展宿主直接读文件，把字节传过来。
  //   实测 asWebviewUri 产出的 vscode-cdn.net 地址会被资源服务 401 拒绝
  //   （fetch 拿到 12 字节 "Unauthorized"，audio 报 code=4）。
  //   走宿主 fs 完全绕开 webview 的 CDN 权限层。
  const r3 = await loadViaHostBytes(uri);
  pageLog('[LT-PAGE] 路线3 宿主字节结果 =', r3);
  if (r3.ok) {
    activeSrc = r3.src; lastLoadedUrl = uri;
    clearPlayerError();
    return r3.src;
  }

  return null;
}

/**
 * 路线 3：向宿主索要音频字节，转成 Blob URL。
 *
 * 这是绕开 webview 资源协议 401 的最后手段。
 * 时序：postMessage 请求 -> 等 audioBytes 回包 -> 建 Blob -> 装进 player。
 */
function loadViaHostBytes(uri) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; cleanup(); resolve(r); } };

    const onBytes = (msg) => {
      if (msg.error) { finish({ ok: false, why: 'host-error: ' + msg.error }); return; }
      try {
        const b64 = String(msg.base64 || '');
        pageLog('[LT-PAGE] 路线3 收到 base64 长度 =', b64.length, '| 声明字节数 =', msg.bytes);
        const bin = atob(b64);
        const len = bin.length;
        const u8 = new Uint8Array(len);
        for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
        // ★ 关键自检：把还原后的实际字节数和首字节打出来。
        //   如果 len 与 msg.bytes 不符，说明 base64 传输被截断了。
        pageLog('[LT-PAGE] 路线3 还原字节 =', len,
          '| 声明 =', msg.bytes,
          '| 一致 =', len === msg.bytes,
          '| 首4字节 =', Array.from(u8.slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' '));
        // 容器自检：v5 起宿主传来的是 MP3（首 2 字节 0xFFF 同步字或 'ID3'），
        // 也报 ADTS / MP4 以便定位缓存代际问题。
        const isAdts = u8.length > 2 && u8[0] === 0xff && (u8[1] & 0xf0) === 0xf0;
        const isMp4 = u8.length > 12 && String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) === 'ftyp';
        const isMp3 = u8.length > 2 && String.fromCharCode(u8[0], u8[1], u8[2]) === 'ID3'
          ? true
          : u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0;
        pageLog('[LT-PAGE] 路线3 容器自检 MP3 =', isMp3, '| ADTS =', isAdts, '| MP4(ftyp) =', isMp4);
        if (isMp3) {
          pageLog('[LT-PAGE] 收到 MP3 ✓（v5 产物，VS Code 有 mp3 解码器）');
        } else if (isMp4) {
          pageLog('[LT-PAGE] ⚠️ 收到 MP4(M4A) —— 缓存代际过旧（v3/v4），' +
            'VS Code 内置 ffmpeg 无 AAC 解码器，必然报 NO_SUPPORTED_STREAMS。请重载素材触发 v5 转码。');
        } else if (isAdts && !isMp4) {
          pageLog('[LT-PAGE] ⚠️ 收到裸 ADTS —— VS Code 内置 ffmpeg 无 ADTS 解复用器，' +
            '必然报 DEMUXER_ERROR_COULD_NOT_OPEN。请清掉旧缓存（cacheVersion < 3）重新下载。');
        }
        const blob = new Blob([u8], { type: audioMime() });
        pageLog('[LT-PAGE] 路线3 Blob size =', blob.size, '| type =', blob.type);
        const burl = URL.createObjectURL(blob);
        loadIntoPlayer(burl).then((r) => {
          if (r.ok) {
            if (activeSrc && activeSrc.startsWith('blob:')) URL.revokeObjectURL(activeSrc);
            finish({ ok: true, src: burl, bytes: len });
          } else {
            URL.revokeObjectURL(burl);
            finish({ ok: false, why: 'blob-load-failed', detail: r, blobSize: blob.size, blobType: blob.type, decoded: len, declared: msg.bytes });
          }
        });
      } catch (e) {
        finish({ ok: false, why: 'decode-error: ' + (e && e.message ? e.message : e) });
      }
    };

    const cleanup = () => { window.removeEventListener('message', handler); clearTimeout(timer); };
    const handler = (e) => {
      const m = e.data;
      if (m && m.type === 'audioBytes') onBytes(m);
    };
    const timer = setTimeout(() => finish({ ok: false, why: 'host-timeout' }), 20000);

    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'requestAudioBytes' });
  });
}

/**
 * 把地址装进 player 并等待 loadedmetadata。
 *
 * 复用 player 而不是新建 Audio —— 见 ensurePlayerSource 的注释。
 * 用 addEventListener（不是 on* 属性），并在结束后移除监听，避免泄漏。
 */
function loadIntoPlayer(url) {
  return new Promise((resolve) => {
    let settled = false;
    const t0 = Date.now();

    const cleanup = () => {
      player.removeEventListener('loadedmetadata', onOk);
      player.removeEventListener('error', onErr);
      player.removeEventListener('stalled', onStall);
    };
    const finish = (ok, why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      // 把本次耗时也带上：错误如果发生在 0-3ms 内，多半是「旧状态污染」
      // 而非真的尝试加载后失败。
      resolve({
        ok, why,
        ms: Date.now() - t0,
        code: player.error ? player.error.code : null,
        errMsg: player.error ? String(player.error.message || '') : null,
        rs: player.readyState,
        ns: player.networkState,
      });
    };
    const onOk = () => finish(true, 'loadedmetadata');
    // 复用一个元素时，上一次的 error 有残留风险；这里只认「本次」的结果
    const onErr = () => finish(false, 'error');
    const onStall = () => { /* 仅观察，不据此失败 */ };

    // 8MB / 500s 的音频，本地加载应在 1s 内完成；给 10s 足够宽裕
    // （19MB / 19min 的文件也在这个量级内）
    const timer = setTimeout(() => finish(false, 'timeout'), 10000);

    // ⚠️ 复用元素时必须先彻底清空旧源，否则旧源的错误/状态会污染本次判断。
    //    player.error 在换源后不一定立刻重置，可能出现「code 是上一次的」。
    //    先移除 src 再 load()，确保错误状态被清掉。
    try {
      player.removeAttribute('src');
      player.load();
    } catch (e) { /* 忽略 */ }

    player.addEventListener('loadedmetadata', onOk);
    player.addEventListener('error', onErr);
    player.addEventListener('stalled', onStall);

    player.preload = 'auto';
    player.src = url;
    player.load();

    // 已就绪（复用同一 src 时可能同步命中）
    if (player.readyState >= 1 && player.duration > 0) finish(true, 'already-ready');
  });
}

async function playCurrent() {
  const m = state.material;
  const s = m && m.sentences[state.currentIndex];
  if (!s) return;
  if (!m.audioUri) {
    showPlayerError('音频未就绪（缺少 audioUri）。请重新加载素材。');
    return;
  }

  const src = await ensurePlayerSource(m.audioUri);
  if (!src) {
    // ⚠️ 这里的 \\n 必须双反斜杠！外层是 TS 模板字符串，
    //    单反斜杠会被展开成真实换行 -> 生成的 JS 跨行 -> SyntaxError -> 整页失效。
    //
    // 失败提示要带上「容器」这一维度：本项目的核心坑就是
    // 「字节没问题、MIME 没问题，但容器是裸 ADTS → VS Code 解不开」。
    // 如果缓存还是旧版（cacheVersion<3），这里直接点明，省去一轮排查。
    const stale = m.audioFormat && m.audioFormat !== 'm4a';
    showPlayerError(
      '音频无法加载（直链 / Blob / 宿主字节三条路线均失败）。\\n' +
      (stale
        ? '当前容器是「' + m.audioFormat + '」，而 VS Code 内置 ffmpeg 不支持裸 ADTS。\\n' +
          '→ 这是旧版缓存，删除该素材后重新加载即可（v3 起改为 MP4 容器）。\\n'
        : '') +
      '直链: ' + m.audioUri + '\\n' +
      '请点 🔧 查看诊断详情（含容器判定与播放器能力），' +
      '并把扩展宿主输出里的 [LT-TRACE] 行发出来。'
    );
    return;
  }

  // ⚠️ 不要用 player.src !== src 判断是否要重新 load。
  //    player.src 是浏览器「绝对化」后的值，vscode-webview:// 这类自定义协议
  //    规范化后可能与传入值不一致，导致刚加载好的元数据被无谓丢弃，
  //    进而 currentTime 赋值落在 HAVE_NOTHING 状态被静默忽略 ——
  //    表现就是「点了播放没反应/从头播」。
  //    用 currentSrc 或直接比较 activeSrc，且只在确实没加载好时才 load。
  const alreadyLoaded = (player.currentSrc && player.currentSrc === src) ||
                        (player.readyState >= 1 && lastLoadedUrl === m.audioUri);
  if (!alreadyLoaded) {
    pageLog('[LT-PAGE] player 未就绪，重新 load。currentSrc =', player.currentSrc, '| target =', src);
    player.src = src;
    player.load();
  }

  const start = s.startMs / 1000;
  const end = s.endMs / 1000;

  const seekAndPlay = () => {
    // ⚠️ seek 目标必须落在 seekable 范围内，否则赋值被静默忽略。
    //    seekable 可能还没就绪（length=0），此时不要硬赋，退回 0。
    let target = start;
    try {
      const sk = player.seekable;
      if (sk && sk.length > 0) {
        const lo = sk.start(0);
        const hi = sk.end(0);
        if (target < lo) target = lo;
        if (target > hi) target = hi;
      } else if (player.readyState < 1) {
        // 元数据还没到，赋值会被忽略；等下一次 loadedmetadata 再试
        pageLog('[LT-PAGE] seekable 未就绪(rs=' + player.readyState + ')，延后 seek');
        player.addEventListener('loadedmetadata', function once() {
          player.removeEventListener('loadedmetadata', once);
          seekAndPlay();
        });
        return;
      }
      pageLog('[LT-PAGE] seek 到 ' + target + 's (seekable len=' + (sk ? sk.length : -1) + ', rs=' + player.readyState + ')');
      player.currentTime = target;
    } catch (e) {
      showPlayerError('定位失败：' + (e && e.message ? e.message : e));
      return;
    }
    player.play().then(clearPlayerError).catch((e) => {
      showPlayerError(
        (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : e) +
        '  ｜ 音频文件本身已验证完整，若仍失败请点 🔧 查看加载路线诊断'
      );
    });
  };

  // readyState>=1 不代表 seekable 已就绪；至少等到 metadata 后再 seek
  if (player.readyState >= 1 && player.seekable && player.seekable.length > 0) {
    seekAndPlay();
  } else {
    player.addEventListener('loadedmetadata', seekAndPlay, { once: true });
    player.addEventListener('canplay', seekAndPlay, { once: true });
  }

  // 自动停在句尾
  if (player._stopTimer) clearInterval(player._stopTimer);
  player._stopTimer = setInterval(() => {
    if (!player.paused && player.currentTime >= end) {
      player.pause();
      if (state.loop) { player.currentTime = start; player.play().catch(() => {}); }
      clearInterval(player._stopTimer);
    }
  }, 50);
}

/* ---------------- 音频加载诊断 ---------------- */

function diagLog(lines) {
  const el = document.getElementById('diagContent');
  if (el) el.textContent = lines.join('\\n');
}

/**
 * 探测给定 URL 能否被 <audio> 加载
 *
 * 关键：区分「网络/权限层失败」与「解码层失败」。
 * fetch 失败 → 资源被拒（路径/CSP 问题）
 * fetch 成功但 audio 报错 → 格式/解码问题
 */
function probeUrl(url) {
  return new Promise((resolve) => {
    const out = { url: url.length > 90 ? url.slice(0, 90) + '…' : url, fetch: '-', mime: '-', audio: '-' };
    fetch(url)
      .then((r) => {
        out.fetch = r.status + (r.ok ? ' ok' : ' !ok');
        out.mime = r.headers.get('content-type') || '(无)';
        return r.arrayBuffer();
      })
      .then((ab) => {
        out.bytes = ab.byteLength;
        const head = new Uint8Array(ab.slice(0, 4));
        out.magic = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join(' ');
        return new Promise((res) => {
          // ⚠️ 探测也复用主 player，不要新建 Audio 元素。
          //    Chromium 对媒体加载有全局并发限制，新建元素会互相饿死。
          const a = player;
          let settled = false;
          const done = (v) => {
            if (settled) return;
            settled = true;
            clearTimeout(t);
            a.removeEventListener('loadedmetadata', onOk);
            a.removeEventListener('error', onErr);
            res(v);
          };
          const onOk = () => done('ok dur=' + a.duration.toFixed(2) + 's');
          const onErr = () => done('ERR code=' + (a.error && a.error.code));
          const t = setTimeout(() => done('timeout'), 8000);
          a.addEventListener('loadedmetadata', onOk);
          a.addEventListener('error', onErr);
          a.preload = 'auto';
          a.src = url;
          a.load();
        });
      })
      .then((v) => { out.audio = v; resolve(out); })
      .catch((e) => { out.fetch = 'THROW ' + (e && e.message ? e.message : e); resolve(out); });
  });
}

async function runDiag() {
  const m = state.material;
  if (!m) return;
  diagLog(['探测中…']);
  const lines = [];
  lines.push('音频地址: ' + (m.audioUri || '(空)'));
  lines.push('容器格式: ' + (m.audioFormat || '(未知，按 MP4 处理)'));
  lines.push('');

  // 先给出「环境结论」——VS Code 内置 ffmpeg 与完整 Chrome 不同，
  // 这是本项目最反直觉的一点，写在报告最前面能省掉大量来回排查。
  const canAac = player.canPlayType('audio/aac');
  const canMp4 = player.canPlayType('audio/mp4');
  lines.push('【播放器能力声明】');
  lines.push('  canPlayType(audio/aac) = ' + (canAac || '(空)'));
  lines.push('  canPlayType(audio/mp4) = ' + (canMp4 || '(空)'));
  lines.push('  说明: VS Code 的 webview 用内置裁剪版 ffmpeg.dll，');
  lines.push('        它没有独立 ADTS 解复用器 → 裸 .aac 会报');
  lines.push('        DEMUXER_ERROR_COULD_NOT_OPEN。v3 起改为 MP4 容器规避。');
  lines.push('');

  if (m.audioUri) {
    const r = await probeUrl(m.audioUri);
    lines.push('【路线 1：asWebviewUri 直链】');
    lines.push('  fetch     : ' + r.fetch);
    lines.push('  content-type: ' + r.mime);
    lines.push('  字节数    : ' + (r.bytes ?? '-'));
    lines.push('  首 4 字节 : ' + (r.magic ?? '-'));
    // magic 判容器：ADTS 是 ff f?，MP4 是 ?? ?? ?? ?? 'ftyp'
    if (r.magic) {
      const h = r.magic.split(' ').map((x) => parseInt(x, 16));
      const adts = h[0] === 0xff && (h[1] & 0xf0) === 0xf0;
      lines.push('  容器判定  : ' + (adts ? '裸 ADTS（VS Code 播不了）' : '非 ADTS（可能是 MP4）'));
    }
    lines.push('  audio 加载: ' + r.audio);
    lines.push('');
    lines.push('【路线 3：宿主直读字节（绕开 webview 资源协议）】');
    const r3 = await loadViaHostBytes(m.audioUri);
    lines.push('  结果      : ' + (r3.ok ? '✅ 成功' : '❌ ' + (r3.why || '失败')));
    if (r3.bytes != null) lines.push('  还原字节数: ' + r3.bytes);
    if (r3.decoded != null) lines.push('  解码后长度: ' + r3.decoded);
    if (r3.declared != null) lines.push('  宿主声明长度: ' + r3.declared);
    if (r3.blobSize != null) lines.push('  Blob size : ' + r3.blobSize + ' | type = ' + r3.blobType);
    if (r3.detail) {
      lines.push('  详情      : ' + JSON.stringify(r3.detail));
      // 把最关键的判据单独拎出来，避免被 JSON 淹没
      lines.push('  ↳ 失败原因: ' + (r3.detail.why || '?') +
        ' | 耗时=' + r3.detail.ms + 'ms' +
        ' | readyState=' + r3.detail.rs +
        ' | networkState=' + r3.detail.ns +
        ' | code=' + r3.detail.code);
      if (r3.detail.ms != null && r3.detail.ms < 5) {
        lines.push('  ⚠️ 耗时 <5ms 就失败 → 极可能是元素残留错误状态，而非真的加载失败');
      }
    }
  } else {
    lines.push('【路线 1】audioUri 为空');
  }
  lines.push('');
  lines.push('把以上内容贴给我即可定位问题。');
  diagLog(lines);
}

/** 用 Blob URL 重新加载（绕开 asWebviewUri 的路径限制） */
async function reloadAsBlob() {
  const m = state.material;
  if (!m || !m.audioUri) return;
  diagLog(['改用 Blob 加载…']);
  try {
    const r = await fetch(m.audioUri);
    const ab = await r.arrayBuffer();
    const blob = new Blob([ab], { type: audioMime() });
    const url = URL.createObjectURL(blob);
    player.src = url;
    player.load();
    const onOk = () => {
      diagLog([
        '✅ Blob 路线成功',
        '  字节数: ' + ab.byteLength,
        '  blob type: ' + audioMime(),
        '  时长: ' + player.duration.toFixed(2) + 's',
        '',
        '→ 说明问题在 asWebviewUri 的路径/权限层，Blob 可作降级方案',
      ]);
      player.removeEventListener('loadedmetadata', onOk);
      player.removeEventListener('error', onErr);
    };
    const onErr = () => {
      diagLog([
        '❌ Blob 路线也失败',
        '  字节数: ' + ab.byteLength,
        '  error code: ' + (player.error && player.error.code),
        '',
        '→ 说明问题在数据/解码层，不是加载路径',
      ]);
      player.removeEventListener('loadedmetadata', onOk);
      player.removeEventListener('error', onErr);
    };
    player.addEventListener('loadedmetadata', onOk);
    player.addEventListener('error', onErr);
  } catch (e) {
    diagLog(['Blob 路线异常: ' + (e && e.message ? e.message : e)]);
  }
}

/** 用 DataURI 重新加载 */
async function reloadAsDataUri() {
  const m = state.material;
  if (!m || !m.audioUri) return;
  diagLog(['改用 DataURI 加载（大文件会很慢）…']);
  try {
    const r = await fetch(m.audioUri);
    const ab = await r.arrayBuffer();
    // 分块转 base64，避免大文件栈溢出
    const bytes = new Uint8Array(ab);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    const url = 'data:' + audioMime() + ';base64,' + btoa(bin);
    player.src = url;
    player.load();
    // ⚠️ 用 addEventListener，不要用 on* 属性赋值 ——
    //    本文件顶部已记录该教训：on* 写法在复用元素时实测会超时。
    const onOk2 = () => {
      diagLog(['✅ DataURI 路线成功', '  时长: ' + player.duration.toFixed(2) + 's']);
      player.removeEventListener('loadedmetadata', onOk2);
      player.removeEventListener('error', onErr2);
    };
    const onErr2 = () => {
      diagLog([
        '❌ DataURI 路线失败',
        '  error code: ' + (player.error && player.error.code),
        '  errMsg    : ' + (player.error && player.error.message),
      ]);
      player.removeEventListener('loadedmetadata', onOk2);
      player.removeEventListener('error', onErr2);
    };
    player.addEventListener('loadedmetadata', onOk2);
    player.addEventListener('error', onErr2);
  } catch (e) {
    diagLog(['DataURI 路线异常: ' + (e && e.message ? e.message : e)]);
  }
}

/* ---------------- 报告 ---------------- */

function renderReport(rep) {
  const kinds = {
    'missing-function-word': '漏听虚词（弱读盲区）',
    'missing-content-word': '漏听实词',
    'misheard': '错听',
    'spelling': '拼写',
    'extra': '多写',
  };
  const entries = Object.entries(rep.byKind).filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  const totalErr = entries.reduce((s, [, v]) => s + v, 0);

  root.innerHTML =
    '<div class="meta"><h2>听力诊断报告</h2>' +
    '<div class="sub">共 ' + rep.totalAttempts + ' 次练习 · ' + rep.totalSentences + ' 个句子 · ' +
    '累计错误 ' + totalErr + ' 处</div></div>' +
    '<div class="report">' +
      (totalErr === 0
        ? '<div class="center">还没有错误记录，先去练几句吧。</div>'
        : '<table><tr><th>错误类型</th><th>次数</th><th>占比</th></tr>' +
          entries.map(([k, v]) =>
            '<tr><td>' + (kinds[k] || k) + '</td><td>' + v + '</td><td>' +
            Math.round(v / totalErr * 100) + '%</td></tr>').join('') +
          '</table>' +

          (rep.functionWordBlindSpots.length
            ? '<h3 style="font-size:13px;margin:18px 0 6px;">弱读盲区 TOP</h3>' +
              '<table><tr><th>词</th><th>漏听次数</th></tr>' +
              rep.functionWordBlindSpots.map((w) =>
                '<tr><td>' + esc(w.word) + '</td><td>' + w.count + '</td></tr>').join('') +
              '</table>'
            : '') +

          (rep.topMissedWords.length
            ? '<h3 style="font-size:13px;margin:18px 0 6px;">最常出错的词</h3>' +
              '<table><tr><th>词</th><th>次数</th><th>类型</th></tr>' +
              rep.topMissedWords.slice(0, 15).map((w) =>
                '<tr><td>' + esc(w.word) + '</td><td>' + w.count + '</td><td>' +
                (kinds[w.kind] || w.kind) + '</td></tr>').join('') +
              '</table>'
            : '')
      ) +
      '<div style="margin-top:16px"><button id="back" class="ghost">返回练习</button></div>' +
    '</div>';

  const back = document.getElementById('back');
  if (back) back.onclick = render;
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.kind === 'panel') PracticePanel.current = undefined;
    else PracticePanel.sidebar = undefined;
    // 编辑器面板需要显式销毁容器；侧边栏容器由 VS Code 管理，只清理订阅
    if (this.panel) this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
