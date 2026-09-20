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
import { ListeningMaterial, MaterialSourceAdapter, AudioInfo, AudioProgress, relocateAudioPath, clampSentencesToAudio, extractNextDataJson, TedNextData, AUDIO_CACHE_VERSION } from '../core/types';
import { httpGetText } from '../core/http';
import { checkSentence, SentenceResult, buildReport } from '../core/diff';
import {
  applyTimingOverrides,
  clearAllTimingOverrides,
  clearTimingOverride,
  readTimingOverrides,
  setTimingOverride,
  SentenceTiming,
} from '../core/timing';
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
  /**
   * talk 页面 URL 里的 slug。
   *
   * ⚠️ 「已下载」判定必须用它，不能用 id：
   *   搜索结果里的 `hit.id` 是 Algolia 的 objectID（实测 3292），
   *   素材库的 id 是 `ted:<videoData.id>`（实测 ted:66）—— **两者不同源**！
   *   按 id 对齐时「已下载」永远标不上（2026-09-19 实测）。
   *   唯一稳定的公共字段是 slug（搜索结果与素材 sourceUrl 里都是它）。
   */
  slug: string;
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

/**
 * 缓存类错误统一的第二行提示。
 *
 * ⚠️ 不能沿用默认的「如果是网络问题，请配置 proxy」——素材目录迁移导致的
 *    路径失效是纯本地问题，把用户往代理上引只会浪费排查时间（实测反馈）。
 */
const CACHE_ERR_HINT =
  '这是本地素材缓存的问题，与网络/代理无关。到「素材库」删掉该素材，再从「发现 TED」重新加载一次即可。';

/** 「发现 TED」卡片展开时显示的简介 */
interface TalkInfo {
  description: string;
  presenter: string;
  durationMs: number;
}

/** 页面传给宿主的下载上下文：来源是列表时，进度要显示在卡片上而不是切视图 */
interface LoadContext {
  origin?: 'discover';
  /** 卡片的对齐键（slug）—— webview 用它定位是哪一张卡片 */
  slug?: string;
}

/**
 * 从 talk 页面 URL 里取 slug（搜索结果里用的也是这个字段）。
 *
 * ⚠️ 「已下载」与「下载进度」的对齐一律走 slug，不要用 id：
 *   搜索结果的 hit.id 是 Algolia objectID，素材库 id 是 ted:<videoData.id>，
 *   两者不同源（实测 3292 vs 66）。
 */
function slugFromUrl(url: string | undefined): string {
  if (!url) return '';
  const m = String(url).match(/\/talks\/([^/?#]+)/i);
  return m ? m[1] : '';
}

/**
 * 把素材源上报的音频进度映射成进度条百分比。
 *
 * 刻度分配（总进度 20% 起，解析元数据已用掉前 20%）：
 *   下载  20 → 90（按下发数线性推进）
 *   解封装 90 → 93（同步计算，按分片数推进）
 *   转码  93 → 99（耗时主体，实测 8MB 音频约 24s）
 *   100 由调用方在生成完 material 后补
 *
 * 为什么不沿用「下载到 N/N 就是 95%」：下载完还有 20~30s 的转码，
 * 进度条会顶在 95% 不动、文案停在「下载音频 192/192」，
 * 看起来就是卡死（2026-09-19 用户实测反馈）。
 */
function mapAudioProgress(p: AudioProgress): number {
  if (p.stage === 'download') return 20 + Math.round(p.ratio * 70);
  if (p.stage === 'demux') return 90 + Math.round(p.ratio * 3);
  return 93 + Math.round(p.ratio * 6);
}

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
  /** 简介缓存（key = talkId 或 slug）——同一张卡片反复展开不重复发请求 */
  private readonly talkInfoCache = new Map<string, TalkInfo>();

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
        const dir = path.join(this.deps.cacheRoot, d.name);
        const p = path.join(dir, 'material.json');
        if (!fs.existsSync(p)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(p, 'utf8')) as ListeningMaterial;
          const audioInfoPath = path.join(dir, 'audio.json');
          let hasAudio = false;
          if (fs.existsSync(audioInfoPath)) {
            const info = JSON.parse(fs.readFileSync(audioInfoPath, 'utf8')) as AudioInfo;

            // ⚠️ 必须校验缓存版本，否则会继续复用旧版 demux 产出的坏文件 ——
            //    表现为「重新打开还是播放失败」，而代码其实已经修好了。
            if (info.cacheVersion !== AUDIO_CACHE_VERSION) {
              continue;
            }
            // ★ 音频路径必须按【当前目录】重新定位：
            //   audio.json 里的 path 是写入时的绝对路径，素材目录被迁移过
            //   （materialsDir 变更会自动搬运）就指向旧位置，readFileSync 直接
            //   抛错，整个素材会被静默跳过 —— 表现为「打开窗口后什么都不加载」。
            const audioPath = relocateAudioPath(dir, info);
            if (!audioPath) {
              trace('[LT-TRACE] 音频文件缺失（目录: ' + dir + '），跳过该素材');
              continue;
            }
            info.path = audioPath;
            // 再校验文件本身（版本对但文件被截断/损坏的情况）
            //
            // ⚠️ v5 起最终产物是 MP3（裸流，没有容器结构可查）。
            //    不能拿 MP4/ADTS 校验器去查 —— 那会把所有正常缓存判为损坏。
            //    isValidMp3 看文件头帧同步 + 是否还能扫到若干处同步，
            //    足以挡住「空文件 / 被截断 / 根本不是 MP3」。
            try {
              const buf = fs.readFileSync(audioPath);
              if (!isValidMp3(buf)) {
                trace('[LT-TRACE] 缓存 MP3 校验不合格（非 MP3 或被截断），跳过');
                continue;
              }
            } catch {
              continue;
            }

            m.audio = info;
            // cacheDir 同样是旧绝对路径 —— 删除素材时要靠它判断「当前素材」
            m.cacheDir = dir;
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
  /**
   * ★ 删除确认必须由【宿主】用原生对话框完成，绝不能用 webview 里的 window.confirm()。
   *
   * 实测（2026-09-19）：VS Code 的 webview 是 sandboxed iframe，没有 allow-modals，
   * Chromium 会直接【忽略】confirm 调用并返回 false（控制台只有一行 ignored 警告）。
   * 于是 `if (!window.confirm(...)) return;` 每次都提前返回：
   *   - 「删除 / 多选删除 / 全部删除」点了全部没反应
   *   - 页面不报错、宿主也收不到消息 —— 典型的"静默失效"
   * 改用 showWarningMessage({ modal: true }) 后，确认框由 VS Code 弹出，
   * 用户点「删除」才真的删。这也与本项目其它破坏性操作（清空音频缓存命令）保持一致。
   */
  private async confirmAndDelete(dirNames: string[], titles: string[]): Promise<void> {
    // 与 deleteCachedDirs 用同一套判据 —— 不能信任 webview 传来的目录名
    const valid = dirNames.filter((n) => n && !/[\\/:*?"<>|]/.test(n));
    if (!valid.length) return;

    const what =
      valid.length === 1
        ? `素材《${(titles[0] || valid[0]).slice(0, 60)}》`
        : `选中的 ${valid.length} 个素材`;
    const pick = await vscode.window.showWarningMessage(
      `确定删除${what}？音频缓存会一并删除，不可恢复。`,
      { modal: true },
      '删除'
    );
    if (pick !== '删除') return; // 取消：什么都不做，页面保持原状

    // 先让页面退出多选模式，再删；删除完成后 deleteCachedDirs 会重推列表
    this.webview.postMessage({ type: 'deleted', count: valid.length });
    this.deleteCachedDirs(valid);
  }

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
          slug: slugFromUrl(m.sourceUrl),
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
        this.pushConfig();
        this.pushMaterial();
        break;

      case 'check': {
        const idx: number = msg.sentenceIndex;
        const input: string = msg.input ?? '';
        const m = this.material;
        if (!m || !m.sentences[idx]) return;
        // ⚠️ 兜底：空输入绝不进判定。
        //    checkSentence 会把整句每个词都判成「漏听」，紧接着就被 append
        //    进错题库；污染是【累积】的，会让诊断报告长期失真。
        //    页面侧已拦一道，但错题库的写入点必须自己再防一次
        //    （以后新增入口也会经过这里）。
        if (!input.trim()) return;

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
       * 清空错题库（诊断报告页的「清空数据」）。
       *
       * ⚠️ 确认框必须由宿主弹：webview 是 sandboxed iframe，Chromium 会忽略
       *    window.confirm 并恒返回 false（项目里 deleteCached 已踩过这个坑）。
       *    而且这是不可逆操作 —— 素材与时间轴修正不受影响，但历史错题会全没。
       */
      case 'clearMistakes': {
        // 二次确认：点按钮只是发起，真正执行要在这里再确认一次。
        // 文案里写明「将删除 N 条」而不是干巴巴问一句 —— 让用户知道后果的重量。
        const count = this.store.readAll().length;
        if (count === 0) {
          this.webview.postMessage({ type: 'notice', message: '没有可清空的记录。' });
          break;
        }
        const pick = await vscode.window.showWarningMessage(
          `确定清空全部听力错误记录？将删除 ${count} 条，诊断报告会归零。`,
          {
            modal: true,
            detail: '此操作不可撤销。已下载的素材、以及你手工修正过的句子时间轴都不受影响。',
          },
          '清空'
        );
        if (pick !== '清空') break;
        try {
          this.store.clear();
          // 立刻用清空后的数据重绘，页面不会留着旧统计
          this.showReport();
        } catch (e: any) {
          this.webview.postMessage({
            type: 'notice',
            message: '清空失败：' + String(e?.message ?? e),
          });
        }
        break;
      }

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
          // 附带「已下载」清单：页面据此在卡片上标注已下载 / 决定显示「下载」还是「练习」。
          // 数据源就是素材库那套 scanCached()，不另外维护状态，删改后自然一致。
          // ⚠️ 必须带 slug：搜索结果只有 slug 能和素材对上（id 不同源，见 slugFromUrl）
          const cached = this.scanCached()
            .filter((i) => i.hasAudio && i.slug)
            .map((i) => ({ slug: i.slug, dirName: i.dirName }));
          this.webview.postMessage({ type: 'tedResults', reqId: msg.reqId, error: null, cached, ...r });
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
        // titles 只用于确认框里显示素材名，缺省时退回目录名
        const titles: string[] = Array.isArray(msg.titles) ? msg.titles.map(String) : [];
        await this.confirmAndDelete(names, titles);
        break;
      }

      /**
       * 「发现 TED」卡片展开时取简介。
       *
       * 搜索接口不带简介（实测 4 个索引都没有该字段），所以只能按需取：
       * 已缓存的读 material.json，未缓存的拉一次 talk 页面。
       */
      case 'talkInfo': {
        const slug = String(msg.slug ?? '').trim();
        const talkId = String(msg.id ?? '').trim();
        if (!slug) break;
        try {
          const info = await this.fetchTalkInfo(slug, talkId);
          this.webview.postMessage({
            type: 'talkInfo',
            reqId: msg.reqId,
            slug,
            error: null,
            ...info,
          });
        } catch (e: any) {
          this.webview.postMessage({
            type: 'talkInfo',
            reqId: msg.reqId,
            slug,
            error: String(e?.message ?? e),
          });
        }
        break;
      }

      // 「发现 TED」卡片上的「下载」按钮：slug → talk 页面 URL，走与手输链接相同的加载流程。
      // ⚠️ origin='discover'：下载期间页面留在列表、进度显示在卡片上，
      //    所以进度消息必须带来源，页面不能一律切到练习视图。
      case 'loadTedUrl': {
        const url = String(msg.url ?? '').trim();
        if (/^https?:\/\/(www\.)?ted\.com\/talks\//i.test(url)) {
          // slug 既能定位卡片，也是下载完成回调里的对齐键（权威值仍以页面 URL 为准）
          await this.loadFromInput(url, {
            origin: 'discover',
            slug: String(msg.slug ?? '') || slugFromUrl(url),
          });
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
              message: '该素材还没有音频缓存，请重新加载一次。',
              hint: CACHE_ERR_HINT,
            });
            return;
          }
          const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as AudioInfo;
          // 与 tryRestoreLast 同一判据：版本 → 路径 → 文件本身
          if (info.cacheVersion !== AUDIO_CACHE_VERSION) {
            this.webview.postMessage({
              type: 'error',
              message: '该素材的音频缓存版本已过期，请重新加载一次。',
              hint: CACHE_ERR_HINT,
            });
            return;
          }
          // ★ 关键：不能直接用 info.path 判存在性。
          //   audio.json 里存的是写入时的绝对路径，素材目录被迁移过就会失效，
          //   原来的写法会误报「音频缓存已过期」——而文件其实好好地躺在当前目录里。
          const audioPath = relocateAudioPath(dir, info);
          if (!audioPath) {
            this.webview.postMessage({
              type: 'error',
              message: '该素材的音频文件找不到了（目录里没有 audio.mp3），请重新加载一次。',
              hint: CACHE_ERR_HINT,
            });
            return;
          }
          info.path = audioPath;
          if (!isValidMp3(fs.readFileSync(audioPath))) {
            this.webview.postMessage({
              type: 'error',
              message: '该素材的音频缓存损坏，请重新加载一次。',
              hint: CACHE_ERR_HINT,
            });
            return;
          }
          const clamped = clampSentencesToAudio(m.sentences, info.durationMs);
          // cacheDir 也按当前目录修正（删除素材时靠它判断「当前正在练的素材」）
          this.loadMaterial({ ...m, cacheDir: dir, sentences: clamped, audio: info, status: 'ready' });
        } catch (e: any) {
          this.webview.postMessage({
            type: 'error',
            message: '打开素材失败：' + String(e?.message ?? e),
          });
        }
        break;
      }

      /* ---------------- 逐句时间轴修正（见 core/timing.ts） ----------------
       * 只写 timing.json 覆盖层，material.json 里的原始时间轴永不改写，
       * 因此「复原」在任何时候都可用。
       */
      case 'setTiming': {
        const dir = this.material?.cacheDir;
        const idx = Number(msg.index);
        const orig = this.material?.sentences[idx];
        if (!dir || !orig) break;
        const v = this.normalizeTiming(msg.startMs, msg.endMs);
        if (!v) {
          this.webview.postMessage({
            type: 'timingError',
            message: '时间轴不合法：起点要小于终点，且都要落在 0 到音频长度之间。',
          });
          break;
        }
        try {
          // 改回原值就当成「复原」—— 否则会留下一条"改了、但值和原来一样"的
          // 假修正，UI 一直显示 ✎ 而用户看不出哪里不同。
          const backToOrig =
            Math.round(orig.startMs) === v.startMs && Math.round(orig.endMs) === v.endMs;
          const ov = backToOrig
            ? clearTimingOverride(dir, idx)
            : setTimingOverride(dir, idx, v);
          this.webview.postMessage({
            type: 'timingPatched',
            index: idx,
            startMs: backToOrig ? Math.round(orig.startMs) : v.startMs,
            endMs: backToOrig ? Math.round(orig.endMs) : v.endMs,
            edited: !backToOrig,
            count: Object.keys(ov).length,
          });
        } catch (e: any) {
          this.webview.postMessage({
            type: 'timingError',
            message: '保存时间轴修正失败：' + String(e?.message ?? e),
          });
        }
        break;
      }

      case 'resetTiming': {
        const dir = this.material?.cacheDir;
        const idx = Number(msg.index);
        const orig = this.material?.sentences[idx];
        if (!dir || !orig) break;
        try {
          const ov = clearTimingOverride(dir, idx);
          this.webview.postMessage({
            type: 'timingPatched',
            index: idx,
            startMs: orig.startMs,
            endMs: orig.endMs,
            edited: false,
            count: Object.keys(ov).length,
          });
        } catch (e: any) {
          this.webview.postMessage({
            type: 'timingError',
            message: '复原失败：' + String(e?.message ?? e),
          });
        }
        break;
      }

      case 'resetAllTiming': {
        const dir = this.material?.cacheDir;
        if (!dir || !this.material) break;
        try {
          clearAllTimingOverrides(dir);
          // ⚠️ 全量回推 sentences，但【不能】用 pushMaterial()：
          //    页面收到 'material' 会把 currentIndex 重置为 0，等于把用户
          //    正在练的句子踢回第一句。这里只换时间轴，不动进度。
          this.webview.postMessage({
            type: 'timingReset',
            sentences: this.material.sentences,
            count: 0,
          });
        } catch (e: any) {
          this.webview.postMessage({
            type: 'timingError',
            message: '复原全部失败：' + String(e?.message ?? e),
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

  /**
   * 取某个 talk 的简介（「发现 TED」卡片展开时用）。
   *
   * ⚠️ 为什么不能在搜索时就带上：实测（2026-09-19）TED 的 4 个 Algolia 索引
   *    （relevance / popular / newest / oldest）返回的 hit 只有
   *    _index / _score / duration / objectID / photos / slug / speakers / title
   *    —— **没有简介**。所以只能展开时按需取：
   *      1) 素材已缓存 → 直接读 material.json 里的 description（不联网）
   *      2) 否则 GET talk 页面，取 __NEXT_DATA__.videoData.description
   *    结果在实例内缓存（talkInfoCache），反复展开不再发请求。
   */
  private async fetchTalkInfo(slug: string, talkId: string): Promise<TalkInfo> {
    const key = talkId || slug;
    const cached = this.talkInfoCache.get(key);
    if (cached) return cached;

    // 1) 已缓存的素材：material.json 里本来就存了 description
    if (talkId) {
      try {
        const metaPath = path.join(this.deps.cacheRoot, `ted-${talkId}`, 'material.json');
        if (fs.existsSync(metaPath)) {
          const m = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ListeningMaterial;
          if (m.description) {
            const info: TalkInfo = {
              description: m.description,
              presenter: m.presenter ?? '',
              durationMs: m.audio?.durationMs ?? 0,
            };
            this.talkInfoCache.set(key, info);
            return info;
          }
        }
      } catch {
        /* 缓存读不动就往下走，联网取 */
      }
    }

    // 2) 联网拉页面（走与素材源同一套代理设置）
    const proxy =
      vscode.workspace.getConfiguration('listeningTrainer').get<string>('proxy', '') || undefined;
    const html = await httpGetText(`https://www.ted.com/talks/${slug}`, { proxy });
    const json = extractNextDataJson(html);
    if (!json) throw new Error('页面结构已变更，取不到简介。');
    const vd = (JSON.parse(json) as TedNextData).props?.pageProps?.videoData;

    const info: TalkInfo = {
      description: vd?.description ?? '',
      presenter: vd?.presenterDisplayName ?? '',
      durationMs: vd?.duration ? vd.duration * 1000 : 0,
    };
    this.talkInfoCache.set(key, info);
    return info;
  }

  private async loadFromInput(input: string, opts?: LoadContext): Promise<void> {
    // 进度消息统一带上来源 + slug：页面据此决定「切到练习视图」还是「只更新那张卡片」
    const ctx: LoadContext = { origin: opts?.origin, slug: opts?.slug };

    const adapter = this.deps.adapters.find((a) => a.canHandle(input));
    if (!adapter) {
      this.webview.postMessage({
        type: 'error',
        message: '暂时只支持 TED 链接。请粘贴 https://www.ted.com/talks/... 形式的地址。',
        ...ctx,
      });
      return;
    }

    this.webview.postMessage({ type: 'progress', message: '解析页面…', percent: 5, ...ctx });
    try {
      const material = await adapter.fetchMetadata(input, this.deps.cacheRoot);
      this.webview.postMessage({
        type: 'progress',
        message: `已解析 ${material.sentences.length} 句，下载音频…`,
        percent: 20,
        ...ctx,
      });

      // 进度文案由素材源给（下载 / 解封装 / 转码各阶段不同），这里只负责映射百分比
      const ready = await adapter.fetchAudio(material, (p) => {
        this.webview.postMessage({
          type: 'progress',
          message: p.message,
          percent: mapAudioProgress(p),
          ...ctx,
        });
      });

      this.loadMaterial(ready);
      this.webview.postMessage({ type: 'progress', message: '就绪', percent: 100, ...ctx });
      this.webview.postMessage({ type: 'done', ...ctx });

      // 列表里发起的下载：额外告诉页面「这张卡片现在已下载」。
      // slug 以素材自身的 sourceUrl 为准（与搜索结果的 slug 同源），
      // 目录名一并带上（页面不必去猜 ted-<id> 的命名规则）。
      if (opts?.origin === 'discover') {
        this.webview.postMessage({
          type: 'tedDownloaded',
          slug: slugFromUrl(ready.sourceUrl) || opts.slug || '',
          id: ready.id,
          dirName: path.basename(ready.cacheDir),
        });
      }
    } catch (e) {
      this.webview.postMessage({ type: 'error', message: (e as Error).message, ...ctx });
    }
  }

  private pushMaterial(): void {
    if (!this.material) return;

    /**
     * 应用用户的逐句时间轴修正。
     *
     * ⚠️ 只在推送时合并，**不回写 material.json**：
     *    原始时间轴是「复原」的唯一基准，一旦被就地改写就回不去了。
     *    详见 core/timing.ts 开头的设计说明。
     */
    const overrides = readTimingOverrides(this.material.cacheDir);
    const sentences = applyTimingOverrides(
      this.material.sentences,
      overrides,
      this.material.audio?.durationMs
    );
    // 实际生效的条数（越界被丢弃的不算），页面据此决定要不要显示「复原全部」
    const timingCount = sentences.filter((s) => s.timingEdited).length;

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
    trace('[LT-TRACE]   timing    = ' + timingCount + ' 句有手工修正');

    this.webview.postMessage({
      type: 'material',
      material: {
        id: this.material.id,
        title: this.material.title,
        presenter: this.material.presenter,
        sentences: sentences,
        // 已有修正的句数：页面据此决定要不要显示「复原全部」
        timingCount: timingCount,
        audioUri: this.audioUri,
        durationMs: this.material.audio?.durationMs,
        startOffsetMs: this.material.audio?.startOffsetMs ?? 0,
        // 页面据此挑 MIME（audio/aac vs audio/mp4）。
        // 传 null 时页面按 MP4 处理 —— v3 之后只会有 MP4。
        audioFormat: this.material.audio?.format ?? null,
      },
    });
  }

  /**
   * 把影响页面渲染的配置推给 webview（目前只有「是否显示音频诊断按钮」）。
   *
   * ⚠️ 为什么单开一条消息、不搭 material 的顺风车：
   *    页面收到 'material' 会把 currentIndex 重置为 0 —— 用户改设置时
   *    不该把他正在练的那一句踢回第一句。
   *
   * 调用点：webview 就绪（case 'ready'）+ 配置变更（extension.ts 监听）。
   */
  pushConfig(): void {
    this.webview.postMessage({
      type: 'config',
      showAudioDiag: vscode.workspace
        .getConfiguration('listeningTrainer')
        .get<boolean>('showAudioDiagnostics', false),
    });
  }

  /**
   * 校验并规整用户提交的句子时间轴。返回 null = 不合法，直接拒绝。
   *
   * 为什么必须校验而不是照单全收：越界的 start/end 会让 seek 落在不存在的
   * 区间，播放器静默不动作 —— 表现为「点了播放没反应」，比偏一点更难排查。
   */
  private normalizeTiming(startRaw: unknown, endRaw: unknown): SentenceTiming | null {
    const startMs = Math.round(Number(startRaw));
    const endMs = Math.round(Number(endRaw));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    if (startMs < 0) return null;
    // 至少留 100ms：防止滑出"零长度句"（永远播不出声）
    if (endMs - startMs < 100) return null;
    const dur = this.material?.audio?.durationMs;
    if (typeof dur === 'number' && dur > 0 && endMs > dur) return null;
    return { startMs, endMs };
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
  /* ⚠️ 页面本身【永不滚动】：滚动只发生在各视图内部（.list / .discover / .library）。
     overflow:hidden 是硬性兜底 —— body 用的是 100vh，而 webview 的实际可视高度
     与 100vh 可能差零点几像素，那点差值就足以凭空造出一条页面级滚动条，
     看起来就像「布局被撑破了」（2026-09-19 反馈，无头测试复现不出这种差值）。 */
  html { overflow: hidden; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg); background: var(--bg);
    height: 100vh; overflow: hidden; display: flex; flex-direction: column;
  }
  /* 滚动条统一成 VS Code 自己的样式（10px + 半透明灰）。
     不加这段就会用 Chromium 默认样式：又粗又黑，看到的瞬间会以为页面被撑破了。 */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(121,121,121,.4); border-radius: 5px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(121,121,121,.7); }
  ::-webkit-scrollbar-thumb:active { background: rgba(121,121,121,.8); }
  ::-webkit-scrollbar-corner { background: transparent; }
  .topbar {
    padding: 8px 12px; border-bottom: 1px solid var(--border);
    display: flex; gap: 8px; align-items: center; flex: 0 0 auto;
    /* 窄宽度（侧边栏）下按钮要换行，而不是被裁掉半截。
       flex 默认 nowrap，加上页面锁了 overflow:hidden，溢出的按钮会直接消失。 */
    flex-wrap: wrap;
    row-gap: 6px;
  }
  /* 按钮保持自身宽度：宁可换行，也不把「诊断报告」压成「诊断…」 */
  .topbar button { flex: 0 0 auto; }
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
  /* 当前所在视图的导航按钮。
   * ⚠️ 只改颜色/边框色，绝不改尺寸或显隐 —— 否则按钮会位移，
   *    用户按原位置再点一下就会点到别的按钮。 */
  .topbar button.on { color: var(--accent); border-color: var(--accent); }

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

  /* ---- 上下布局（窄窗口 / 侧边栏下左右布局太挤的替代方案）----
   * DOM 顺序是 toggle → list → practice；竖排时用 order 重排成
   *   操作区(1) → 开关条(2) → 字幕列表(3)
   * 也就是：操作栏 → 紧贴它下方的开关条 → 字幕列表。
   *
   * 高度分配是这里最容易踩的坑（2026-09-19 用户明确要求）：
   *   - 操作区 flex: 0 0 auto —— **永不压缩**：高度完全按内容走，
   *     不出内部滚动条、不裁行。窗口很矮时宁可把列表压小，
   *     也不能隐藏操作栏的功能。
   *   - 列表 flex: 1 1 auto + min-height: 0 —— 吃掉剩余空间并【内部滚动】；
   *     再配合 .main.stacked 的 overflow:hidden，字幕再长也不会撑破容器
   *     （整页不出现滚动条，列表自己有右侧滚动条）。
   *   - 收起时列表不占位，但操作区**保持原高度**（下方留白，不伸展）。
   */
  .main.stacked { flex-direction: column; overflow: hidden; }
  .main.stacked .practice {
    order: 1; flex: 0 0 auto;
    border-bottom: 1px solid var(--border);
  }
  .main.stacked .list-toggle {
    order: 2; width: auto; height: 14px; border-right: none;
  }
  .main.stacked .list {
    order: 3; flex: 1 1 auto; min-height: 0;
    /* 去掉列表自身的上下 padding：它是给左右布局留的，竖排下会让
       列表在空间不足时最小高度卡在 8px，挤出几 px 无意义的溢出 */
    padding: 0;
    border-right: none;
  }
  .main.stacked.collapsed .list { display: none; }
  .main.stacked.collapsed .practice { flex: 0 0 auto; }

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

  /* ---- 卡片展开/下载按钮（改造后：点卡片只展开简介，下载要点按钮）---- */
  .disc-card { align-items: flex-start; }
  .disc-card.open { border-color: var(--accent); }
  .disc-body { flex: 1 1 auto; min-width: 0; }
  .disc-detail { margin-top: 6px; }
  .disc-desc {
    font-size: 11px; color: var(--muted); line-height: 1.5;
    white-space: pre-wrap; word-break: break-word;
    max-height: 132px; overflow-y: auto;
  }
  .disc-act { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .disc-act button { padding: 3px 8px; font-size: 11px; }
  .disc-prog { font-size: 11px; color: var(--accent); white-space: nowrap; }
  .disc-err { font-size: 11px; color: var(--err); margin-top: 4px; word-break: break-word; }

  /* ---- 「素材库」视图（已缓存素材）---- */
  .library { display: none; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px; gap: 8px; }
  .library.visible { display: flex; }

  /* ---- 「诊断报告」视图 ----
   * ⚠️ 报告必须是独立视图，不能写进 #root（练习界面）：
   *    历史事故（2026-09-19）——报告写进 #root 且不切视图，于是在「发现 TED」/
   *    「素材库」里点诊断报告没有任何反应（写进了隐藏容器），而之后任何一次
   *    "切回练习"都会突然显示那份报告，表现为「界面跳来跳去、跳到诊断报告去了」。 */
  .report-view { display: none; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px; gap: 8px; }
  .report-view.visible { display: flex; }
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

  /* ---- 逐句时间轴微调条 ----
   * 折叠态只有一行标题，展开后是两行 ± 与一行操作。
   * 按钮一律 flex: 0 0 auto + 允许换行：侧边栏很窄，宁可换行也不能被压扁。 */
  .timing { padding: 4px 12px 6px; border-bottom: 1px solid var(--border); flex: 0 0 auto; }
  .timing-head {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; color: var(--muted); cursor: pointer;
  }
  .timing-head:hover { color: var(--fg); }
  .timing-head .t-now {
    margin-left: auto; font-variant-numeric: tabular-nums; color: var(--muted);
  }
  .timing-body { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
  .t-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .t-row button { flex: 0 0 auto; padding: 2px 6px; font-size: 11px; line-height: 1.5; }
  .t-lbl { min-width: 26px; color: var(--muted); font-size: 11px; }
  .t-mark { color: var(--accent); font-size: 10px; margin-left: 4px; }
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
  <!-- 导航按钮：点哪个去哪个（幂等，不做「再点一次回练习」），当前视图高亮。
       这里刻意【没有】「练习」按钮 —— 回精听界面只有一条路：
       在「素材库」里点一篇素材（或在发现列表点已下载卡片的「练习」），
       这样不会出现"切回练习界面却什么都没加载"的空转状态。 -->
  <button id="discoverBtn" class="ghost">发现 TED</button>
  <button id="libraryBtn" class="ghost">素材库</button>
  <button id="report" class="ghost">诊断报告</button>
  <!-- 布局切换：只在精听界面显示（文案是「点了会切到哪种布局」） -->
  <button id="layoutBtn" class="ghost" style="display:none">⇅ 上下布局</button>
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

<div id="reportView" class="report-view"></div>

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
    console.log('[listen-and-write] 过渡性 audio error（不弹提示）', detail, failedSrc);
    return;
  }
  showPlayerError(detail);
  console.error('[listen-and-write] audio error', err);
});

let state = {
  material: null,
  currentIndex: 0,
  results: {},
  rate: 1,
  loop: false,
  listCollapsed: false,
  // 布局：false = 左字幕 / 右操作（默认）；true = 上操作 / 下字幕
  stacked: false,
  // 时间轴微调面板是否展开（只在会话内记忆，不持久化）
  timingOpen: false,
  // 当前素材已手工修正的句数 —— 宿主在 material / timingPatched 里告知，
  // 决定「复原全部」要不要出现
  timingCount: 0,
  // 是否显示音频加载诊断按钮（🔧）。
  // 默认关：音频链路已打通，这是留给开发者的排查工具，
  // 由 listeningTrainer.showAudioDiagnostics 控制（宿主在 ready / 配置变更时推）
  showAudioDiag: false,
};

// 布局偏好持久化：webview 的 state 在窗口重载、切走再回来时都会保留。
// getState/setState 是 acquireVsCodeApi() 的标准能力，但桩环境里可能没有，
// 所以都要判类型 + try（历史上页面脚本一旦抛错就是整页按钮全部失效）。
try {
  if (typeof vscode.getState === 'function') {
    const saved = vscode.getState();
    if (saved && typeof saved.stacked === 'boolean') state.stacked = saved.stacked;
  }
} catch (e) { /* 取不到就用默认布局 */ }

function saveLayout() {
  try {
    if (typeof vscode.setState === 'function') vscode.setState({ stacked: state.stacked });
  } catch (e) { /* 存不了不影响使用 */ }
}

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
  if (msg.type === 'material') {
    state.material = msg.material;
    state.currentIndex = 0;
    state.timingCount = msg.material.timingCount || 0;
    render();
  }
  // 时间轴修正的保存结果。宿主是唯一权威：一律以回推值为准，
  // 不做"本地改了就当成功"——保存失败（目录只读等）时页面必须纠回来。
  if (msg.type === 'timingPatched') {
    const s = state.material && state.material.sentences[msg.index];
    if (s) {
      s.startMs = msg.startMs;
      s.endMs = msg.endMs;
      s.timingEdited = !!msg.edited;
    }
    state.timingCount = msg.count || 0;
    render();
  }
  // 「复原全部」：只换时间轴，保持当前句不变
  if (msg.type === 'timingReset') {
    if (state.material) state.material.sentences = msg.sentences;
    state.timingCount = msg.count || 0;
    render();
  }
  if (msg.type === 'timingError') showPlayerError(msg.message);
  // 宿主发来的通用提示（例如"清空失败：…"）
  if (msg.type === 'notice') showNotice(msg.message);
  // 影响渲染的配置（宿主在 ready 与配置变更时推；这里的 render 不动 currentIndex）
  if (msg.type === 'config') {
    state.showAudioDiag = !!msg.showAudioDiag;
    render();
  }
  if (msg.type === 'checkResult') { state.results[msg.result.sentenceIndex] = msg.result; render(); }
  // ★ 下载来源区分（2026-09-19）：
  //   - 「发现 TED」列表里点「下载」→ 进度/错误只更新那张卡片，页面留在列表
  //   - 粘贴链接等入口 → 照旧切到练习视图显示全局进度
  if (msg.type === 'progress') {
    if (msg.origin === 'discover') onDiscProgress(msg);
    else { showProgress(msg.message, msg.percent); showPracticeView(); }
  }
  if (msg.type === 'done') {
    // 列表下载的收尾由 tedDownloaded 完成（它带真实目录名），这里不切视图
    if (msg.origin !== 'discover') { render(); showPracticeView(); }
  }
  if (msg.type === 'error') {
    if (msg.origin === 'discover') onDiscError(msg);
    else { showError(msg.message, msg.hint); showPracticeView(); }
  }
  if (msg.type === 'report') { renderReport(msg.report); }
  if (msg.type === 'audioBytes') { onAudioBytes(msg); }
  if (msg.type === 'pausePlayback') {
    // 侧边栏收起时宿主发来 —— 音频不会因 webview 隐藏而自己停
    try { player.pause(); } catch (err) { /* 未初始化时忽略 */ }
  }
  if (msg.type === 'tedResults') { onTedResults(msg); }
  if (msg.type === 'talkInfo') {
    discState.info[msg.slug] = msg.error
      ? { error: msg.error }
      : { description: msg.description, presenter: msg.presenter, durationMs: msg.durationMs };
    if (discState.expanded[msg.slug]) renderDiscList();
  }
  if (msg.type === 'tedDownloaded') {
    // 下载完成：这张卡片标成「已下载」（目录名由宿主给，页面不猜命名规则）。
    // 对齐键是 slug —— 见 discCachedDir 的注释（搜索结果的 id 与素材 id 不同源）。
    if (msg.slug) discState.cached[msg.slug] = msg.dirName;
    if (msg.slug) delete discState.download[msg.slug];
    if (discState.hits.length) renderDiscList();
  }
  if (msg.type === 'cachedList') { onCachedList(msg); }
  if (msg.type === 'materialRemoved') {
    // 正在练习的素材被删除：停播并清空界面
    try { player.pause(); } catch (err) { /* 忽略 */ }
    state.material = null;
    activeSrc = null; lastLoadedUrl = null;
    root.innerHTML =
      '<div class="center">该素材已被删除。<br>从「发现 TED」加载新素材，或在「素材库」选择其他素材继续。</div>';
  }
  if (msg.type === 'deleted') {
    // 只有宿主确认删除后才会发这条 —— 用户取消时不会发，界面保持原状。
    // 删除完成宿主还会推 cachedList，届时用新列表重渲染。
    libState.multi = false;
    libState.selected = {};
    renderLib();
  }
  // 注意：视图切换已在上面按 progress/done/error 的来源分别处理，
  // 不要再在这里统一 showPracticeView() —— 那会把列表里的下载进度打断。
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
let discState = {
  sort: 'popular', query: '', page: 0, nbPages: 0, reqId: 0, loading: false,
  // 当前页结果
  hits: [],
  // 已下载清单：素材 id('ted:66') → 目录名。由宿主随搜索结果给出，
  // 数据源就是素材库那套 scanCached()，删改后自然一致
  cached: {},
  // slug → true（展开简介）
  expanded: {},
  // slug → { loading } | { description, presenter, durationMs } | { error }
  info: {},
  // ⚠️ 简介请求单独计数：不能复用 reqId，否则会把在途的搜索结果误判为过期
  infoReq: 0,
  // talkId → { percent, message, error }（下载中）
  download: {},
};

/* 四视图统一切换：practice / discover / library / report 互斥显示 */
const reportView = document.getElementById('reportView');
const viewEls = {
  practice: document.getElementById('root'),
  discover: discView,
  library: libView,
  report: reportView,
};
let currentView = 'practice';

/* 顶部导航按钮 ↔ 视图的对应关系（用于给当前视图的按钮加高亮）。
 * ⚠️ 不含 practice：精听界面不是导航项，进练习只能从素材库选一篇素材。
 *    因此处在练习界面时三个导航按钮都不高亮（等于「不在任何 tab 里」）。 */
const navBtn = {
  discover: document.getElementById('discoverBtn'),
  library: document.getElementById('libraryBtn'),
  report: document.getElementById('report'),
};

const layoutBtn = document.getElementById('layoutBtn');

/** 布局按钮：只在精听界面显示，文案写「点了会切到哪种布局」 */
function updateLayoutBtn() {
  layoutBtn.style.display = currentView === 'practice' ? '' : 'none';
  layoutBtn.textContent = state.stacked ? '⇄ 左右布局' : '⇅ 上下布局';
}

function showView(name) {
  currentView = name;
  for (const k of Object.keys(viewEls)) {
    viewEls[k].classList.toggle('visible', k === name);
  }
  // 高亮「我现在在哪个视图」。只切 class，不碰样式尺寸（见 .topbar button.on 注释）
  for (const k of Object.keys(navBtn)) {
    navBtn[k].classList.toggle('on', k === name);
  }
  updateLayoutBtn();
}
function showPracticeView() { showView('practice'); }

/* 首屏：立刻按初始视图刷一遍高亮与布局按钮。
 * 历史 bug（2026-09-19）：高亮只在 showView() 里更新，而首屏从未调用过它 ——
 *   刚打开时三个导航按钮全是灰的，看不出自己处在哪个界面。 */
showView(currentView);

layoutBtn.onclick = () => {
  state.stacked = !state.stacked;
  saveLayout();
  render();
};

/* ---------------- 顶部导航 ----------------
 * ⚠️ 一律「切过去」并保持，**不做「再点一次就回练习」的 toggle**。
 *    历史事故（2026-09-19）：原来写成 toggle，连点两下「发现 TED」就会在
 *    列表与精听界面之间来回跳，用户反馈「界面跳来跳去、停不下来」。
 *    另：已经在目标视图时直接 return，避免重复请求接口导致列表闪烁。
 *
 * 回精听界面不走导航栏（栏里没有「练习」）：
 *   只能从「素材库」点一篇素材，或在发现列表点已下载卡片的「练习」——
 *   这两个入口都会真的去加载素材，不会留下"空转的练习界面"。
 */
navBtn.discover.onclick = () => {
  if (currentView === 'discover') return;
  showView('discover');
  if (!discList.children.length) discLoad(0);
};

navBtn.library.onclick = () => {
  if (currentView === 'library') return;
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

/**
 * 该 talk 在素材库里的目录名（空串 = 未下载）。key 是 slug。
 *
 * ⚠️ 为什么整张列表都用 slug 而不是 id 对齐：
 *   搜索结果的 hit.id 是 Algolia 的 objectID（实测 3292），
 *   素材库的 id 是 ted:<videoData.id>（实测 ted:66）—— **两者不同源**，
 *   按 id 对齐时「已下载」永远标不上、下载完也永远不更新（2026-09-19 实测）。
 *   slug 是搜索结果与素材 sourceUrl 之间唯一稳定的公共字段。
 */
function discCachedDir(slug) {
  return discState.cached[slug] || '';
}

/** 展开区的内容：简介（按需从宿主取，搜索接口不带简介） */
function discDetailHtml(slug) {
  const info = discState.info[slug];
  if (!info || info.loading) return '简介加载中…';
  if (info.error) return '取简介失败：' + esc(info.error);
  return esc(info.description || '（这次演讲没有简介）');
}

/**
 * 渲染当前页卡片。
 *
 * 交互（2026-09-19 明确）：
 *   - 点卡片主体 = 展开/收起简介，**不再直接触发下载**
 *   - 下载必须点右侧的「下载」按钮
 *   - 素材库里已有（含音频）→ 显示「已下载」徽标，按钮变「练习」
 *   - 下载中 → 右侧显示百分比，且页面留在列表不切走
 */
function renderDiscList() {
  if (!discState.hits.length) return;

  discList.innerHTML = discState.hits.map((h) => {
    const dirName = discCachedDir(h.slug);
    const dl = discState.download[h.slug];
    const open = !!discState.expanded[h.slug];
    const img = h.thumb
      ? '<img src="' + esc(h.thumb) + '" loading="lazy">'
      : '<img src="" style="visibility:hidden">';

    let act;
    if (dl && !dl.error) {
      act = '<span class="disc-prog" data-role="prog">' +
        Math.round(dl.percent || 0) + '%</span>';
    } else if (dirName) {
      act = '<button class="disc-go" data-dirname="' + esc(dirName) + '">练习</button>';
    } else {
      act = '<button class="disc-dl" data-slug="' + esc(h.slug) + '">下载</button>';
    }

    const badge = dirName ? '<span class="badge ok">已下载</span>' : '';
    const err = dl && dl.error ? '<div class="disc-err">下载失败：' + esc(dl.error) + '</div>' : '';

    return '<div class="disc-card' + (open ? ' open' : '') +
        '" data-slug="' + esc(h.slug) + '" data-id="' + esc(h.id) + '">' +
      img +
      '<div class="disc-body">' +
        '<div class="t">' + esc(h.title) + '</div>' +
        '<div class="m">' + esc(h.speakers || '') +
          ' · ' + Math.round(h.durationSec / 60) + ' 分钟 ' + badge + '</div>' +
        '<div class="disc-detail"' + (open ? '' : ' style="display:none"') + '>' +
          '<div class="disc-desc">' + discDetailHtml(h.slug) + '</div>' +
        '</div>' +
        err +
      '</div>' +
      '<div class="disc-act">' + act + '</div>' +
    '</div>';
  }).join('');

  discList.querySelectorAll('.disc-card').forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest('button')) return; // 按钮各司其职
      toggleDiscDetail(el.dataset.slug);
    };
  });
  discList.querySelectorAll('.disc-dl').forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); startDiscDownload(el); };
  });
  discList.querySelectorAll('.disc-go').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      showView('practice');
      vscode.postMessage({ type: 'openCached', dirName: el.dataset.dirname });
    };
  });
}

/** 展开/收起简介；首次展开才向宿主取简介 */
function toggleDiscDetail(slug) {
  if (!slug) return;
  if (discState.expanded[slug]) {
    delete discState.expanded[slug];
    renderDiscList();
    return;
  }
  discState.expanded[slug] = true;
  if (!discState.info[slug]) {
    const hit = discState.hits.find((x) => x.slug === slug);
    discState.info[slug] = { loading: true };
    vscode.postMessage({
      type: 'talkInfo',
      reqId: ++discState.infoReq,
      slug: slug,
      id: hit ? hit.id : '',
    });
  }
  renderDiscList();
}

/** 点「下载」：只有这里才会真正触发下载 */
function startDiscDownload(btn) {
  const slug = btn.dataset.slug;
  if (!slug) return;
  if (discState.download[slug]) return;   // 下载中，忽略重复点击
  discState.download[slug] = { percent: 0, message: '准备中' };
  renderDiscList();
  vscode.postMessage({
    type: 'loadTedUrl',
    url: 'https://www.ted.com/talks/' + slug,
    slug: slug,
  });
}

/** 下载进度：只改那一张卡片的百分比，不整表重渲染（进度消息很密集） */
function onDiscProgress(msg) {
  const slug = msg.slug;
  if (!slug || !discState.download[slug]) return;
  discState.download[slug].percent = msg.percent;
  discState.download[slug].message = msg.message;
  const card = discList.querySelector('.disc-card[data-slug="' + slug + '"]');
  const el = card ? card.querySelector('[data-role="prog"]') : null;
  if (el) el.textContent = Math.round(msg.percent || 0) + '%';
}

/** 下载失败：错误显示在卡片上（用户还在列表里操作） */
function onDiscError(msg) {
  const slug = msg.slug;
  if (!slug || !discState.download[slug]) {
    showError(msg.message, msg.hint);
    showPracticeView();
    return;
  }
  discState.download[slug].error = msg.message;
  renderDiscList();
}

/** 素材库数据变了（删除/新增）→ 同步「已下载」标注（按 slug 对齐） */
function syncDiscCached(items) {
  const map = {};
  items.forEach((it) => { if (it.hasAudio && it.slug) map[it.slug] = it.dirName; });
  discState.cached = map;
  if (discState.hits.length) renderDiscList();
}

function onTedResults(msg) {
  if (msg.reqId !== discState.reqId) return; // 只认最新一次请求
  discState.loading = false;
  if (msg.error) { discMeta.textContent = '搜索失败：' + msg.error; return; }

  discState.nbPages = msg.nbPages;
  discMeta.textContent = '共 ' + msg.nbHits + ' 个演讲 · 第 ' + (msg.page + 1) + ' / ' +
    msg.nbPages + ' 页';

  // 已下载清单由宿主随结果一起给（见 panel.ts 的 case 'tedSearch'），按 slug 索引
  discState.cached = {};
  (msg.cached || []).forEach((c) => { if (c.slug) discState.cached[c.slug] = c.dirName; });
  discState.hits = msg.hits || [];
  discState.download = {};   // 换页/重搜后清掉上一轮残留

  if (!discState.hits.length) {
    discList.innerHTML = '<div class="center" style="padding:20px">没有匹配的演讲</div>';
    discFoot.innerHTML = '';
    return;
  }
  renderDiscList();

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

// ⚠️ 这一段是「模板字符串里的 webview JS 源码」，tsc 不会对它做类型擦除！
//    这里绝不能出现 as Xxx、类型注解等 TS 专有语法 ——
//    它们会原样留在生成的页面里 -> SyntaxError -> 整个 script 标签报废
//    -> 所有按钮（含「发现 TED」）全部点不动，且编辑器里毫无报错。
//    历史事故：写成 {} as Record<string, boolean>，症状即「点击发现 TED 没反应」。
//    注意本段不要使用反引号（会提前终止外层模板字符串），也不要写单反斜杠 n。
let libState = { multi: false, selected: {} };
let lastCachedItems = [];

// 用目录名找出素材标题，供宿主的确认框显示（拿不到就退回目录名）
function libTitleOf(dirName) {
  const it = lastCachedItems.find((x) => x.dirName === dirName);
  return it && it.title ? it.title : dirName;
}

function renderLibBar() {
  const bar = document.getElementById('libBar');
  if (libState.multi) {
    bar.innerHTML =
      '<button id="libDoDelete">删除所选 (' + Object.keys(libState.selected).length + ')</button>' +
      '<button id="libCancelMulti" class="ghost">取消</button>';
    document.getElementById('libDoDelete').onclick = () => {
      const names = Object.keys(libState.selected);
      if (!names.length) return;
      // ⚠️ 不要用 window.confirm 做确认：webview 是 sandboxed iframe，
      //    Chromium 会忽略它并恒返回 false —— 表现为「点了删除没反应」。
      //    确认一律交给宿主（vscode.window.showWarningMessage modal）。
      // 多选状态等宿主的 deleted 消息回来再清，用户取消时界面保持原状。
      vscode.postMessage({
        type: 'deleteCached',
        dirNames: names,
        titles: names.map(libTitleOf),
      });
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
      // 确认由宿主弹出（原因见 libDoDelete）
      vscode.postMessage({
        type: 'deleteCached',
        dirNames: lastCachedItems.map((it) => it.dirName),
        titles: lastCachedItems.map((it) => it.title),
      });
    };
  }
}

function onCachedList(msg) {
  if (msg.error) { libMeta.textContent = '读取缓存失败：' + msg.error; return; }
  lastCachedItems = msg.items || [];
  // 素材库是最新的磁盘事实 —— 顺带同步「发现 TED」的已下载标注
  syncDiscCached(lastCachedItems);
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
      // 确认由宿主弹出（原因见 libDoDelete）
      vscode.postMessage({ type: 'deleteCached', dirNames: [dn], titles: [libTitleOf(dn)] });
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

// hint 由宿主按错误类型给（缓存类错误不该把人引去配代理）；
// 不传时退回网络排查提示。
function showError(text, hint) {
  root.innerHTML =
    '<div class="center"><div style="max-width:460px;margin:0 auto;">' +
    '<div style="color:var(--err);margin-bottom:6px;">加载失败</div>' +
    '<div class="hint">' + esc(text) + '</div>' +
    '<div class="hint" style="margin-top:12px;">' +
      esc(hint || '如果是网络问题，请在设置中配置 listeningTrainer.proxy') +
    '</div>' +
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

  // 左右布局用 « »，上下布局用 ▴ ▾（朝向跟着布局走，不然会看不懂）
  const toggleArrow = state.stacked
    ? (state.listCollapsed ? '▾' : '▴')
    : (state.listCollapsed ? '»' : '«');

  root.innerHTML =
    '<div class="meta">' +
      '<h2>' + esc(m.title) + '</h2>' +
      '<div class="sub">' + esc(m.presenter || '') + ' · ' + m.sentences.length + ' 句 · ' +
        fmtTime(m.durationMs) + '</div>' +
    '</div>' +
    '<div class="main' + (state.listCollapsed ? ' collapsed' : '') +
      (state.stacked ? ' stacked' : '') + '">' +
      '<div class="list-toggle" id="listToggle" title="' +
        (state.listCollapsed ? '展开字幕列表' : '收起字幕列表') + '">' +
        toggleArrow + '</div>' +
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

  updateLayoutBtn();
}

function renderList() {
  const m = state.material;
  const list = document.getElementById('list');
  list.innerHTML = m.sentences.map((s, i) => {
    const r = state.results[i];
    const mark = r ? (r.correct ? '<span style="color:var(--ok)">✓</span>'
                               : '<span style="color:var(--err)">✗</span>') : '';
    // 时间轴被手工修过的句子打个标记，方便回头复查哪几句动过
    const tMark = s.timingEdited
      ? '<span class="t-mark" title="这一句的时间轴被手工修正过">✎</span>'
      : '';
    return '<div class="item' + (i === state.currentIndex ? ' active' : '') + '" data-i="' + i + '">' +
      '<span class="idx">' + (i + 1) + '</span>' +
      '<span class="txt">' + esc(s.text) + tMark + '</span>' +
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

/* ---------------- 逐句时间轴微调 ----------------
 *
 * 背景：TED 的 VTT 是「粗对齐」的，同一篇里有的句子很准、有的偏几百毫秒，
 * 这是字幕本身的问题，全局偏移量修不了。用户在听到某句对不上时，需要能
 * 就地微调这一句 —— 修正只写覆盖层（timing.json），原始时间轴不动，
 * 所以随时可以复原。详见 core/timing.ts 开头的设计说明。
 */

// 试听防抖句柄：连点 ± 时不能每一下都播（会变成噪音），停手后只播一次
let timingPreviewTimer = null;

/**
 * 毫秒级时间显示（形如 0:12.340）。
 * ⚠️ 不要用 fmtTime —— 它只到秒，微调时看不到毫秒等于闭着眼调。
 */
function fmtMs(ms) {
  if (ms == null) return '--:--';
  const t = Math.max(0, Math.round(ms));
  return Math.floor(t / 60000) + ':' +
    String(Math.floor((t % 60000) / 1000)).padStart(2, '0') + '.' +
    String(t % 1000).padStart(3, '0');
}

/**
 * 时间轴微调条。
 *
 * 折叠态只占一行 —— 时间轴不是每句都要调，长期展开会把听写区挤没。
 * 展开后只有起点/终点两组 ±（1s 粗调 + 0.1s 精调），外加复原。
 *
 * 刻意【不做】的两种按钮（2026-09-19 明确）：
 *   - 打点（把当前位置设为起点/终点）：人耳反应有 100~200ms 延迟，落点
 *     必然不准，还得靠 ±.1s 修，不如直接给 ± 省掉一个按钮。
 *   - 试听：调整后本来就会自动重播（见 scheduleTimingPreview），
 *     想再听一遍点已有的「播放 / 重播」即可。
 */
function timingHtml(s) {
  const head =
    '<div class="timing-head" id="timingHead" title="听到对不上的句子，点这里微调它的起止时间（改完会自动重播）">' +
      '<span>' + (state.timingOpen ? '▾' : '▸') + ' 时间轴微调</span>' +
      (s.timingEdited ? '<span class="badge ok">已修正</span>' : '') +
      '<span class="t-now">' + fmtMs(s.startMs) + '–' + fmtMs(s.endMs) + '</span>' +
    '</div>';
  if (!state.timingOpen) return '<div class="timing">' + head + '</div>';

  const row = (kind, label) =>
    '<div class="t-row">' +
      '<span class="t-lbl">' + label + '</span>' +
      '<button class="t-adj" data-k="' + kind + '" data-d="-1000" title="提前 1 秒">−1s</button>' +
      '<button class="t-adj" data-k="' + kind + '" data-d="-100" title="提前 0.1 秒">−.1s</button>' +
      '<button class="t-adj" data-k="' + kind + '" data-d="100" title="推后 0.1 秒">+.1s</button>' +
      '<button class="t-adj" data-k="' + kind + '" data-d="1000" title="推后 1 秒">+1s</button>' +
    '</div>';

  // 没有可复原的东西时整行不渲染（不占位、不留空行）
  const actions =
    (s.timingEdited ? '<button id="tReset" class="ghost">↺ 复原本句</button>' : '') +
    (state.timingCount > 0
      ? '<button id="tResetAll" class="ghost">复原全部 (' + state.timingCount + ')</button>'
      : '');

  return '<div class="timing">' + head +
    '<div class="timing-body">' +
      row('start', '起点') +
      row('end', '终点') +
      (actions ? '<div class="t-row">' + actions + '</div>' : '') +
    '</div>' +
  '</div>';
}

/** 调整完延后试听：连点 ± 时只播最后一次 */
function scheduleTimingPreview() {
  if (timingPreviewTimer) clearTimeout(timingPreviewTimer);
  timingPreviewTimer = setTimeout(() => {
    timingPreviewTimer = null;
    playCurrent();
  }, 300);
}

/**
 * 微调当前句的起点/终点（单位毫秒）。
 *
 * ⚠️ 必须【本地先改】再发消息：宿主回包到达前若仍按旧值算，连点时中间
 *    几次点击会被吞掉（表现为"点了不动"）。宿主回 timingPatched 后会以
 *    回推值为准覆盖，所以本地乐观更新是安全的。
 */
function adjTiming(kind, delta) {
  const m = state.material;
  const s = m && m.sentences[state.currentIndex];
  if (!s) return;
  let startMs = s.startMs;
  let endMs = s.endMs;
  if (kind === 'start') startMs = Math.max(0, startMs + delta);
  else endMs = endMs + delta;
  // 至少留 100ms：滑成零长度句就永远播不出声，比偏一点更糟
  if (endMs - startMs < 100) return;
  if (m.durationMs && endMs > m.durationMs) return;
  s.startMs = startMs;
  s.endMs = endMs;
  render();
  vscode.postMessage({
    type: 'setTiming',
    index: state.currentIndex,
    startMs: startMs,
    endMs: endMs,
  });
  scheduleTimingPreview();
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
      // 音频诊断是开发者工具：默认不渲染（listeningTrainer.showAudioDiagnostics）
      (state.showAudioDiag
        ? '<button id="diag" class="ghost" title="诊断音频加载">🔧</button>'
        : '') +
      '<span class="pos">' + (i + 1) + ' / ' + m.sentences.length +
        ' · ' + fmtTime(s.startMs) + '–' + fmtTime(s.endMs) + '</span>' +
    '</div>' +

    // 时间轴微调条（折叠态只占一行）
    timingHtml(s) +

    // 诊断面板与按钮同开关：没有按钮就不该留一个永远打不开的盒子
    (state.showAudioDiag
      ? '<div class="answer" id="diagBox" style="display:none">' +
          '<div class="lbl">音频加载诊断</div>' +
          '<div id="diagContent" class="hint" style="white-space:pre-wrap;font-size:11px"></div>' +
          '<div class="player" style="margin-top:8px">' +
            '<button id="diagBlob" class="ghost">用 Blob 重载</button>' +
            '<button id="diagData" class="ghost">用 DataURI 重载</button>' +
          '</div>' +
        '</div>'
      : '') +

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

  /* 时间轴微调的交互绑定 */
  const timingHeadEl = document.getElementById('timingHead');
  if (timingHeadEl) {
    timingHeadEl.onclick = () => {
      state.timingOpen = !state.timingOpen;
      render();
    };
  }
  document.querySelectorAll('.t-adj').forEach((el) => {
    el.onclick = () => adjTiming(el.dataset.k, Number(el.dataset.d));
  });
  const tResetBtn = document.getElementById('tReset');
  if (tResetBtn) {
    tResetBtn.onclick = () =>
      vscode.postMessage({ type: 'resetTiming', index: state.currentIndex });
  }
  const tResetAllBtn = document.getElementById('tResetAll');
  if (tResetAllBtn) {
    tResetAllBtn.onclick = () => vscode.postMessage({ type: 'resetAllTiming' });
  }

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

  // 诊断按钮默认不存在（开发者开关关着），绑定必须判空
  const diagBtn = document.getElementById('diag');
  if (diagBtn) {
    diagBtn.onclick = () => {
      const box = document.getElementById('diagBox');
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
      if (box.style.display === 'block') runDiag();
    };
    document.getElementById('diagBlob').onclick = () => reloadAsBlob();
    document.getElementById('diagData').onclick = () => reloadAsDataUri();
  }

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

  // ⚠️ 空输入（含纯空白）一律不送去判定。
  //
  // 为什么这是硬性要求：checkSentence(idx, 原句, '') 会把原句里【每一个词】
  // 都判成「漏听」，result.correct = false，宿主随即把这条结果写进错题库。
  // 一次手滑足以让诊断报告的「弱读盲区 TOP」「最常出错的词」全部失真，
  // 而且错题库是累积的 —— 之后看到的报告都不可信（2026-09-19 反馈）。
  //
  // trim() 覆盖空格、制表符、换行与全角空格。
  if (!ta.value.trim()) {
    ta.focus();
    showNotice('还没输入内容 —— 先写下你听到的部分，再检查。');
    return;
  }

  vscode.postMessage({
    type: 'check',
    sentenceIndex: state.currentIndex,
    input: ta.value,
  });
}

/* ---------------- 播放 ---------------- */

/**
 * 页面内通用提示条（位置与样式复用播放错误那条）。
 *
 * ⚠️ 为什么不能直接拿 showPlayerError 当通用提示：它的文案前缀固定是
 *    「播放失败：」—— 用来提示"还没输入内容"会让人以为音频坏了。
 */
function showNotice(text) {
  let box = document.getElementById('playerErr');
  if (!box) {
    box = document.createElement('div');
    box.id = 'playerErr';
    box.className = 'player-err';
    const p = document.getElementById('practice');
    if (p) p.appendChild(box);
  }
  box.textContent = text;
  box.style.display = 'block';
}

function showPlayerError(text) {
  // 播放错误必须可见 —— 早期用 .catch(() => {}) 静默吞掉，
  // 结果「点击播放没反应」完全无从排查。
  showNotice('播放失败：' + text);
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
      // 诊断按钮默认是关的（开发者开关），提示不能指向一个不存在的按钮
      (state.showAudioDiag
        ? '请点 🔧 查看诊断详情（含容器判定与播放器能力），并把扩展宿主输出里的 [LT-TRACE] 行发出来。'
        : '把扩展宿主输出里的 [LT-TRACE] 行发出来即可定位；需要更详细的现场信息时，' +
          '可在设置里开启 listeningTrainer.showAudioDiagnostics，界面上会出现 🔧 诊断按钮。')
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

  // ⚠️ 写进独立的 #reportView，不要写 #root ——
  //    写 #root 会污染练习界面：在发现/素材库视图下点「诊断报告」看不到反应
  //    （内容进了隐藏容器），而之后任何一次切回练习都会突然显示报告。
  reportView.innerHTML =
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
      '<div style="margin-top:16px">' +
        '<button id="back" class="ghost">返回练习</button>' +
        // 只有真有记录时才给清空入口：空库上摆一个「清空」按钮没有意义，
        // 反而让人以为藏着数据。确认框由宿主弹（不可逆操作）。
        (rep.totalAttempts > 0
          ? '<button id="clearStats" class="ghost" style="margin-left:8px;color:var(--err)"' +
            ' title="清空全部听力错误记录（不可撤销）">清空数据</button>'
          : '') +
      '</div>' +
    '</div>';

  // 切到报告视图（布局按钮会自动隐藏：它只在精听界面出现）
  showView('report');

  // 「返回练习」只是切回练习视图 —— #root 里一直是练习界面，不需要重绘
  const back = document.getElementById('back');
  if (back) back.onclick = () => showView('practice');

  // 清空错题库：确认与执行都在宿主侧，页面只发请求
  const clearStatsBtn = document.getElementById('clearStats');
  if (clearStatsBtn) {
    clearStatsBtn.onclick = () => vscode.postMessage({ type: 'clearMistakes' });
  }
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
