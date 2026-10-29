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
import { FavoriteEntry, FavoriteStore, TranslationQueue, baiduTranslate, baiduTranslateBatch } from '../core/favorites';
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
import { getDictionary } from '../core/dictionary';
import {
  DAY_MS,
  DEFAULT_LADDER_TEXT,
  DEFAULT_MAX_REQUEUE,
  DEFAULT_NEW_WORDS_PER_DAY,
  DEFAULT_ROUND_SIZE,
  ReviewCandidate,
  ReviewConfig,
  ReviewGrade,
  ReviewState,
  ReviewStore,
  buildExtra,
  buildRound0,
  gradeRequeue,
  normalizeConfig,
  reviewKey,
  schedule,
  selectPool,
} from '../core/review';
import { MistakeStore, trace } from '../extension';

export interface PanelDeps {
  adapters: MaterialSourceAdapter[];
  /**
   * 素材根目录（materialsDir 解析结果）。
   * ⚠️ 它同时也是【用户数据根】—— 收藏与错题记录就存在这里
   *    （favorites.json / stats/mistakes.jsonl，见 core/userdata.ts）。
   *    这样用户数据跟随 materialsDir，卸载重装不会丢。
   */
  cacheRoot: string;
  /** 离线词典（ECDICT 子集）文件路径 */
  dictPath: string;
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

/* ---------------- 复习（收藏单词的间隔重复） ---------------- */

/** 下发给页面的一张复习卡片。释义/例句每次都从收藏实时取，不落盘 */
interface ReviewCardPayload {
  key: string;
  favId: string;
  text: string;
  phonetic: string;
  translation: string;
  pending: boolean;
  sentenceText: string;
  sentenceTranslation: string;
  talkTitle: string;
  /** 有对应本地素材（能播例句） */
  canPlay: boolean;
  level: number;
  lastAt: number;
  dueAt: number;
  reviews: number;
  isNew: boolean;
}

/** 本场复习的评分统计 */
interface ReviewStats {
  know: number;
  fuzzy: number;
  unknown: number;
}

/**
 * 一场复习的会话态。
 *
 * ⚠️ 只在内存里，不落盘：刷新页面/重开面板就重新组一场。
 *    进度（level/dueAt）在每次评分时立刻写 ReviewStore，所以中途退出不丢数据。
 *
 * 轮次模型：round 0 = 到期卡与新词混合的首轮；轮末把需要重看的卡收进
 * `nextItems` 作为下一轮；一张卡每场最多额外露面 maxRequeue 次。
 */
interface ReviewSession {
  round: number;
  /** 当前轮的卡片 key 队列 */
  items: string[];
  pos: number;
  /** 下一轮的队列（轮末确定，等页面点「继续」才生效） */
  nextItems: string[];
  /** key → 本场已重排次数（决定还剩多少重排额度） */
  requeues: Record<string, number>;
  /** 本场出现过的 key（「再来 5 张」用来排除重复） */
  seen: Record<string, boolean>;
  /**
   * 「已评分待确认」的卡（没看答案就点了不认识/模糊）。
   * 非 null 时游标【停在原地】，页面显示答案 + 只留一个「下一个」。
   */
  heldKey: string | null;
  /** 全场累计评分 */
  stats: ReviewStats;
  /** 本轮评分（过场页显示） */
  roundStats: ReviewStats;
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
  /** 收藏（单词/短语/整句）：用户数据，存素材根目录的 favorites.json */
  private readonly favs: FavoriteStore;
  /** 复习进度：用户数据，存素材根目录的 stats/review.json */
  private readonly reviews: ReviewStore;
  /** 当前复习会话（内存态，见 ReviewSession 注释） */
  private reviewSession: ReviewSession | null = null;
  /** 百度翻译串行队列（标准版 QPS=1，队列内强制间隔） */
  private readonly tQueue = new TranslationQueue();
  /** 手动「更新翻译」批次剩余条数（>0 时 webview 显示进行中） */
  private favRemaining = 0;
  /** 从收藏视图跳回练习时要定位的句号（pushMaterial 消费后重置为 -1） */
  private pendingJumpTo = -1;
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
      'listenAndWrite',
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
    // 用户数据（错题/收藏）与素材同根 —— 跟随 materialsDir，卸载重装不丢
    this.store = new MistakeStore(deps.cacheRoot);
    this.favs = new FavoriteStore(deps.cacheRoot);
    this.reviews = new ReviewStore(deps.cacheRoot);

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

  /** 百度翻译 API 是否已配置（appId 与密钥都非空） */
  private isBaiduConfigured(): boolean {
    const cfg = vscode.workspace.getConfiguration('listenAndWrite');
    return !!cfg.get<string>('baiduAppId', '').trim() && !!cfg.get<string>('baiduSecret', '').trim();
  }

  /**
   * 把收藏条目解析到素材目录名。解析顺序：
   *   slug（新数据有 sourceUrl，权威）→ 收藏时写死的 dirName → 课程标题兜底（旧数据）。
   * 命中后必须校验「句号落在该素材句数范围内」—— 对不上就视为解析失败。
   * 宁可不播也不播错误素材（2026-09-29 反馈「播放的不是对应素材」的根源就是
   * 标题兜底匹配到了同名/相近素材，句号越界又被静默钳到最后一句）。
   */
  private resolveFavDir(ctx: any): string {
    const idx = Number(ctx.sentenceIndex) || 0;
    const slug = slugFromUrl(ctx.sourceUrl || '');
    const cached = this.scanCached().filter((i) => i.hasAudio);
    const fits = (c: CachedMaterial) => c.sentenceCount > idx;
    const bySlug = slug ? cached.find((c) => c.slug === slug) : undefined;
    if (bySlug && fits(bySlug)) return bySlug.dirName;
    if (ctx.dirName) {
      const byStored = cached.find((c) => c.dirName === ctx.dirName);
      if (byStored && fits(byStored)) return byStored.dirName;
    }
    if (ctx.talkTitle) {
      const t = String(ctx.talkTitle);
      const byTitle = cached.find((c) => c.title === t && fits(c));
      if (byTitle) return byTitle.dirName;
    }
    return '';
  }

  /** 离线词典查询（单例共享）。未命中/词典不可用返回 null，调用方走百度兜底 */
  private async lookupDict(word: string): Promise<{ phonetic: string; translation: string } | null> {
    return getDictionary(this.deps.dictPath).lookup(word);
  }

  /**
   * 把收藏列表（+配置状态+批次进度+复习状态）推给页面。
   * dirName 动态解析，见 resolveFavDir。
   * ⚠️ 复习状态按【词形小写】取（不是收藏 id）—— 与 ReviewStore 的主键一致。
   */
  private pushFavorites(updating?: boolean): void {
    const states = this.reviews.all();
    const favorites = this.favs.list().map((e) => {
      const st = e.type === 'word' ? states[reviewKey(e.text)] : undefined;
      return {
        ...e,
        dirName: this.resolveFavDir(e.context || {}),
        review: st
          ? { level: st.level, dueAt: st.dueAt, mastered: !!st.mastered }
          : null,
      };
    });
    this.webview.postMessage({
      type: 'favList',
      favorites,
      baiduConfigured: this.isBaiduConfigured(),
      updating: !!updating,
    });
  }

  /* ---------------- 复习 ---------------- */

  /** 复习配置（读 vscode 设置，逐项容错回退默认值） */
  private reviewConfig(): ReviewConfig {
    const cfg = vscode.workspace.getConfiguration('listenAndWrite');
    return normalizeConfig({
      ladder: cfg.get('reviewLadder', DEFAULT_LADDER_TEXT),
      newWordsPerDay: cfg.get('reviewNewWordsPerDay', DEFAULT_NEW_WORDS_PER_DAY),
      roundSize: cfg.get('reviewRoundSize', DEFAULT_ROUND_SIZE),
      maxRequeue: cfg.get('reviewMaxRequeue', DEFAULT_MAX_REQUEUE),
    });
  }

  /** 复习池：从收藏里筛出可复习的单词 */
  private reviewPool(): ReviewCandidate[] {
    return selectPool(this.favs.list());
  }

  /** 24 小时内（含已到期）待复习的词数 —— 结束页/首页显示 */
  private reviewPendingCount(now: number): number {
    const states = this.reviews.all();
    let n = 0;
    for (const k of Object.keys(states)) {
      const s = states[k];
      if (!s.mastered && Number(s.dueAt) <= now + DAY_MS) n++;
    }
    return n;
  }

  /** 复习首页（未开始 / 本场结束后的返回页） */
  private pushReviewHome(message?: string): void {
    const now = Date.now();
    const pool = this.reviewPool();
    const states = this.reviews.all();
    const cfg = this.reviewConfig();
    let due = 0;
    let mastered = 0;
    let fresh = 0;
    for (const c of pool) {
      const st = states[c.key];
      if (!st) {
        fresh++;
        continue;
      }
      if (st.mastered) {
        mastered++;
        continue;
      }
      if (Number(st.dueAt) <= now) due++;
    }
    const used = this.reviews.dailyUsed(now);
    const newLeft = Math.max(0, Math.min(cfg.newWordsPerDay - used, fresh));
    this.webview.postMessage({
      type: 'reviewHome',
      dueCount: due,
      newLeft,
      newTotal: fresh,
      masteredCount: mastered,
      totalWords: pool.length,
      roundSize: cfg.roundSize,
      pendingCount: this.reviewPendingCount(now),
      message: message || '',
    });
  }

  /** 把一条复习候选组装成下发给页面的卡片 */
  private buildReviewCard(
    c: ReviewCandidate,
    fav: FavoriteEntry,
    state: ReviewState | undefined
  ): ReviewCardPayload {
    const ctx: any = fav.context || {};
    return {
      key: c.key,
      favId: fav.id,
      text: fav.text,
      // ⚠️ phonetic 不在 FavoriteEntry 的类型里（由 setPhonetic 以 any 写入），
      //    这里也按 any 读，拿不到就当没有音标
      phonetic: String((fav as any).phonetic ?? ''),
      translation: String(fav.translation ?? ''),
      pending: !!fav.pending,
      sentenceText: String(ctx.sentenceText ?? ''),
      sentenceTranslation: String(ctx.sentenceTranslation ?? ''),
      talkTitle: String(ctx.talkTitle ?? ''),
      canPlay: !!this.resolveFavDir(ctx),
      // ⚠️ 档位显示要按【当前】阶梯长度夹一下：用户改过阶梯长度（或升级前留下的
      //    旧数据）时，存档 level 可能越界，不夹会显示出「第 7 档」这种不存在的档位。
      //    只影响显示 —— schedule 读的是存档里的原值，不受这里影响。
      level: Math.min(state?.level ?? 0, this.reviewConfig().ladder.length - 1),
      lastAt: state?.lastAt ?? 0,
      dueAt: state?.dueAt ?? 0,
      reviews: state?.reviews ?? 0,
      isNew: !state,
    };
  }

  /** 收藏里可复习的单词：key → FavoriteEntry（推一张卡就要用它取释义/例句） */
  private wordFavByKey(): Map<string, FavoriteEntry> {
    const m = new Map<string, FavoriteEntry>();
    for (const f of this.favs.list()) {
      if (f.type === 'word') m.set(reviewKey(f.text), f);
    }
    return m;
  }

  /**
   * 推当前游标处的卡片。
   *
   * held = true 表示这张卡【已经评过分】、只是还没往下走 —— 页面据此自动翻面、
   * 收掉三个自评按钮，只留一个「下一个/完成」。
   * 触发场景：没看答案就点了「不认识/模糊」。用户是蒙的或者根本没想起来，
   * 直接翻页等于白考一次，得让他先看一眼答案再继续。
   */
  private postReviewCard(s: ReviewSession, favByKey: Map<string, FavoriteEntry>, held: boolean): void {
    const key = s.items[s.pos];
    const fav = favByKey.get(key) as FavoriteEntry;
    const cand: ReviewCandidate = {
      key,
      favId: fav.id,
      text: fav.text,
      createdAt: Number(fav.createdAt) || 0,
    };
    s.seen[key] = true;
    this.webview.postMessage({
      type: 'reviewCard',
      card: this.buildReviewCard(cand, fav, this.reviews.get(key)),
      round: s.round,
      index: s.pos,
      total: s.items.length,
      stats: { ...s.stats },
      held,
    });
  }

  /**
   * 推进到下一张卡；当前轮走完则做轮末判定。
   *
   * 轮末：`nextItems` 非空 → 下发过场页，等页面点「继续」；
   *       为空 → 本场结束。
   * ⚠️ 队列里的卡可能因为用户在中途删了收藏而消失 → 这里跳过（不给空白卡片）。
   */
  private advanceReview(): void {
    const s = this.reviewSession;
    if (!s) return;
    // 走到这儿一律意味着「停留态结束」
    s.heldKey = null;
    const favByKey = this.wordFavByKey();
    while (s.pos < s.items.length && !favByKey.has(s.items[s.pos])) s.pos++;

    if (s.pos < s.items.length) {
      this.postReviewCard(s, favByKey, false);
      return;
    }

    // ---- 轮末 ----
    if (s.nextItems.length) {
      for (const k of s.nextItems) s.requeues[k] = (s.requeues[k] || 0) + 1;
      this.webview.postMessage({
        type: 'reviewRoundEnd',
        finishedRound: s.round + 1,
        stats: { ...s.roundStats },
        nextCount: s.nextItems.length,
      });
      return;
    }

    const now = Date.now();
    this.webview.postMessage({
      type: 'reviewEnd',
      stats: { ...s.stats },
      pendingCount: this.reviewPendingCount(now),
    });
    this.reviewSession = null;
  }

  /**
   * 重推当前卡：停留在原地就还原「已评分待确认」的形态，否则正常推进。
   *
   * 用于会发生重渲染的入口（切回复习视图、补译完成后刷新卡片）——
   * 这些入口如果直接调 advanceReview()，会把用户正在看的答案顶掉、白丢一次停留。
   */
  private repushReviewCard(): void {
    const s = this.reviewSession;
    if (!s) return;
    if (!s.heldKey) {
      this.advanceReview();
      return;
    }
    const favByKey = this.wordFavByKey();
    if (s.items[s.pos] !== s.heldKey || !favByKey.has(s.heldKey)) {
      // 停留的那张卡已经不在了（收藏被删）→ 正常推进
      this.advanceReview();
      return;
    }
    this.postReviewCard(s, favByKey, true);
  }

  /** 开一场复习（首轮：新词 + 到期卡打散） */
  private startReviewSession(): void {
    const now = Date.now();
    const pool = this.reviewPool();
    if (!pool.length) {
      this.pushReviewHome('收藏里还没有可复习的单词。先到「收藏」收藏几个单词吧。');
      return;
    }
    const cfg = this.reviewConfig();
    const r0 = buildRound0(pool, this.reviews.all(), cfg, now, this.reviews.dailyUsed(now));
    if (!r0.items.length) {
      this.pushReviewHome('今日复习已全部完成。');
      return;
    }
    this.reviewSession = {
      round: 0,
      items: r0.items.map((c) => c.key),
      pos: 0,
      nextItems: [],
      requeues: {},
      seen: {},
      heldKey: null,
      stats: { know: 0, fuzzy: 0, unknown: 0 },
      roundStats: { know: 0, fuzzy: 0, unknown: 0 },
    };
    this.advanceReview();
  }


  /**
   * 把一条收藏排进百度翻译队列（单词/短语用）。
   * 队列串行 + 强制间隔，天然满足 QPS=1；失败保持 pending，
   * 用户在收藏视图点「更新翻译」可再次重试。
   */
  private enqueueFavTranslation(fav: FavoriteEntry, batch: boolean): void {
    this.tQueue.push(async () => {
      try {
        const cfg = vscode.workspace.getConfiguration('listenAndWrite');
        const appId = cfg.get<string>('baiduAppId', '').trim();
        const secret = cfg.get<string>('baiduSecret', '').trim();
        if (!appId || !secret) return;
        const t = await baiduTranslate(
          fav.text,
          appId,
          secret,
          cfg.get<string>('proxy', '') || undefined
        );
        this.favs.setTranslation(fav.id, t);
        trace('[LT-TRACE] 收藏译文就绪: ' + fav.text + ' → ' + t);
      } catch (e: any) {
        // 保持 pending，收藏视图里显示 ⏳，可再次手动重试
        trace('[LT-TRACE] 收藏翻译失败 ' + fav.text + ': ' + String(e?.message ?? e));
      } finally {
        if (batch) {
          this.favRemaining = Math.max(0, this.favRemaining - 1);
          this.pushFavorites(this.favRemaining > 0);
        }
      }
    }).catch(() => { /* 队列链已吞异常，这里兜底 */ });
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
        // ⚠️ 必须先推收藏再推素材：页面的已收藏标记完全依赖 state.favorites，
        //    只推素材的话首屏标记是空的，用户得先进一次「收藏」视图才看得到。
        this.pushFavorites();
        this.pushMaterial();
        break;

      /* ---------------- 收藏（单词/短语/整句） ---------------- */

      case 'favAdd': {
        const fav = msg.fav ?? {};
        const type = String(fav.type ?? '');
        const text = String(fav.text ?? '').trim();
        if (!text || (type !== 'word' && type !== 'phrase' && type !== 'sentence')) break;
        const ctx = fav.context ?? {};
        const idx = Number(ctx.sentenceIndex);
        // 整句译文以宿主素材为权威（webview 传来的只作兜底）
        let sentenceTranslation = String(ctx.sentenceTranslation ?? '');
        if (this.material?.sentences[idx]) {
          sentenceTranslation = this.material.sentences[idx].translation || sentenceTranslation;
        }
        const sourceUrl = String(ctx.sourceUrl ?? '');
        // 对齐素材目录名：收藏视图「跳回原句」要用（openCached 按 dirName 打开）
        const dirName = this.scanCached().find(
          (c) => c.slug === slugFromUrl(sourceUrl) && c.hasAudio
        )?.dirName;
        const { fav: saved, deduped } = this.favs.add({
          type,
          text,
          translation: type === 'sentence' ? sentenceTranslation : '',
          pending: type !== 'sentence',
          context: {
            sentenceText: String(ctx.sentenceText ?? ''),
            sentenceTranslation,
            talkTitle: String(ctx.talkTitle ?? ''),
            sourceUrl,
            sentenceIndex: Number.isFinite(idx) ? idx : 0,
            dirName,
          },
        });
        // 查词管线：单词先查离线词典（音标+释义，本地零成本），未命中走百度；
        // 短语直接百度；整句译文已就绪（来自 TED 字幕）
        if (type !== 'sentence') {
          if (type === 'word') {
            const entry = await this.lookupDict(text);
            if (entry) {
              this.favs.setTranslation(saved.id, entry.translation);
              this.favs.setPhonetic(saved.id, entry.phonetic);
              this.pushFavorites();
              this.webview.postMessage({ type: 'favAdded', deduped, fav: saved });
              break;
            }
          }
          if (this.isBaiduConfigured()) {
            this.enqueueFavTranslation(saved, false);
          }
        }
        this.pushFavorites();
        this.webview.postMessage({ type: 'favAdded', deduped, fav: saved });
        break;
      }

      case 'favRemove': {
        const id = String(msg.id ?? '');
        if (id) this.favs.remove(id);
        this.pushFavorites();
        break;
      }

      case 'favListRequest':
        this.pushFavorites();
        break;

      /* ---------------- 复习（收藏单词的间隔重复） ---------------- */

      case 'reviewListRequest':
        // 进入复习视图：有进行中的场次就续上（含「已评分待确认」的停留态），否则给首页
        if (this.reviewSession) this.repushReviewCard();
        else this.pushReviewHome();
        break;

      case 'reviewStart':
        this.startReviewSession();
        break;

      case 'reviewGrade': {
        const s = this.reviewSession;
        const key = reviewKey(String(msg.key ?? ''));
        const grade = String(msg.grade ?? '') as ReviewGrade;
        if (!s || !key) break;
        if (grade !== 'know' && grade !== 'fuzzy' && grade !== 'unknown') break;
        // ⚠️ 只接受「当前这张卡」的评分：页面连点/消息乱序会让游标与卡片错位，
        //    一旦错位就会把评分写到别的词头上，这里必须自己再防一次。
        //    丢弃时重推当前卡，让页面从「按钮已禁用」的死状态里恢复。
        if (s.items[s.pos] !== key) {
          this.repushReviewCard();
          break;
        }
        const now = Date.now();
        const cfg = this.reviewConfig();
        const prev = this.reviews.get(key);
        // 首次复习 = 引入一个新词，逐张消耗今日额度（中途退出不浪费额度）
        if (!prev) this.reviews.addDaily(1, now);
        const requeues = s.requeues[key] || 0;
        this.reviews.set(key, schedule(prev, grade, requeues, cfg, now));
        s.stats[grade]++;
        s.roundStats[grade]++;
        if (gradeRequeue(grade, requeues, cfg) > 0) s.nextItems.push(key);

        /*
         * 没看答案就点「不认识 / 模糊」→ 停在原地让用户看一眼答案。
         *
         * ⚠️ 这里必须【不推进游标】。用户没看答案就自评「不认识」，说明是真的没想起来，
         *    立刻翻页等于白考一次；而「认识」不需要停留（他会，没什么可看的）。
         *    游标不动还有个好处：切走视图再回来能原样恢复这次停留（见 repushReviewCard）。
         */
        if (!msg.revealed && grade !== 'know') {
          s.heldKey = key;
          this.repushReviewCard();
          break;
        }
        s.pos++;
        this.advanceReview();
        break;
      }

      case 'reviewNext': {
        // 停留态里的「下一个 / 完成」：这才真正往下走
        const s = this.reviewSession;
        if (!s) break;
        if (!s.heldKey) {
          this.repushReviewCard();
          break;
        }
        s.heldKey = null;
        s.pos++;
        this.advanceReview();
        break;
      }

      case 'reviewNextRound': {
        const s = this.reviewSession;
        if (!s || !s.nextItems.length) break;
        s.round++;
        s.items = s.nextItems.slice();
        s.nextItems = [];
        s.pos = 0;
        s.roundStats = { know: 0, fuzzy: 0, unknown: 0 };
        this.advanceReview();
        break;
      }

      case 'reviewExtra': {
        // 「再来 5 张」：取还没到期的词提前复习，不占用今日新词额度
        const s = this.reviewSession;
        const exclude = new Set<string>(s ? Object.keys(s.seen) : []);
        const pool = this.reviewPool();
        const states = this.reviews.all();
        const picks = buildExtra(pool, states, exclude, 5);
        if (!picks.length) {
          /*
           * 「再来 5 个」只挑已排期的词（buildExtra）。所以空结果有两种原因，
           * 必须分开说 —— 只说「没有更多可复习的词了」会让用户对着 74 个
           * 没复习过的收藏词一头雾水：明明有词，凭什么说没有了。
           */
          const freshLeft = pool.filter((c) => !states[c.key]).length;
          this.pushReviewHome(
            freshLeft
              ? '已排期的词都练完了。收藏里还有 ' + freshLeft + ' 个词从没复习过，' +
                '把设置里的 listenAndWrite.reviewNewWordsPerDay 调大（当前 ' +
                this.reviewConfig().newWordsPerDay + '）就能每天引入更多。'
              : '没有更多可复习的词了。'
          );
          break;
        }
        this.reviewSession = {
          round: 0,
          items: picks.map((c) => c.key),
          pos: 0,
          nextItems: [],
          requeues: {},
          seen: {},
          heldKey: null,
          stats: { know: 0, fuzzy: 0, unknown: 0 },
          roundStats: { know: 0, fuzzy: 0, unknown: 0 },
        };
        this.advanceReview();
        break;
      }

      case 'reviewRestart': {
        // 收藏列表里「已掌握」的词 → 重新加入复习（level 归 0，立刻到期）
        const key = reviewKey(String(msg.key ?? ''));
        if (key) this.reviews.restart(key, Date.now());
        this.pushFavorites();
        break;
      }

      case 'reviewHome':
        this.reviewSession = null;
        this.pushReviewHome();
        break;

      case 'favRetry': {
        // 手动「更新翻译」：只在用户进入收藏界面点按钮时才补译（不自动跑），
        // 失败的条目保持 pending，下次再点继续重试
        if (!this.isBaiduConfigured()) {
          this.webview.postMessage({
            type: 'notice',
            message:
              '请先在设置里填写百度翻译的 APP ID 与密钥（listenAndWrite.baiduAppId / baiduSecret）。',
          });
          break;
        }
        const pending = this.favs.list().filter((e) => e.pending);
        // 统一查词管线：单词先查离线词典（本地、零成本），未命中的再进百度批量
        const baiduTargets: FavoriteEntry[] = [];
        for (const e of pending) {
          if (e.type === 'word') {
            const entry = await this.lookupDict(e.text);
            if (entry) {
              this.favs.setTranslation(e.id, entry.translation);
              this.favs.setPhonetic(e.id, entry.phonetic);
              continue;
            }
          }
          baiduTargets.push(e);
        }
        this.favRemaining = baiduTargets.length;
        this.pushFavorites(this.favRemaining > 0);
        if (!baiduTargets.length) break;
        // 单请求批量查：q 用 \n 分行、百度按行返回（N 条只占 1 次请求额度），
        // 超过单请求字节上限时 baiduTranslateBatch 内部自动分块（分块间仍走 QPS 间隔）
        const cfg = vscode.workspace.getConfiguration('listenAndWrite');
        const appId = cfg.get<string>('baiduAppId', '').trim();
        const secret = cfg.get<string>('baiduSecret', '').trim();
        const proxy = cfg.get<string>('proxy', '') || undefined;
        this.tQueue.push(async () => {
          try {
            const results = await baiduTranslateBatch(
              baiduTargets.map((e) => e.text),
              appId,
              secret,
              proxy
            );
            results.forEach((t, i) => {
              if (t && baiduTargets[i]) this.favs.setTranslation(baiduTargets[i].id, t);
            });
            trace('[LT-TRACE] 批量翻译完成: ' + results.length + ' 条');
          } catch (e: any) {
            trace('[LT-TRACE] 批量翻译失败: ' + String(e?.message ?? e));
          } finally {
            this.favRemaining = 0;
            this.pushFavorites(false);
            // 复习卡片上的「重新查询」走的也是这条通道：补译完成后重推当前卡，
            // 让新拿到的释义立刻出现在翻面上（同一张卡不重置翻面状态）。
            // ⚠️ 走 repushReviewCard 而不是 advanceReview：后者会把「已评分待确认」
            //    的停留态顶掉，等于白丢一次停留。
            if (this.reviewSession) this.repushReviewCard();
          }
        }).catch(() => { /* 队列链已吞异常 */ });
        break;
      }

      case 'favWordLookup': {
        // 收藏视图：展开短语中的某个单词 → 查离线词典。
        // 本地查询、零成本、不联网；未命中（found:false）页面显示「未收录」，
        // 不走百度兜底（Q12 决策：想看完整翻译就把它收藏成单词）
        const favId = String(msg.favId ?? '');
        const word = String(msg.word ?? '').trim();
        if (!word) break;
        const entry = await this.lookupDict(word);
        this.webview.postMessage({
          type: 'favWordInfo',
          favId,
          word,
          found: !!entry,
          phonetic: entry?.phonetic ?? '',
          translation: entry?.translation ?? '',
        });
        break;
      }

      case 'favPlayExample': {
        // 收藏视图「例句」🔊：按收藏条目定位素材目录，应用时间轴修正层后取该句
        // start/end，把音频以 asWebviewUri 发给页面播放（CSP 已放行 cspSource）。
        // dirName 解析顺序与 pushFavorites 一致：slug 对齐 → 课程标题兜底
        const favId = String(msg.favId ?? '');
        const entry = this.favs.list().find((x) => x.id === favId);
        if (!entry) break;
        const ctx = entry.context || ({} as any);
        const dir = this.resolveFavDir(ctx);
        if (!dir) {
          trace('[LT-TRACE] favPlayExample：dir 解析失败 favId=' + favId);
          this.webview.postMessage({
            type: 'notice',
            message: '该收藏没有对应的本地素材，无法播放例句。',
          });
          break;
        }
        const dirPath = path.join(this.deps.cacheRoot, dir);
        trace('[LT-TRACE] favPlayExample：dir=' + dir + ' sentenceIndex=' + ctx.sentenceIndex);
        try {
          const m = JSON.parse(
            fs.readFileSync(path.join(dirPath, 'material.json'), 'utf8')
          ) as ListeningMaterial;
          const info = JSON.parse(
            fs.readFileSync(path.join(dirPath, 'audio.json'), 'utf8')
          ) as AudioInfo;
          const idx = Number(ctx.sentenceIndex) || 0;
          const overrides = readTimingOverrides(dirPath);
          const clamped = clampSentencesToAudio(
            applyTimingOverrides(m.sentences, overrides, info.durationMs),
            info.durationMs
          );
          // ⚠️ 句号必须真的落在这个素材的句数范围内：越界说明 dirName 解析
          //    到了错误的素材。绝不静默钳到最后一句 —— 那会播出完全无关的音频
          //    （2026-09-29 反馈「播放的不是对应素材」就是这么被钳出来的）
          if (idx >= clamped.length) {
            trace('[LT-TRACE] favPlayExample：句号越界 idx=' + idx + '，素材「' +
              (m.title || dir) + '」共 ' + clamped.length + ' 句 —— dirName 对错了素材');
            this.webview.postMessage({
              type: 'notice',
              message: '例句句号（' + (idx + 1) + '）超出素材「' + (m.title || dir) +
                '」的句数范围，未播放。',
            });
            break;
          }
          const s = clamped[idx];
          const audioPath = relocateAudioPath(dirPath, info) || path.join(dirPath, 'audio.mp3');
          trace('[LT-TRACE] favExampleAudio 下发：' + audioPath + ' ' + s.startMs + '-' + s.endMs);
          this.webview.postMessage({
            type: 'favExampleAudio',
            favId,
            url: this.webview.asWebviewUri(vscode.Uri.file(audioPath)).toString(),
            startMs: s.startMs,
            endMs: s.endMs,
            mime: info.format === 'aac' ? 'audio/aac'
              : (info.format === 'mp3' ? 'audio/mpeg' : 'audio/mp4'),
          });
        } catch (e: any) {
          trace('[LT-TRACE] favPlayExample 异常：' + String(e?.message ?? e));
          this.webview.postMessage({
            type: 'notice',
            message: '例句播放失败：' + String(e?.message ?? e),
          });
        }
        break;
      }

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
        await this.sendAudioBytes(msg.uri, msg.mime);
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
          // 收藏视图「跳回原句」：带上句号，pushMaterial 消费后自动复位
          const jumpTo = Number(msg.sentenceIndex);
          this.pendingJumpTo =
            Number.isFinite(jumpTo) && jumpTo >= 0 ? Math.floor(jumpTo) : -1;
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
   * 读取音频文件并回传字节。
   * 走宿主 fs，不经过 webview 资源协议，因此不受 401 影响。
   *
   * @param requestedUri 页面声明的 vscode-resource 音频地址（例句播放可能请求
   *        非当前素材的文件）。提供时从中解码出 fs 路径 —— 但**必须在
   *        cacheRoot 之内**（webview 不可信，防任意文件读取），否则回退当前素材。
   * @param requestedMime 页面声明的期望 MIME，原样回传给页面包 Blob 用。
   */
  private async sendAudioBytes(requestedUri?: string, requestedMime?: string): Promise<void> {
    let audioPath = this.material?.audio?.path;
    let format = this.material?.audio?.format ?? null;

    if (requestedUri) {
      try {
        const u = new URL(requestedUri);
        let p = decodeURIComponent(u.pathname);
        // vscode-resource 的 pathname 形如 '/d%3A/ListeningMaterials/...'（Windows 盘符前有 /）
        if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
        const resolved = path.normalize(p);
        const root = path.normalize(this.deps.cacheRoot);
        if (!resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
          trace('[LT-TRACE] sendAudioBytes：拒绝 cacheRoot 之外的路径 ' + resolved);
          this.webview.postMessage({ type: 'audioBytes', error: 'path-outside-cacheRoot' });
          return;
        }
        audioPath = resolved;
        const ext = path.extname(resolved).toLowerCase();
        format = ext === '.mp3' ? 'mp3' : ext === '.aac' ? 'aac' : 'm4a';
      } catch (e: any) {
        trace('[LT-TRACE] sendAudioBytes：解析 requestedUri 失败 ' + String(e?.message ?? e));
      }
    }

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
        // 页面据此选 MIME；requestedMime 优先（与请求声明一致）
        format: format ?? null,
        mime: requestedMime || null,
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
      vscode.workspace.getConfiguration('listenAndWrite').get<string>('proxy', '') || undefined;
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
        // 收藏「跳回原句」靠它解析 slug → 素材目录；缺失会让 dirName 永远为空
        sourceUrl: this.material.sourceUrl || '',
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
      // 收藏视图「跳回原句」：-1 = 不跳（页面据此决定 currentIndex）
      jumpTo: this.pendingJumpTo,
    });
    this.pendingJumpTo = -1;
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
        .getConfiguration('listenAndWrite')
        .get<boolean>('showAudioDiagnostics', false),
      baiduConfigured: this.isBaiduConfigured(),
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
    /* 已收藏标记：只改文字颜色，不铺任何背景。
       charts-* 是 VS Code 按主题给出的图表色（浅色主题是加深版，深色主题是提亮版），
       取不到时用两套主题都能读的中间值兜底。 */
    --fav-word: var(--vscode-charts-yellow, #b58900);
    --fav-phrase: var(--vscode-charts-blue, #3794ff);
    --fav-sentence: var(--vscode-charts-green, #3fa66a);
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
  /* 全局按钮：比默认小一号（导航/播放/检查等所有页面共用）；
     答案面板里的收藏按钮（.fav-bar button，11px）比这还要再小一号 */
  button {
    padding: 3px 10px; background: var(--accent); color: var(--accent-fg);
    border: none; border-radius: 3px; cursor: pointer;
    font-family: inherit; font-size: 12px; white-space: nowrap;
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
  /* 字幕列表里的已收藏标记：语义与答案面板一致（黄=单词 / 蓝=短语 / 绿=整句），
   * 但【不加 cursor:pointer】—— 整行是一个点击区，逐词看起来可点会误导。
   * ⚠️ skip-ink 必须关掉：默认 auto 会在 g / y / p / q 的下伸部把下划线断开，
   *    列表字号小、线又贴着基线，看起来就像「下划线坏了」（答案面板偏移 3px
   *    刚好绕过下伸部，所以那边看着正常）。 */
  .lmark { text-decoration: underline; text-underline-offset: 3px; text-decoration-skip-ink: none; }
  .lmark.fw { color: var(--fav-word); text-decoration-thickness: 1px; }
  .lmark.fp { color: var(--fav-phrase); text-decoration-thickness: 2px; }
  .lmark.fs { text-decoration: underline wavy; text-decoration-thickness: 1px; }
  .item.fav-sentence .txt { color: var(--fav-sentence); }
  /* 当前行不再叠 filter：inline 元素单独合成会让下划线糊/错位，
   * 颜色直接保留（charts 色在深色选中底上可读）。 */

  /* 右：练习区。
     min-height: 0 必须有：flex 子项默认 min-height:auto，会被内容撑到超过
     #root，然后被 overflow:hidden 裁掉 —— 表现就是「下面看不见也滚不动」
     （2026-09-20 反馈）。收缩后靠 overflow-y:auto 内部滚动。
     滚动条按需求隐藏（2026-09-20）：滚轮/触摸仍可滚，只是不显示滚动条。 */
  .practice {
    flex: 1 1 55%; display: flex; flex-direction: column;
    padding: 12px; gap: 10px;
    min-height: 0; overflow-y: auto;
    scrollbar-width: none;
  }
  .practice::-webkit-scrollbar { display: none; }
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

  /* ---- 答案面板点选收藏 ----
   * token = 英文答案按词切开的可点击片段；选中高亮，相邻词可扩展成短语 */
  .tok { cursor: pointer; border-radius: 3px; padding: 0 1px; }
  .tok:hover { background: rgba(128,128,128,.18); }
  /* 已收藏标记只改文字色 + 下划线：不铺底色、不加边框，盒模型与行高完全不变。
   * ⚠️ 必须排在 .tok.sel 之前 —— 同权重靠后覆盖，选中态要压过收藏标记。
   * ⚠️ 整句标记也逐 token 打 class：text-decoration 会向下传播且子元素无法取消，
   *    挂在 .ans-line 上会让「选中态」也拖着一条波浪线。 */
  .tok.fav-word {
    color: var(--fav-word);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }
  .tok.fav-phrase {
    color: var(--fav-phrase);
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
  }
  /* 整句里没被单词/短语单独命中的词：只加波浪线，颜色继承 .ans-line */
  .tok.fav-sentence {
    text-decoration: underline wavy;
    text-decoration-thickness: 1px;
    text-underline-offset: 4px;
  }
  /* 答案正文容器：整句收藏只在这层染绿，标点与空格跟着变色 */
  .ans-line { line-height: 1.6; }
  .ans-line.fav-sentence { color: var(--fav-sentence); }
  /* 与字幕列表同一处理：下划线在 g / y / p / q 处不再断开，保证一条线到底 */
  .tok.fav-word, .tok.fav-phrase, .tok.fav-sentence,
  .lmark { text-decoration-skip-ink: none; }
  .tok.sel { background: var(--accent); color: #fff; text-decoration: none; }
  .fav-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
  /* 收藏按钮是答案面板内的轻量操作，比全局按钮（12px）再小一号 */
  .fav-bar button { padding: 2px 8px; font-size: 11px; flex: 0 0 auto; }
  .fav-bar .sel-text { color: var(--accent); font-size: 12px; }
  /* 收藏视图里的义项小标签（一个词的多个释义拆开展示） */
  .chip {
    display: inline-block; padding: 1px 7px; margin: 1px 4px 1px 0;
    border: 1px solid var(--border); border-radius: 8px; font-size: 11px;
  }
  .phonetic { color: var(--muted); font-size: 11px; margin-left: 6px; }
  /* 短语里的可点词（点击查该词的音标/释义） */
  .ptok { cursor: pointer; border-bottom: 1px dashed var(--border); }
  .ptok:hover { color: var(--accent); border-bottom-color: var(--accent); }
  /* 收藏卡片「来源」行：可跳回原句的入口（仅在有对应素材时可点） */
  .jump-link { text-decoration: underline; cursor: pointer; }
  .jump-link:hover { color: var(--accent); }
  /* 例句 🔊 小按钮：行内轻量操作，与收藏小按钮同字号 */
  .ex-play { padding: 0 4px; font-size: 11px; line-height: 1.4; }

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
    /* col-resize：这条窄条同时是拖拽手柄（拖动调列表宽度） */
    cursor: col-resize; color: var(--muted);
    border-right: 1px solid var(--border);
    user-select: none; font-size: 12px;
  }
  .list-toggle:hover { color: var(--fg); background: rgba(128,128,128,.12); }

  /* ---- 上下布局（窄窗口 / 侧边栏下左右布局太挤的替代方案）----
   * DOM 顺序是 toggle → list → practice；竖排时用 order 重排成
   *   操作区(1) → 开关条(2) → 字幕列表(3)
   * 也就是：操作栏 → 紧贴它下方的开关条 → 字幕列表。
   *
   * 高度分配是这里最容易踩的坑（2026-09-19 用户要求 + 2026-09-20 修订）：
   *   - 操作区 flex: 0 1 auto + min-height: 0 —— 高度按内容走，**空间够时
   *     永不伸展、不裁行**；但容器很矮时允许收缩并内部滚动（滚动条隐藏），
   *     否则内容直接被 overflow:hidden 裁掉且滚不到 —— 比「压缩」更糟。
   *   - 列表 flex: 1 1 auto + min-height: 0 —— 吃掉剩余空间并【内部滚动】；
   *     再配合 .main.stacked 的 overflow:hidden，字幕再长也不会撑破容器
   *     （整页不出现滚动条，列表自己有右侧滚动条）。
   *   - 收起时列表不占位，操作区同样按内容走、必要时收缩滚动。
   */
  .main.stacked { flex-direction: column; overflow: hidden; }
  .main.stacked .practice {
    order: 1; flex: 0 1 auto; min-height: 0;
    border-bottom: 1px solid var(--border);
  }
  .main.stacked .list-toggle {
    order: 2; width: auto; height: 14px; border-right: none;
    cursor: row-resize;
  }
  .main.stacked .list {
    order: 3; flex: 1 1 auto; min-height: 0;
    /* 去掉列表自身的上下 padding：它是给左右布局留的，竖排下会让
       列表在空间不足时最小高度卡在 8px，挤出几 px 无意义的溢出 */
    padding: 0;
    border-right: none;
  }
  .main.stacked.collapsed .list { display: none; }
  .main.stacked.collapsed .practice { flex: 0 1 auto; min-height: 0; }

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

  /* ---- 「复习」视图（收藏单词的间隔重复）----
   * 容器复用 .library 的规则（显隐由 .visible 驱动），这里只加卡片样式。
   * 正面只给单词，释义/例句留给翻面 —— 正面信息越少，自评越接近真实记忆。 */
  .rv-top {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 11px; color: var(--muted); flex: 0 0 auto;
  }
  .rv-card {
    flex: 0 0 auto; padding: 22px 12px; text-align: center;
    border: 1px solid var(--border); border-radius: 6px;
  }
  .rv-word { font-size: 26px; font-weight: 600; line-height: 1.3; word-break: break-word; }
  .rv-ph { margin-top: 6px; font-size: 12px; color: var(--muted); }
  .rv-trans { font-size: 13px; line-height: 1.6; margin-bottom: 6px; }
  .rv-sent { font-size: 12px; line-height: 1.6; margin-top: 4px; }
  .rv-actions { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 6px; }
  .rv-actions button { flex: 1 1 auto; min-width: 70px; padding: 8px 6px; font-size: 12px; }
  .rv-actions button.rv-bad { color: var(--err); border-color: var(--err); }
  .rv-actions button.rv-mid { color: var(--warn); border-color: var(--warn); }
  /* 快捷键说明：紧贴按钮行下方的小字。颜色/字号比 .hint 再收一档，
   * 目的是「想看能查到、不想看不碍眼」—— 卡片区版面本来就紧。 */
  .rv-keys {
    flex: 0 0 auto; text-align: center;
    font-size: 11px; line-height: 1.5; color: var(--muted); opacity: .85;
  }
  .rv-keys b { font-weight: 600; font-family: var(--vscode-editor-font-family, Consolas, monospace); }

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

  /* ---- 收藏视图：搜索 + 复习状态筛选 + 分页 ----
   * 头部整块 sticky 吸顶：一页 20 条卡片很长，翻到一半想改关键词或换筛选
   * 还得滚回顶部太难受。背景必须给，否则下面的卡片会从字缝里透出来。 */
  .fav-head {
    position: sticky; top: 0; z-index: 2;
    display: flex; flex-direction: column; gap: 4px;
    padding: 2px 0 6px; margin-bottom: 2px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  .fav-search { display: flex; gap: 4px; align-items: center; }
  .fav-search input {
    flex: 1 1 auto; min-width: 0;
    padding: 3px 6px; font-size: 11px; font-family: inherit;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 3px; outline: none;
  }
  .fav-search input:focus { border-color: var(--accent); }
  .fav-search button { flex: 0 0 auto; padding: 2px 6px; font-size: 11px; }
  .fav-filters { display: flex; flex-wrap: wrap; gap: 4px; }
  .fav-filters button { padding: 2px 7px; font-size: 11px; }
  .fav-filters button.on { color: var(--accent); border-color: var(--accent); }
  .fav-pager {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 6px 0 2px; font-size: 11px; color: var(--muted);
  }
  .fav-pager button { padding: 2px 8px; font-size: 11px; }

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
  <button id="favBtn" class="ghost">收藏</button>
  <button id="reviewBtn" class="ghost">复习</button>
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

<div id="favView" class="library"></div>

<div id="reviewView" class="library"></div>

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
  //   ensurePlayerSource 的加载路线复用同一个 player 元素，
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

/* 播放按钮文案由事件驱动同步：play/pause 事件在 seek 后自动播、看门狗
   句尾暂停、用户点暂停/恢复时都会触发，不用各处手动改按钮文字 */
function updatePlayBtn() {
  const btn = document.getElementById('play');
  if (btn) btn.textContent = player.paused ? '▶ 播放' : '⏸ 暂停';
}
player.addEventListener('play', updatePlayBtn);
player.addEventListener('pause', updatePlayBtn);

// 三态播放按钮（点击循环切换：off → loop → auto → off）
const PLAY_MODE_ORDER = ['off', 'loop', 'auto'];
const PLAY_MODE_LABEL = { off: '循环关', loop: '循环开', auto: '连播' };

/** render() 最近一次渲染的句号 —— 用于判断「同句重渲染」（恢复滚动位置） */
let renderedIndex = -1;

let state = {
  material: null,
  currentIndex: 0,
  results: {},
  rate: 1,
  // 播放模式：off = 播完当前句停；loop = 当前句循环重播；auto = 连播（自动下一句，纯听）
  playMode: 'off',
  listCollapsed: false,
  // 「看答案」面板是否展开（会话内记忆）：切句/倍速/切播放模式都不重置，
  // 只有点「看答案」按钮本身才切换 —— 显隐由状态驱动，不挂在会被 render()
  // 重建重置的 DOM style 上
  revealAnswer: false,
  // 字幕列表占比（用户拖过分隔条后的自定义值；null = 用 CSS 默认 45%）。
  // listRatio = 左右布局的宽度占比；stackedRatio = 上下布局的高度占比
  listRatio: null,
  stackedRatio: null,
  // 布局：false = 左字幕 / 右操作（默认）；true = 上操作 / 下字幕
  stacked: false,
  // 时间轴微调面板是否展开（只在会话内记忆，不持久化）
  timingOpen: false,
  // 当前素材已手工修正的句数 —— 宿主在 material / timingPatched 里告知，
  // 决定「复原全部」要不要出现
  timingCount: 0,
  // 是否显示音频加载诊断按钮（🔧）。
  // 默认关：音频链路已打通，这是留给开发者的排查工具，
  // 由 listenAndWrite.showAudioDiagnostics 控制（宿主在 ready / 配置变更时推）
  showAudioDiag: false,
  /* ---- 收藏（单词/短语/整句） ---- */
  // 百度翻译 API 是否已配置（宿主在 config / favList 里推）
  baiduConfigured: false,
  // 收藏列表（宿主 favList 推送，最新在前）
  favorites: [],
  // 收藏批次「更新翻译」进行中（按钮防连点）
  favUpdating: false,
  // 短语点词展开状态：favId → { word, found, phonetic, translation }
  favExpand: {},
  // ★ 短语点词重渲染时的滚动锚点：{ favId, cardTop }。renderFavView 整段重建 innerHTML
  //   会把收藏视图的 scrollTop 冲掉（内容先清空 → scrollTop 被 clamp 归零），表现为
  //   「点某个单词，那张卡片就跳位」。这里记住被点卡片【重建前】相对视口的位置，
  //   重建后重新对齐，使该卡片距顶部不变，变化的只有它下面的内容。
  favScrollAnchor: null,
  // 收藏视图的搜索、筛选与分页（页面侧状态，不落盘；重载后回到「全部」第 1 页）
  favQuery: '',
  favFilter: 'all',
  favPage: 0,
  // 答案面板里当前选中的词 token 序号（连续短语）；favSelFor = 选区归属的句号，
  // 切句后句号对不上自动失效，不用在每个切句入口清理
  favSelFor: -1,
  favSel: [],
  /* ---- 复习（收藏单词的间隔重复） ----
   * 这些全是【页面侧缓存】，权威数据在宿主（ReviewStore）。
   * 页面只负责把宿主推来的卡片画出来 + 把评分发回去。 */
  // 当前卡片（null = 不在答题中）
  rvCard: null,
  rvRound: 0,
  rvIndex: 0,
  rvTotal: 0,
  // 是否已翻面（展示释义/例句）
  rvReveal: false,
  // 「已评分待确认」：没看答案就点了不认识/模糊 → 停在原地看答案，只留一个「下一个」
  rvHeld: false,
  // 复习首页数据（reviewHome）
  rvHome: null,
  // 轮次过场页数据（reviewRoundEnd）
  rvRoundEnd: null,
  // 本场结束页数据（reviewEnd）
  rvEnd: null,
};

// 布局偏好持久化：webview 的 state 在窗口重载、切走再回来时都会保留。
// getState/setState 是 acquireVsCodeApi() 的标准能力，但桩环境里可能没有，
// 所以都要判类型 + try（历史上页面脚本一旦抛错就是整页按钮全部失效）。
try {
  if (typeof vscode.getState === 'function') {
    const saved = vscode.getState();
    if (saved && typeof saved.stacked === 'boolean') state.stacked = saved.stacked;
    if (saved && typeof saved.listRatio === 'number') state.listRatio = saved.listRatio;
    if (saved && typeof saved.stackedRatio === 'number') state.stackedRatio = saved.stackedRatio;
  }
} catch (e) { /* 取不到就用默认布局 */ }

function saveLayout() {
  try {
    if (typeof vscode.setState === 'function') {
      vscode.setState({
        stacked: state.stacked,
        listRatio: state.listRatio,
        stackedRatio: state.stackedRatio,
      });
    }
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
    // 收藏视图「跳回原句」：宿主带句号就定位过去，否则从头开始
    const jt = Number(msg.jumpTo);
    state.currentIndex =
      Number.isFinite(jt) && jt >= 0 && jt < (msg.material.sentences?.length ?? 0)
        ? Math.floor(jt)
        : 0;
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
    state.baiduConfigured = !!msg.baiduConfigured;
    if (currentView === 'favorites') renderFavView();
    render();
  }
  /* ---- 收藏 ---- */
  // 收藏列表（进入收藏视图 / 增删 / 翻译批次进度时推送）。
  // 练习界面也要刷新：整句收藏按钮的二态（收藏整句 ⇄ 已收藏）依赖这份列表
  if (msg.type === 'favList') {
    state.favorites = Array.isArray(msg.favorites) ? msg.favorites : [];
    state.baiduConfigured = !!msg.baiduConfigured;
    state.favUpdating = !!msg.updating;
    if (currentView === 'favorites') renderFavView();
    else if (currentView === 'practice') render();
  }
  // 收藏成功回执：清选区 + 轻提示 + 刷新按钮二态
  // ⚠️ 回执里带宿主保存后的权威条目，直接 upsert 进本地列表：
  //    不等下一次 favList 就能上色；favList 万一丢失/滞后，也不会出现
  //    「明明收藏成功、界面上却永远没有标记」。
  if (msg.type === 'favAdded') {
    state.favSel = [];
    const added = msg.fav;
    if (added && added.id && added.type && added.text) {
      const addedKey = added.type + ':' + String(added.text).toLowerCase();
      const at = state.favorites.findIndex(
        (f) => f.id === added.id || f.type + ':' + String(f.text).toLowerCase() === addedKey
      );
      state.favorites = at >= 0
        ? state.favorites.slice(0, at).concat([added], state.favorites.slice(at + 1))
        : state.favorites.concat([added]);
    }
    showNotice(msg.deduped ? '已在收藏中，来源句已更新' : '已收藏');
    if (currentView === 'favorites') renderFavView();
    else if (currentView === 'practice') render();
  }
  // 短语点词的词典查询回包（宿主本地查，即时返回）
  if (msg.type === 'favWordInfo') {
    state.favExpand[msg.favId] = {
      word: msg.word,
      found: !!msg.found,
      phonetic: msg.phonetic || '',
      translation: msg.translation || '',
    };
    if (currentView === 'favorites') renderFavView();
  }
  // 例句播放：宿主解析出音频地址与句段起止，复用主 player 播放，到句尾自动停。
  // ⚠️ 必须走 ensurePlayerSource（宿主字节路线，MIME 随请求声明）：
  //    直链会踩 MEDIA_ERR_SRC_NOT_SUPPORTED（asWebviewUri 不保证 Content-Type）
  if (msg.type === 'favExampleAudio') {
    stopExamplePlayback();
    if (player._stopTimer) { clearInterval(player._stopTimer); player._stopTimer = null; }
    const startSec = msg.startMs / 1000;
    const endSec = msg.endMs / 1000;
    ensurePlayerSource(msg.url, msg.mime).then((src) => {
      if (!src) { showNotice('例句加载失败（宿主字节路线不可用）'); return; }
      const seekAndPlay = () => {
        let target = startSec;
        try {
          const sk = player.seekable;
          if (sk && sk.length > 0) {
            if (target < sk.start(0)) target = sk.start(0);
            if (target > sk.end(0)) target = sk.end(0);
          }
          player.currentTime = target;
        } catch (err) { /* 未就绪则忽略 */ }
        pageLog('[LT-PAGE] 例句 seek 到 ' + player.currentTime + 's，开始播放');
        player.play().catch((e) => showNotice('例句播放失败：' + String(e?.message ?? e)));
      };
      if (player.readyState >= 1) seekAndPlay();
      else player.addEventListener('loadedmetadata', seekAndPlay, { once: true });
      exampleTimer = setInterval(() => {
        if (player.paused || player.ended || player.currentTime >= endSec) {
          stopExamplePlayback();
          if (!player.paused) player.pause();
        }
      }, 100);
    });
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
  /* ---- 复习 ---- */
  // 首页（进入复习视图 / 未开始时 / 本场结束后返回）
  if (msg.type === 'reviewHome') {
    state.rvHome = msg;
    state.rvCard = null;
    state.rvRoundEnd = null;
    state.rvEnd = null;
    state.rvHeld = false;
    if (currentView === 'review') renderReviewView();
  }
  // 一张卡片（含轮次与进度）
  if (msg.type === 'reviewCard') {
    const prevKey = state.rvCard ? state.rvCard.key : null;
    state.rvCard = msg.card;
    state.rvRound = Number(msg.round) || 0;
    state.rvIndex = Number(msg.index) || 0;
    state.rvTotal = Number(msg.total) || 0;
    // held = 宿主说这张卡「已经评过分、等你确认」→ 强制翻面并收掉自评按钮
    state.rvHeld = !!msg.held;
    // ★ 换卡必须重置翻面状态：否则上一张的释义会跟着新卡片显示出来（直接漏答案）。
    //   同一张卡的刷新（如补译完成）保留翻面状态，不然刚查到的释义会被立刻收起。
    if (state.rvHeld) state.rvReveal = true;
    else if (msg.card.key !== prevKey) state.rvReveal = false;
    state.rvRoundEnd = null;
    state.rvEnd = null;
    if (currentView === 'review') renderReviewView();
  }
  // 轮次过场页（本轮有需要重看的卡）
  if (msg.type === 'reviewRoundEnd') {
    state.rvRoundEnd = msg;
    state.rvHeld = false;
    if (currentView === 'review') renderReviewView();
  }
  // 本场结束
  if (msg.type === 'reviewEnd') {
    state.rvEnd = msg;
    state.rvCard = null;
    state.rvRoundEnd = null;
    state.rvHeld = false;
    if (currentView === 'review') renderReviewView();
  }
  // 注意：视图切换已在上面按 progress/done/error 的来源分别处理，
  // 不要再在这里统一 showPracticeView() —— 那会把列表里的下载进度打断。
});

/* ---------------- 收藏视图 ---------------- */

/* ---- 例句播放：复用主 player（项目规则禁止新建独立 Audio 对象，避免媒体并发饿死）----
 * favExampleAudio 回包 → 换 src + seek + play → 100ms 轮询到句尾自动停。
 * 不需要"还原"主播放器状态：回练习界面点播放时 playCurrent 会重新 seek。 */
let exampleTimer = null;

function stopExamplePlayback() {
  if (exampleTimer) {
    clearInterval(exampleTimer);
    exampleTimer = null;
  }
}

/**
 * 把英文句子/短语渲染成「可点单词 token + 原样分隔符」。
 * 只把纯英文单词做成 token（撇号/连字符连写算一个词），标点原样输出——
 * 这样 data-word 干净，词典查询不会带着句号/逗号落空。
 */
function renderPtoks(text, favId) {
  const re = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
  let out = '', last = 0, m;
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    out += '<span class="ptok" data-fav-id="' + esc(favId) + '" data-word="' +
      esc(m[0]) + '">' + esc(m[0]) + '</span>';
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

/** 收藏列表每页条数 */
const FAV_PAGE_SIZE = 20;

/** 收藏视图顶部的复习状态筛选项（顺序即展示顺序） */
const FAV_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'due', label: '待复习' },
  { key: 'mastered', label: '已掌握' },
  { key: 'fresh', label: '未复习' },
];

/**
 * 一条收藏的复习状态。
 *   none     没有复习记录（短语/整句恒为 none —— 它们不参与复习）
 *   due      已到期，现在就能复习
 *   mastered 已掌握，退出复习池
 *   later    已排期但还没到时间
 *
 * ⚠️ 判「到期」直接用 dueAt <= now，不要复用 rvDueText 的自然日口径：
 *    那个是给人看日期的，这里是判断「现在能不能复习」，两回事。
 */
function favStatusOf(f) {
  if (!f.review) return 'none';
  if (f.review.mastered) return 'mastered';
  return Number(f.review.dueAt) <= Date.now() ? 'due' : 'later';
}

/**
 * 按复习状态分桶。返回的每个桶都保持原始顺序（宿主已按 createdAt 倒序推来）。
 * 「未复习」只收单词 —— 短语/整句永远不会进复习池，混进去只会误导。
 *
 * 关键词（q）在这里一并过滤：这样筛选条上的数量是「搜索范围内各分类有多少条」，
 * 而不是全量分类数量，用户能看出匹配结果落在哪一类里。
 */
function favBuckets(favs, q) {
  const kw = String(q || '').trim().toLowerCase();
  const hit = (f) => {
    if (!kw) return true;
    const ctx = f.context || {};
    return (
      String(f.text || '').toLowerCase().indexOf(kw) >= 0 ||
      String(f.translation || '').toLowerCase().indexOf(kw) >= 0 ||
      String(ctx.sentenceText || '').toLowerCase().indexOf(kw) >= 0 ||
      String(ctx.talkTitle || '').toLowerCase().indexOf(kw) >= 0
    );
  };
  const out = { all: [], due: [], mastered: [], fresh: [] };
  for (const f of favs) {
    if (!hit(f)) continue;
    out.all.push(f);
    const s = favStatusOf(f);
    if (s === 'due') out.due.push(f);
    else if (s === 'mastered') out.mastered.push(f);
    else if (s === 'none' && f.type === 'word') out.fresh.push(f);
  }
  return out;
}

/**
 * 收藏列表：词条 + 译文 + 来源句。
 * - 未配置百度翻译 → 顶部提示条，pending 条目标 ⏳；
 * - 已配置且有 pending → 显示「更新翻译」按钮（手动触发，QPS=1 串行）；
 * - 顶部按复习状态筛选，底部按 FAV_PAGE_SIZE 分页；
 * - 点卡片跳回原句（宿主 openCached 带 sentenceIndex）；✕ 删除。
 */
function renderFavView() {
  if (!favView) return;
  // 取出待还原的滚动锚点（消费一次即清空，避免影响其它来源触发的重渲染）
  const anchor = state.favScrollAnchor;
  state.favScrollAnchor = null;
  const favs = state.favorites;
  const pendingCount = favs.filter((f) => f.pending).length;

  /*
   * 搜索框会随整段 innerHTML 重建，所以先记住焦点与光标位置，重建完还回去。
   * 不这么做的话每敲一个字就丢焦点 —— 搜索框等于只能输入一个字符。
   */
  const qEl = document.getElementById('favQuery');
  const qFocus = !!qEl && document.activeElement === qEl;
  const qSel = qEl ? qEl.selectionStart : 0;
  const restoreQueryFocus = () => {
    if (!qFocus) return;
    const nq = document.getElementById('favQuery');
    if (!nq) return;
    nq.focus();
    try { nq.setSelectionRange(qSel, qSel); } catch (e) { /* 某些输入类型不支持选区 */ }
  };

  let html = '';
  if (!state.baiduConfigured) {
    html +=
      '<div class="answer" style="margin-bottom:8px">' +
        '<div class="lbl">单词/短语的译文需要百度翻译 API</div>' +
        '在设置里搜索「listenAndWrite」，填写 <b>baiduAppId</b> 与 <b>baiduSecret</b>' +
        '（fanyi-api.baidu.com 免费申请）。整句收藏不受影响，译文来自 TED 字幕。' +
      '</div>';
  } else if (pendingCount > 0) {
    html +=
      '<div class="disc-bar" style="margin-bottom:8px">' +
        '<button id="favRetry" class="ghost"' + (state.favUpdating ? ' disabled' : '') + '>' +
          (state.favUpdating ? '翻译中…' : '更新翻译（' + pendingCount + ' 条待译）') +
        '</button>' +
        '<span class="hint">按百度 QPS=1 串行执行，请稍候</span>' +
      '</div>';
  }

  if (!favs.length) {
    html += '<div class="center">还没有收藏。<br>' +
      '在练习界面点「看答案」：点单词收藏单词，连续点相邻词收藏短语，也可以收藏整句。</div>';
    favView.innerHTML = html;
    return;
  }

  /* ---- 搜索 + 筛选 + 分页 ---- */
  const buckets = favBuckets(favs, state.favQuery);
  const list = buckets[state.favFilter] || buckets.all;
  const pages = Math.max(1, Math.ceil(list.length / FAV_PAGE_SIZE));
  // 删条目 / 切筛选后页码可能越界，夹回来 —— 否则会渲染出空白的「第 3/2 页」
  if (state.favPage > pages - 1) state.favPage = pages - 1;
  if (state.favPage < 0) state.favPage = 0;
  const start = state.favPage * FAV_PAGE_SIZE;
  const page = list.slice(start, start + FAV_PAGE_SIZE);
  // 跳回原句按【全量列表】的下标定位，不能用页内下标，否则会跳到别的收藏上
  const idxById = new Map();
  favs.forEach((f, i) => idxById.set(f.id, i));

  html += '<div class="fav-head">' +
    '<div class="fav-search">' +
      '<input id="favQuery" type="text" placeholder="搜索单词 / 释义 / 例句 / 来源…" value="' +
        esc(state.favQuery) + '" />' +
      (state.favQuery
        ? '<button id="favQueryClear" class="ghost" title="清空搜索">✕</button>'
        : '') +
    '</div>' +
    '<div class="fav-filters">';
  for (const it of FAV_FILTERS) {
    const n = buckets[it.key].length;
    html += '<button class="ghost fav-filter' + (state.favFilter === it.key ? ' on' : '') +
      '" data-f="' + it.key + '">' + it.label + ' ' + n + '</button>';
  }
  html += '</div></div>';

  if (!list.length) {
    html += '<div class="center">' + (state.favQuery
      ? '没有匹配「' + esc(state.favQuery) + '」的条目。<br>换个关键词，或清空搜索框。'
      : '这个分类下没有条目。<br>点上方「全部」查看所有收藏。') + '</div>';
    favView.innerHTML = html;
    bindFavChrome();
    restoreQueryFocus();
    return;
  }

  html += page.map((f) => {
    const k = idxById.get(f.id);
    const ctx = f.context || {};
    // 释义行：整句不在这里显示（translation 就是原句译文，与下方「译：」重复）；
    // 单词/短语按 ； 与换行拆成 chip 展示（词典/百度的多义项都适用）
    const trans = f.pending
      ? '<span class="hint">⏳ 待翻译' +
        (state.baiduConfigured ? '（点上方「更新翻译」补全）' : '（未配置百度翻译 API）') +
        '</span>'
      : f.type === 'sentence'
        ? ''
        : esc(f.translation)
            .split(/[；;\\n]/)
            .map((x) => x.trim())
            .filter((x) => x)
            .map((x) => '<span class="chip">' + x + '</span>')
            .join('');
    // 跳回原句的 dirName 由宿主在 favList 里动态解析（含旧数据标题兜底）
    const canJump = !!f.dirName && typeof ctx.sentenceIndex === 'number';
    const typeLabel = f.type === 'word' ? '单词' : (f.type === 'phrase' ? '短语' : '整句');
    const sourceText = '来源：' + esc(ctx.talkTitle || '(未知课程)') +
      ' · 句 ' + (Number(ctx.sentenceIndex) + 1);
    // 例句播放入口（🔊）：有对应本地素材才显示
    const exPlayBtn = canJump
      ? '<button class="ex-play" data-fav-id="' + esc(f.id) + '" title="播放例句">🔊</button> '
      : '';

    // 复习状态标记：只有单词会有进度（短语/整句不参与复习）。
    // 用户必须能一眼看出「收藏的词复习到什么程度了」，否则复习是个黑箱。
    let rvTag = '';
    if (f.review) {
      rvTag = f.review.mastered
        ? '<span class="badge ok">✓ 已掌握</span>'
        : '<span class="badge">' + rvDueText(f.review.dueAt) + '</span>';
    }
    const rvRestart = f.review && f.review.mastered
      ? '<button class="ghost fav-rv-restart" data-key="' + esc(String(f.text).toLowerCase()) +
        '" style="padding:0 5px;font-size:10px" title="回到复习池，从第 1 档重新开始">重新加入复习</button>'
      : '';

    // 标题区：单词带音标（离线词典）；短语/整句渲染成可点 token（点词展开音标/释义）
    let title = esc(f.text);
    if (f.type === 'word' && !f.pending && f.phonetic) {
      const ph = String(f.phonetic);
      title += '<span class="phonetic">' +
        (ph.indexOf('/') >= 0 ? esc(ph) : '/' + esc(ph) + '/') + '</span>';
    } else if ((f.type === 'phrase' || f.type === 'sentence') && !f.pending) {
      title = renderPtoks(f.text, f.id);
    }

    // 短语点词的展开行（favWordInfo 回填）
    const expand = state.favExpand[f.id];
    const expandHtml = expand
      ? '<div class="meta">' +
        (expand.found
          ? '<span class="phonetic">' + esc(expand.word) +
            (expand.phonetic ? '  /' + esc(expand.phonetic) + '/' : '') + '</span> ' +
            esc(expand.translation)
              .split(/[；;\\n]/)
              .map((x) => x.trim())
              .filter((x) => x)
              .map((x) => '<span class="chip">' + x + '</span>')
              .join('')
          : '<span class="hint">「' + esc(expand.word) + '」本地词典未收录</span>') +
        '</div>'
      : '';

    return '<div class="lib-card" data-k="' + k + '" data-fav-id="' + esc(f.id) + '">' +
      '<div class="t">' + title +
        '<span class="badge">' + typeLabel + '</span>' + rvTag +
        '<button class="ghost fav-del" data-id="' + esc(f.id) + '" ' +
          'style="float:right;padding:0 6px" title="删除">✕</button>' +
      '</div>' +
      (trans ? '<div class="meta">' + trans + '</div>' : '') + expandHtml +
      // 整句：标题本身就是原句，不再重复引述，只显示「译：」（与单词/短语一致）
      '<div class="meta">' + (canJump ? exPlayBtn : '') +
        (f.type === 'sentence'
          ? (ctx.sentenceTranslation ? '译：' + esc(ctx.sentenceTranslation) : '')
          : (ctx.sentenceText ? '例句：' + esc(ctx.sentenceText) : '') +
            (ctx.sentenceTranslation ? '<br>译：' + esc(ctx.sentenceTranslation) : '')) +
      '</div>' +
      // 跳转入口 = 来源行本身（下划线可点）；整卡不响应点击
      '<div class="meta hint">' +
        (canJump
          ? '<span class="jump-link" data-jump-k="' + k + '">' + sourceText + '</span>'
          : sourceText) +
        (rvRestart ? ' ' + rvRestart : '') +
      '</div>' +
    '</div>';
  }).join('');

  // 分页条：只有一页时也显示总数，让用户知道这个分类里到底有多少条
  html += '<div class="fav-pager">' +
    '<button id="favPrev" class="ghost"' + (state.favPage === 0 ? ' disabled' : '') +
      '>上一页</button>' +
    '<span>' + (state.favPage + 1) + ' / ' + pages + ' · 共 ' + list.length + ' 条</span>' +
    '<button id="favNext" class="ghost"' + (state.favPage >= pages - 1 ? ' disabled' : '') +
      '>下一页</button>' +
    '</div>';

  favView.innerHTML = html;
  bindFavChrome();
  restoreQueryFocus();

  const retry = document.getElementById('favRetry');
  if (retry) retry.onclick = () => vscode.postMessage({ type: 'favRetry' });
  // 短语/整句点词：查离线词典（宿主本地查，零成本），回包后在该卡片就地展开；
  // 再点同一个 token → 收起（不发请求）
  favView.querySelectorAll('.ptok').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const favId = el.dataset.favId;
      const word = el.dataset.word;
      // ★ 记录这张卡片重建前相对视口的位置：稍后回包触发 renderFavView 整段重建时，
      //   用它把卡片顶回原位，避免滚动跳位（展开/收起都要记，收起同样会重建）。
      const card = el.closest('.lib-card');
      state.favScrollAnchor = card
        ? { favId: favId, cardTop: card.getBoundingClientRect().top }
        : null;
      const cur = state.favExpand[favId];
      if (cur && cur.word === word) {
        delete state.favExpand[favId];
        renderFavView();
        return;
      }
      vscode.postMessage({ type: 'favWordLookup', favId: favId, word: word });
    };
  });
  // 例句 🔊：请宿主解析该句对应音频段，回包后页面用独立 Audio 播放
  favView.querySelectorAll('.ex-play').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      pageLog('[LT-PAGE] 🔊 点击例句播放，favId =', el.dataset.favId);
      vscode.postMessage({ type: 'favPlayExample', favId: el.dataset.favId });
    };
  });
  favView.querySelectorAll('.fav-del').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'favRemove', id: btn.dataset.id });
    };
  });
  // 「已掌握」的词 → 回到复习池（宿主清 mastered + level 归 0，回包刷新列表）
  favView.querySelectorAll('.fav-rv-restart').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'reviewRestart', key: btn.dataset.key });
    };
  });
  // 来源行 = 跳转入口：跳过去后自动进入「看答案」状态并展开字幕列表
  favView.querySelectorAll('.jump-link').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const f = state.favorites[Number(el.dataset.jumpK)];
      if (!f || !f.dirName) return;
      state.listCollapsed = false;
      state.revealAnswer = true;
      state.favSel = [];
      state.favSelFor = -1;
      vscode.postMessage({
        type: 'openCached',
        dirName: f.dirName,
        sentenceIndex: f.context?.sentenceIndex ?? 0,
      });
      showPracticeView();
    };
  });

  // ★ 还原滚动锚点：innerHTML 重建后，把被点的那张卡片重新对齐到重建前的视口位置，
  //   于是「卡片距顶部不变，只有下方内容随展开/收起变化」，滚动不再跳位。
  if (anchor) {
    const anchorCard = Array.from(favView.querySelectorAll('.lib-card'))
      .find((c) => c.dataset.favId === anchor.favId);
    if (anchorCard) {
      favView.scrollTop += anchorCard.getBoundingClientRect().top - anchor.cardTop;
    }
  }
}

/** 更新搜索关键词：重置到第 1 页后整段重渲染（光标位置由 renderFavView 还回去） */
function applyFavQuery(v) {
  const next = String(v || '');
  if (next === state.favQuery) return;
  state.favQuery = next;
  state.favPage = 0;
  renderFavView();
}

/**
 * 绑定收藏视图的搜索框、筛选条与分页按钮。
 *
 * ⚠️ 单独抽出来而不是塞在 renderFavView 的卡片绑定里：筛选结果为空时
 *    会提前 return，那时【仍然要能改关键词、点筛选条切回「全部」】，
 *    否则用户就卡死在空页上了。
 */
function bindFavChrome() {
  if (!favView) return;
  const q = document.getElementById('favQuery');
  if (q) {
    // ⚠️ 中文/拼音输入法合成期间绝不能重渲染，否则会把正在合成的串打断
    let composing = false;
    q.addEventListener('compositionstart', () => { composing = true; });
    q.addEventListener('compositionend', () => {
      composing = false;
      applyFavQuery(q.value);
      favView.scrollTop = 0;
    });
    q.addEventListener('input', (e) => {
      if (composing) return;
      applyFavQuery(e.target.value);
      favView.scrollTop = 0;
    });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        q.value = '';
        applyFavQuery('');
      }
    });
  }
  const qc = document.getElementById('favQueryClear');
  if (qc) {
    qc.onclick = () => {
      state.favQuery = '';
      state.favPage = 0;
      renderFavView();
      favView.scrollTop = 0;
    };
  }
  favView.querySelectorAll('.fav-filter').forEach((btn) => {
    btn.onclick = () => {
      if (state.favFilter === btn.dataset.f) return;
      state.favFilter = btn.dataset.f;
      state.favPage = 0;
      renderFavView();
      favView.scrollTop = 0;
    };
  });
  const prev = document.getElementById('favPrev');
  if (prev) {
    prev.onclick = () => {
      if (state.favPage <= 0) return;
      state.favPage -= 1;
      renderFavView();
      favView.scrollTop = 0;
    };
  }
  const next = document.getElementById('favNext');
  if (next) {
    next.onclick = () => {
      state.favPage += 1;
      renderFavView();
      favView.scrollTop = 0;
    };
  }
}

/* ---------------- 复习视图 ---------------- */

const reviewView = document.getElementById('reviewView');

/**
 * 下次复习的日期文案，按【自然日】算，不按毫秒差。
 *
 * ⚠️ 别改回「剩余毫秒 ÷ 一天」的写法：阶梯最小档就是 1 天，按毫秒算的话
 *    刚评完下一秒 d 就小于 86400000，立刻掉进「24 小时后」分支 —— 于是
 *    1 档的词整个周期都显示成小时数，看着完全不像「以天为单位」
 *    （2026-10-28 实测反馈）。按自然日算才不会出现这种退化。
 */
function rvDueText(dueAt) {
  const t = Number(dueAt) || 0;
  if (!t) return '待复习';
  const now = Date.now();
  if (t <= now) return '待复习';
  const startOfDay = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  // 用四舍五入而不是取整：夏令时会让某一天变成 23 或 25 小时
  const days = Math.round((startOfDay(t) - startOfDay(now)) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '明天';
  return days + ' 天后';
}

/**
 * 自评按钮组。withReveal = 是否显示「看答案」。
 * ⚠️ 「认识」用实心按钮（主操作），模糊/不认识用描边 —— 避免用户顺手点第一个。
 *
 * 快捷键说明（.rv-keys）紧跟按钮行下方，小字；
 * ⚠️ 空格只在【这张卡真的有例句音频】时才写进说明（canPlay）——
 *    没音频还提示「空格播放」，用户按了没反应会以为快捷键坏了。
 */
function rvActions(withReveal, canPlay) {
  let h = '';
  if (withReveal) {
    h += '<div class="rv-actions"><button id="rvReveal" class="ghost">看答案</button></div>';
  }
  h += '<div class="rv-actions">' +
    '<button class="rv-grade ghost rv-bad" data-g="unknown">不认识</button>' +
    '<button class="rv-grade ghost rv-mid" data-g="fuzzy">模糊</button>' +
    '<button class="rv-grade" data-g="know">认识</button>' +
    '</div>';
  h += '<div class="rv-keys">' +
    (canPlay ? '<b>空格</b> 播放例句　' : '') +
    '<b>a</b> 不认识　<b>s</b> 模糊　<b>d</b> 认识' +
    '</div>';
  return h;
}

/**
 * 卡片上的三个动作。★ 按钮与快捷键走同一套函数，行为永远一致
 * （与精听界面 a/d/空格 的做法一致，见下文 keydown）。
 */
function rvGrade(grade) {
  const c = state.rvCard;
  if (!c) return;
  // 本地防连点（宿主侧还会用 key 与游标比对再防一道）。
  // ⚠️ 按钮已禁用 = 上一笔评分还没回包：必须直接返回。
  //    鼠标连点会被 disabled 属性挡住，但键盘连按不会 ——
  //    第二笔评分对宿主来说仍是「当前这张卡」，会被当成重复评分收下。
  const btns = reviewView.querySelectorAll('.rv-grade');
  if (btns.length && btns[0].disabled) return;
  btns.forEach((b) => { b.disabled = true; });
  vscode.postMessage({
    type: 'reviewGrade',
    key: c.key,
    grade: grade,
    // 告诉宿主「点评分时看没看答案」：没看又点了不认识/模糊时，宿主会停在原地
    revealed: !!state.rvReveal,
  });
}

/** 停留态的「下一个 / 完成」 */
function rvGoNext() {
  if (!state.rvCard) return;
  const go = document.getElementById('rvGo');
  // 已禁用 = 上一笔还没回包，键盘连按不要再发一次
  if (go && go.disabled) return;
  if (go) go.disabled = true;
  state.rvHeld = false;
  vscode.postMessage({ type: 'reviewNext' });
}

/** 播放这张卡的例句音频（复用收藏视图那条通道，主 player 播片段） */
function rvPlayExample() {
  const c = state.rvCard;
  if (!c || !c.canPlay) return;
  vscode.postMessage({ type: 'favPlayExample', favId: c.favId });
}

/**
 * 复习视图：首页 / 卡片 / 轮次过场 / 结束页，四态互斥。
 * 卡片正面【只有单词】，释义与例句留给翻面 —— 正面信息越少自评越真实。
 */
function renderReviewView() {
  if (!reviewView) return;
  let html = '';

  // ---- 1) 结束页 ----
  if (state.rvEnd) {
    const s = state.rvEnd.stats || {};
    const total = (s.know || 0) + (s.fuzzy || 0) + (s.unknown || 0);
    html = '<div class="center" style="padding:18px 8px;line-height:1.9">' +
      '<div style="font-size:14px">本场复习完成</div>' +
      '<div style="color:var(--muted)">共 ' + total + ' 次评分：认识 ' + (s.know || 0) +
        ' · 模糊 ' + (s.fuzzy || 0) + ' · 不认识 ' + (s.unknown || 0) + '</div>' +
      '<div class="hint">24 小时内待复习 ' + (state.rvEnd.pendingCount || 0) + ' 个</div>' +
      '<div style="margin-top:14px">' +
        '<button id="rvExtra">再来 5 张</button> ' +
        '<button id="rvBack" class="ghost">返回</button>' +
      '</div>' +
      '</div>';
    reviewView.innerHTML = html;
    const ex = document.getElementById('rvExtra');
    if (ex) ex.onclick = () => vscode.postMessage({ type: 'reviewExtra' });
    const bk = document.getElementById('rvBack');
    if (bk) bk.onclick = () => vscode.postMessage({ type: 'reviewHome' });
    return;
  }

  // ---- 2) 轮次过场页 ----
  if (state.rvRoundEnd) {
    const re = state.rvRoundEnd;
    const s = re.stats || {};
    html = '<div class="center" style="padding:18px 8px;line-height:1.9">' +
      '<div style="font-size:14px">第 ' + re.finishedRound + ' 轮完成</div>' +
      '<div style="color:var(--muted)">认识 ' + (s.know || 0) + ' · 模糊 ' + (s.fuzzy || 0) +
        ' · 不认识 ' + (s.unknown || 0) + '</div>' +
      '<div>接下来再看 ' + re.nextCount + ' 张</div>' +
      '<div style="margin-top:14px"><button id="rvNext">继续第 ' +
        (re.finishedRound + 1) + ' 轮</button></div>' +
      '</div>';
    reviewView.innerHTML = html;
    const nb = document.getElementById('rvNext');
    if (nb) {
      nb.onclick = () => vscode.postMessage({ type: 'reviewNextRound' });
      // 默认聚焦：回车即可继续。过场页只在本轮有重排卡时出现，一场最多 2 次
      try { nb.focus(); } catch (e) { /* 桩环境忽略 */ }
    }
    return;
  }

  // ---- 3) 卡片 ----
  if (state.rvCard) {
    const c = state.rvCard;
    html = '<div class="rv-top">' +
      '<span>第 ' + (state.rvRound + 1) + ' 轮 · ' + (state.rvIndex + 1) + ' / ' + state.rvTotal + '</span>' +
      '<span>' + (c.isNew ? '新词' : '第 ' + (c.level + 1) + ' 档') + '</span>' +
      '</div>' +
      '<div class="rv-card"><div class="rv-word">' + esc(c.text) + '</div>' +
        (state.rvReveal && c.phonetic ? '<div class="rv-ph">' + esc(c.phonetic) + '</div>' : '') +
      '</div>';

    if (state.rvReveal) {
      // ⚠️ 🔊 必须紧贴它朗读的那句例句。原先挂在「来源」行上，视觉上像是播演讲标题
      const playBtn = c.canPlay
        ? '<button id="rvPlay" class="ghost" style="padding:0 5px;margin-right:4px" ' +
          'title="播放这句例句的音频">🔊</button>'
        : '';
      html += '<div class="answer">' +
        (c.translation
          ? '<div class="rv-trans">' + esc(c.translation) + '</div>'
          : '<div>' +
            (state.baiduConfigured
              ? '<button id="rvRetry" class="ghost" style="padding:0 6px">重新查询释义</button>'
              : '<span class="hint">本地词典未收录；配置百度翻译后可补译</span>') +
            '</div>') +
        ((c.sentenceText || playBtn)
          ? '<div class="rv-sent">' + playBtn + esc(c.sentenceText || '') + '</div>'
          : '') +
        (c.sentenceTranslation
          ? '<div class="rv-sent" style="color:var(--muted)">' + esc(c.sentenceTranslation) + '</div>'
          : '') +
        (c.talkTitle ? '<div class="hint" style="margin-top:6px">来源：' + esc(c.talkTitle) + '</div>' : '') +
      '</div>';
    }

    /*
     * 停留态（已评分、等用户看完答案）：收掉三个自评按钮，只留一个往下走的按钮。
     * ⚠️ 按钮文案要按「是不是本轮回最后一张」变 —— 最后一张还写「下一个」的话，
     *    用户点下去直接蹦出小结页，会以为自己误触了。
     */
    const isLast = state.rvIndex + 1 >= state.rvTotal;
    if (state.rvHeld) {
      // 只有「最后一张」才给提示文案：它要解释按钮为什么叫「完成」而不是「下一个」。
      // 平常那张卡上答案已经占满版面，再加一句「已记录…」纯属噪音。
      if (isLast) {
        html += '<div class="hint" style="text-align:center">本轮回最后一张</div>';
      }
      html += '<div class="rv-actions"><button id="rvGo">' +
        (isLast ? '完成' : '下一个') + '</button></div>';
      // 停留态只有 d 一个可用的键（空格照旧能重听例句）——
      // 这里不列自评键：那三个按钮此时是收起来的，列出来只会让人去按
      html += '<div class="rv-keys">' +
        (c.canPlay ? '<b>空格</b> 播放例句　' : '') +
        '<b>d</b> ' + (isLast ? '完成' : '下一个') +
        '</div>';
    } else {
      html += rvActions(!state.rvReveal, !!c.canPlay);
    }
    reviewView.innerHTML = html;

    const go = document.getElementById('rvGo');
    if (go) go.onclick = () => rvGoNext();
    const rev = document.getElementById('rvReveal');
    if (rev) rev.onclick = () => { state.rvReveal = true; renderReviewView(); };
    reviewView.querySelectorAll('.rv-grade').forEach((el) => {
      el.onclick = () => rvGrade(el.dataset.g);
    });
    const rt = document.getElementById('rvRetry');
    if (rt) rt.onclick = () => vscode.postMessage({ type: 'favRetry' });
    const pl = document.getElementById('rvPlay');
    if (pl) pl.onclick = () => rvPlayExample();
    return;
  }

  // ---- 4) 首页 ----
  const h = state.rvHome;
  if (!h) {
    reviewView.innerHTML = '<div class="center">读取中…</div>';
    return;
  }
  const totalWords = h.totalWords || 0;
  const canStart = (h.dueCount || 0) + (h.newLeft || 0) > 0;
  html = '<div class="center" style="padding:16px 10px;line-height:1.9">';
  if (h.message) {
    html += '<div class="answer" style="margin-bottom:10px;text-align:left">' + esc(h.message) + '</div>';
  }
  if (!totalWords) {
    html += '收藏里还没有可复习的单词。<br>' +
      '<span class="hint">在练习界面点「看答案」，点单词即可收藏' +
      '（需要释义或例句，否则没东西可对照）。</span>' +
      '<div style="margin-top:14px"><button id="rvGoFav" class="ghost">去收藏</button></div>';
  } else {
    /*
     * 今日任务做完了就把主按钮换成「再来 5 个」（提前复习）。
     * ⚠️ 不能只把「开始复习」disable 掉：用户练完一圈发现按钮灰了、
     *    又不知道还能不能继续练，会以为功能坏了。给个明确的出口。
     */
    html += '<div>待复习 <b>' + (h.dueCount || 0) + '</b> 个 · 今日可引入新词 <b>' +
      (h.newLeft || 0) + '</b> 个</div>' +
      '<div class="hint">收藏单词 ' + totalWords + ' 个 · 已掌握 ' + (h.masteredCount || 0) + ' 个' +
      (h.pendingCount ? ' · 24 小时内待复习 ' + h.pendingCount + ' 个' : '') + '</div>' +
      '<div style="margin-top:14px">' +
        (canStart
          ? '<button id="rvStart">开始复习</button>'
          : '<button id="rvExtra">再来 5 个</button>') +
      '</div>' +
      (canStart ? '' : '<div class="hint">今日复习已完成，明天继续</div>');
  }
  html += '</div>';
  reviewView.innerHTML = html;

  const st = document.getElementById('rvStart');
  if (st) st.onclick = () => vscode.postMessage({ type: 'reviewStart' });
  // 首页与结束页互斥，共用 rvExtra 这个 id 不会有冲突
  const ex = document.getElementById('rvExtra');
  if (ex) ex.onclick = () => vscode.postMessage({ type: 'reviewExtra' });
  const gf = document.getElementById('rvGoFav');
  if (gf) {
    gf.onclick = () => {
      showView('favorites');
      renderFavView();
      vscode.postMessage({ type: 'favListRequest' });
    };
  }
}

/* ---------------- 「发现 TED」浏览/搜索 ---------------- */

const discView = document.getElementById('discover');
const libView = document.getElementById('library');
const favView = document.getElementById('favView');
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

/* 视图统一切换：practice / discover / library / favorites / review / report 互斥显示 */
const reportView = document.getElementById('reportView');
const viewEls = {
  practice: document.getElementById('root'),
  discover: discView,
  library: libView,
  favorites: favView,
  review: reviewView,
  report: reportView,
};
let currentView = 'practice';

/* 顶部导航按钮 ↔ 视图的对应关系（用于给当前视图的按钮加高亮）。
 * ⚠️ 不含 practice：精听界面不是导航项，进练习只能从素材库选一篇素材。
 *    因此处在练习界面时三个导航按钮都不高亮（等于「不在任何 tab 里」）。 */
const navBtn = {
  discover: document.getElementById('discoverBtn'),
  library: document.getElementById('libraryBtn'),
  favorites: document.getElementById('favBtn'),
  review: document.getElementById('reviewBtn'),
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

navBtn.favorites.onclick = () => {
  if (currentView === 'favorites') return;
  showView('favorites');
  renderFavView();
  vscode.postMessage({ type: 'favListRequest' });
};

navBtn.review.onclick = () => {
  if (currentView === 'review') return;
  showView('review');
  renderReviewView();
  vscode.postMessage({ type: 'reviewListRequest' });
};

/* ---------------- 精听界面快捷键与播放动作 ----------------
 * 按钮与快捷键共用同一套动作函数，行为永远一致。
 * 快捷键：a 上一句 / d 下一句 / 空格 播放·暂停 / w 切播放模式 / s 切倍速
 * 守卫条件（按顺序）：
 *   - 只在精听界面生效
 *   - 带修饰键的组合键不碰（留给 VS Code / 浏览器）
 *   - 输入框/文本域聚焦时不抢键 —— 用户正在打听写内容，a/d/s/w/空格属于输入
 */
function gotoPrev() {
  const m = state.material;
  if (!m || state.currentIndex <= 0) return;
  state.currentIndex -= 1;
  render();
  playCurrent();
}

function gotoNext() {
  const m = state.material;
  if (!m || state.currentIndex >= m.sentences.length - 1) return;
  state.currentIndex += 1;
  render();
  playCurrent();
}

function togglePlayPause() {
  if (!player.paused) { player.pause(); return; }
  const m = state.material;
  const s = m && m.sentences[state.currentIndex];
  const ms = player.currentTime * 1000;
  // 暂停点仍在当前句区间内 → 原地恢复（不重新 seek）；否则从句首播
  if (player.currentSrc && s && ms > s.startMs && ms < s.endMs) {
    player.play().catch(() => {});
  } else {
    playCurrent();
  }
}

function cyclePlayMode() {
  state.playMode =
    PLAY_MODE_ORDER[(PLAY_MODE_ORDER.indexOf(state.playMode) + 1) % PLAY_MODE_ORDER.length];
  render();
  // 模式切换立即生效：正在播的句子按新模式重新布防看门狗
  if (!player.paused) {
    const s = state.material && state.material.sentences[state.currentIndex];
    if (s) armStopTimer(s.startMs / 1000, s.endMs / 1000);
  }
}

function cycleRate() {
  const rates = [1, 0.75, 0.5, 1.25];
  state.rate = rates[(rates.indexOf(state.rate) + 1) % rates.length];
  player.playbackRate = state.rate;
  render();
}

document.addEventListener('keydown', (e) => {
  if (currentView !== 'practice') return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) {
    return; // 正在输入，按键属于输入框
  }
  if (!state.material) return;
  switch (e.key) {
    case 'a': gotoPrev(); break;
    case 'd': gotoNext(); break;
    case ' ': e.preventDefault(); togglePlayPause(); break;
    case 'w': cyclePlayMode(); break;
    case 's': cycleRate(); break;
  }
});

/* ---------------- 复习界面快捷键 ----------------
 * 空格 = 播放例句音频 / a = 不认识 / s = 模糊 / d = 认识（停留态里是「下一个」）
 *
 * ⚠️ d 一键两义是刻意的：自评时它是「认识」，停留态（已评分、等你看答案）里
 *    自评按钮已经收起、屏幕上只剩「下一个 / 完成」那一个按钮，不存在歧义 ——
 *    于是「a 不认识 → 看一眼答案 → d 继续」可以一路盲打，手不用离开键盘。
 * ⚠️ 与精听界面同一套守卫：只在复习视图、不带修饰键、输入框聚焦时不抢键。
 *    e.repeat 也拦掉：按住不放在宿主侧会被当成连点评分。
 * ⚠️ 首页 / 轮次过场页 / 结束页没有卡，直接不管（否则空格会把过场页
 *    已聚焦的「继续」按钮的默认行为抢掉）。
 */
document.addEventListener('keydown', (e) => {
  if (currentView !== 'review') return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (e.repeat) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) {
    return; // 正在输入，按键属于输入框
  }
  if (!state.rvCard) return;
  switch (e.key) {
    case ' ': e.preventDefault(); rvPlayExample(); break;
    case 'a': rvGrade('unknown'); break;
    case 's': rvGrade('fuzzy'); break;
    case 'd': if (state.rvHeld) rvGoNext(); else rvGrade('know'); break;
  }
});

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
      esc(hint || '如果是网络问题，请在设置中配置 listenAndWrite.proxy') +
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

/** 把当前占比应用到 .list（null = 交给 CSS 默认）。收起状态下不干预。 */
function applyListFlex() {
  const listEl = document.getElementById('list');
  if (!listEl) return;
  const r = state.stacked ? state.stackedRatio : state.listRatio;
  if (typeof r === 'number' && !state.listCollapsed) {
    listEl.style.flex = '0 0 ' + (Math.round(r * 1000) / 10) + '%';
  } else {
    listEl.style.flex = '';
  }
}

/* ---- 分隔条：拖动调列表占比，单击收起/展开，双击恢复默认 ----
 * 复用 .list-toggle 这条窄条当手柄，不额外占空间。
 * 「点击 vs 拖动」用位移阈值区分：按下后挪动 < 4px 算点击。
 * 拖动过程只改内联样式不重绘（render() 会重建 DOM，拖动中重绘会闪）。
 * 双击会先触发两次 click（收起又展开，净效果不变），再触发重置。 */
function bindListResize(handle) {
  if (!handle) return;
  const mainEl = handle.parentElement;
  let dragging = false, moved = false, startPos = 0;
  const clampRatio = (v) => Math.min(0.8, Math.max(0.2, v));

  const onMove = (e) => {
    if (!dragging) return;
    const rect = mainEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const now = state.stacked ? e.clientY : e.clientX;
    if (Math.abs(now - startPos) >= 4) moved = true;
    if (!moved) return;
    let r;
    if (state.stacked) {
      // 上下布局：手柄在列表上方，鼠标上移 → 列表变高
      r = (rect.bottom - e.clientY) / rect.height;
    } else {
      // 左右布局：列表在左，鼠标右移 → 列表变宽
      r = (e.clientX - rect.left) / rect.width;
    }
    if (state.stacked) state.stackedRatio = clampRatio(r);
    else state.listRatio = clampRatio(r);
    applyListFlex();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.userSelect = '';
    if (moved) saveLayout();
  };

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true; moved = false;
    startPos = state.stacked ? e.clientY : e.clientX;
    document.body.style.userSelect = 'none';
    e.preventDefault();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  handle.addEventListener('click', () => {
    if (moved) { moved = false; return; } // 拖动结束附带的 click，不算点击
    state.listCollapsed = !state.listCollapsed;
    render();
  });

  handle.addEventListener('dblclick', () => {
    state.listRatio = null;
    state.stackedRatio = null;
    saveLayout();
    render();
  });
}

function render() {
  const m = state.material;
  if (!m) return;

  // ★ 同句重渲染（点选单词/收藏按钮等）不能让练习区滚动位置跳顶：
  //   root.innerHTML 重建会【销毁重建】.practice 这个 overflow-y:auto 容器，
  //   scrollTop 随之归零 —— 而答案面板在下半屏，一归零用户正在看的内容就被
  //   甩出视野（2026-09-21 反馈「点词和收藏按钮都会跳回顶部」）。
  //   做法：重建【前】记住位置（renderPractice 里取到的是新元素的 0），
  //   重建后仅当句号没变（同句重渲染）才还原；切句则从顶部看新内容。
  const oldPractice = document.getElementById('practice');
  const prevPracticeScroll = oldPractice ? oldPractice.scrollTop : 0;
  const sameIndex = renderedIndex === state.currentIndex;

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
        '拖动调整列表大小 · 单击收起/展开 · 双击恢复默认' + '">' +
        toggleArrow + '</div>' +
      '<div class="list" id="list"></div>' +
      '<div class="practice" id="practice"></div>' +
    '</div>';

  // ★ 顺序有讲究（2026-09-20 二次修复）：必须先填操作区、再定列表占比、
  //   最后填列表并定位当前句。stacked 布局下 .practice 是 flex:0 1 auto
  //   按内容占高、.list 吃剩余空间 —— 若先 renderList，此刻 .practice 还是
  //   空的、.list 高度虚高，居中算出的 scrollTop 在 practice 填充后就会
  //   把当前句挤到视口底部甚至视口外（用户反馈「列表只显示 4 句时当前句
  //   永远在底部，再缩高度就完全看不见」就是这个原因）。
  renderPractice();
  applyListFlex();
  renderList();

  // 字幕列表收缩开关 + 分隔条拖拽：单击收起（侧边栏/窄编辑器里听写区独占整行），
  // 按住拖动调整占比，双击恢复默认
  bindListResize(document.getElementById('listToggle'));

  updateLayoutBtn();

  const newPractice = document.getElementById('practice');
  if (newPractice && sameIndex) newPractice.scrollTop = prevPracticeScroll;
  renderedIndex = state.currentIndex;
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
    // 已收藏标记：只把命中的词包一层 span（不新增可点区域），整句命中时整行加 class
    const favRes = favMarksOf(s.text);
    return '<div class="item' + (i === state.currentIndex ? ' active' : '') +
      (favRes.sentFav ? ' fav-sentence' : '') + '" data-i="' + i + '">' +
      '<span class="idx">' + (i + 1) + '</span>' +
      '<span class="txt">' + renderListText(s.text) + tMark + '</span>' +
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

  // 定位当前播放句：⚠️ 不能用 scrollIntoView —— 它会滚动【所有】可滚动祖先，
  // 包括 overflow:hidden 的 html/body/#root（hidden 容器仍可被程序化滚动），
  // 结果整页内容被顶出可视区，表现为「位置跳转、当前句差好几条看不见」
  // （2026-09-20 反馈）。这里手动只滚 .list 自身，居中偏好。
  const active = list.querySelector('.item.active');
  if (active && list.clientHeight > 0) {
    const listRect = list.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    const target = list.scrollTop + (itemRect.top - listRect.top) -
      (list.clientHeight - itemRect.height) / 2;
    list.scrollTop = Math.max(0, target);
  }
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

/* ---- 答案面板点选收藏 ---- */

/** 把英文答案切成单词数组（撇号/连字符连写的词算一个词，如 don't、well-known） */
function answerTokens(text) {
  return text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
}

/* ---------------- 已收藏标记（单词 / 短语 / 整句） ----------------
 *
 * 收藏数据是【全局】的：按 type + 小写文本去重（core/favorites.ts），不绑文章。
 * 所以在 A 篇收藏的词，在 B 篇同样命中 —— 这是「生词标记」，不是「文章标记」。
 *
 * 性能：索引只在 favorites 数组身份变化时重建，单句命中按句文本缓存。
 * render() 每次点词都会整体重建 DOM，若每次都对 130+ 句重算短语匹配，
 * 收藏一多，点一下就会明显卡。（实测 1000 条收藏 × 137 句约几十毫秒，够感知）
 */

/** 归一化词条：小写 + 空白折叠。收藏文本与选区文本同源（token 用单空格 join），只差大小写 */
function favKey(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 选词/整句比较键：只保留英文词（标点、大小写、空白差异都不算差异）。
 * ⚠️ 整句收藏存的是【带标点的原句】（"… the hills."），而选区是 token 用空格
 *    join 出来的（"… the hills"，没有句号）。直接比 favKey 永远不相等 ——
 *    表现就是「句子明明收藏了，选中整句后按钮却还是『收藏所选』」。
 */
function favWordKey(text) {
  return answerTokens(text).join(' ').toLowerCase();
}

/** 收藏索引：单词/整句用 Set，短语按【首词】建 Map（逐 token 只查一次） */
let favIndex = { list: null, map: null };

function favMarkMap() {
  if (favIndex.list === state.favorites && favIndex.map) return favIndex.map;
  const words = new Set();
  const sentences = new Set();
  const phrases = new Map();
  for (const f of state.favorites) {
    const key = favKey(f.text);
    if (!key) continue;
    if (f.type === 'word') {
      // 用 token 键：历史数据里若混进标点（"hills."）也能对上句子里的 hills
      words.add(favWordKey(f.text) || key);
    } else if (f.type === 'sentence') {
      sentences.add(key);
      // 同一句只是标点不同也要能命中：选区比对用的是 token 键（见 favWordKey）
      const wordKey = favWordKey(f.text);
      if (wordKey) sentences.add(wordKey);
    } else if (f.type === 'phrase') {
      // 按 token 序列切，而不是 split(' ')：历史数据里存了标点或多余空白也能对齐
      const arr = answerTokens(f.text).map((t) => t.toLowerCase());
      if (!arr.length) continue;
      if (!phrases.has(arr[0])) phrases.set(arr[0], []);
      phrases.get(arr[0]).push({ words: arr, fav: f });
    }
  }
  favIndex = { list: state.favorites, map: { words, sentences, phrases } };
  return favIndex.map;
}

/** 单句命中缓存：键 = 句文本（同素材内重复句结果一致），随收藏/素材变化失效 */
let favHits = { list: null, material: null, byText: new Map() };

/**
 * 算出一句话里每个 token 的收藏命中级别。
 * 返回 { marks, spans, sentFav }：
 *   marks[i] = 'w' 单词命中 / 'p' 短语命中 / '' 无
 *   spans    = [{ start, end, fav }]（短语区间，闭区间）
 *   sentFav  = 整句收藏条目（没有则 null）
 */
function favMarksOf(text) {
  // 用素材【对象身份】而不是 id 做键：同 id 重新下发（字幕修正）时缓存也要失效
  const mat = state.material;
  if (favHits.list !== state.favorites || favHits.material !== mat) {
    favHits = { list: state.favorites, material: mat, byText: new Map() };
  }
  if (favHits.byText.has(text)) return favHits.byText.get(text);

  const map = favMarkMap();
  const toks = answerTokens(text);
  const lower = toks.map((t) => t.toLowerCase());
  const marks = new Array(toks.length).fill('');
  const spans = [];

  // 整句：全文本一致，或「只差标点」的 token 序列一致（跨文章也要同一句，实际很少）
  let sentFav = null;
  const sentKey = favKey(text);
  const sentWordKey = lower.join(' ');
  if (map.sentences.has(sentKey) || (sentWordKey && map.sentences.has(sentWordKey))) {
    sentFav = state.favorites.find(
      (f) => f.type === 'sentence' &&
        (favKey(f.text) === sentKey ||
         (!!sentWordKey && favWordKey(f.text) === sentWordKey))
    ) || null;
  }

  // 单词：同形词在一句里出现几次就标几次（文本级收藏没有位置信息）
  for (let i = 0; i < lower.length; i++) {
    if (map.words.has(lower[i])) marks[i] = 'w';
  }

  // 短语：按首词取候选，再逐词比对 token 序列。
  // ⚠️ 不能用 indexOf / includes —— 收藏 "to be" 会误命中 "to become"。
  for (let i = 0; i < lower.length; i++) {
    const cand = map.phrases.get(lower[i]);
    if (!cand) continue;
    for (const p of cand) {
      const n = p.words.length;
      if (i + n > lower.length) continue;
      let ok = true;
      for (let k = 1; k < n; k++) {
        if (lower[i + k] !== p.words[k]) { ok = false; break; }
      }
      if (!ok) continue;
      for (let k = i; k < i + n; k++) marks[k] = 'p';
      spans.push({ start: i, end: i + n - 1, fav: p.fav });
    }
  }

  // 整句命中：剩下没被单词/短语单独命中的词统一标 's'（绿色由 .ans-line 继承）。
  // 在这里一次性填好，两个渲染函数就不用各自再写一遍 fallback。
  if (sentFav) {
    for (let i = 0; i < marks.length; i++) if (!marks[i]) marks[i] = 's';
  }

  const res = { marks, spans, sentFav };
  favHits.byText.set(text, res);
  return res;
}

/**
 * 覆盖某个 token 的收藏单元（用于「整块锁定」）。
 * 取跨度【最小】的：短语优先于整句 —— 这样整句里收藏的短语仍能单独取消。
 * 无命中返回 null（走普通选区逻辑）。
 */
function favUnitAt(res, wi) {
  if (!res.marks.length) return null;
  const whole = res.sentFav
    ? { start: 0, end: res.marks.length - 1, fav: res.sentFav }
    : null;
  let best = null;
  for (const sp of res.spans) {
    if (wi < sp.start || wi > sp.end) continue;
    if (!best || (sp.end - sp.start) < (best.end - best.start)) best = sp;
  }
  // 短语必须【严格更短】才算更具体的单元：与整句同跨度时按整句处理。
  // 否则会锁到短语选区、而按钮按「选区覆盖整句」判成整句，取消目标对不上。
  if (whole && (!best || (best.end - best.start) >= whole.end - whole.start)) return whole;
  return best || whole;
}

/**
 * 答案渲染成「词 token + 原样分隔符」：
 * 单词包 <span class="tok">，点击收藏；分隔符保持原样转义输出。
 * 选区归属句号（favSelFor）不是当前句时不高亮 —— 切句后旧选区自动失效。
 * 收藏命中只给已有的词 span 追加 class；整句颜色由外层 .ans-line 负责。
 */
function renderAnswerTokens(text) {
  const words = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
  const sel = state.favSelFor === state.currentIndex ? state.favSel : [];
  const res = favMarksOf(text);
  const re = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
  let out = '', last = 0, wi = 0, m;
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    // mk = 'w' 单词 / 'p' 短语 / 's' 整句（只加波浪线，绿色由 .ans-line 继承）
    const mk = res.marks[wi];
    out += '<span class="tok' + (sel.indexOf(wi) >= 0 ? ' sel' : '') +
      (mk === 'w' ? ' fav-word' : mk === 'p' ? ' fav-phrase' : mk === 's' ? ' fav-sentence' : '') +
      '" data-tok="' + wi + '">' + esc(m[0]) + '</span>';
    wi++;
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

/**
 * 字幕列表用：只把命中的词包一层标记，不绑定点击（整行才是点击区）。
 * 连续同级别的词（中间只隔空白）合并成一个 span —— 短语/整句的下划线才连成
 * 一条线，而不是「每个词各一小段」。答案面板不能这么做：那里每个 token 都要
 * 独立可点，所以只有列表走这个渲染。
 */
function renderListText(text) {
  const res = favMarksOf(text);
  const re = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
  const toks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    toks.push({ start: m.index, end: m.index + m[0].length });
  }
  let out = '', last = 0, wi = 0;
  while (wi < toks.length) {
    const mk = res.marks[wi];
    if (!mk) {
      out += esc(text.slice(last, toks[wi].end));
      last = toks[wi].end;
      wi++;
      continue;
    }
    // 往后吞掉「同级别、且中间只有空白」的相邻词（有标点就断开）
    let j = wi;
    while (j + 1 < toks.length && res.marks[j + 1] === mk &&
      /^\s+$/.test(text.slice(toks[j].end, toks[j + 1].start))) j++;
    out += esc(text.slice(last, toks[wi].start)) +
      '<span class="lmark f' + mk + '">' +
      esc(text.slice(toks[wi].start, toks[j].end)) + '</span>';
    last = toks[j].end;
    wi = j + 1;
  }
  return out + esc(text.slice(last));
}

function renderPractice() {
  const m = state.material;
  const i = state.currentIndex;
  const s = m.sentences[i];
  if (!s) return;

  // 连播切句会整体重建 DOM —— 先记住输入框当前有没有焦点、光标在哪，
  // 重建后原样恢复。不恢复的话，即使「连播不抢焦点」，用户自己点进
  // 输入框的焦点也会在每次切句时被悄悄丢掉（2026-09-20 反馈：不应该
  // 去操作它，原本什么样就保持什么样）。
  const prevInput = document.getElementById('input');
  const hadInputFocus = document.activeElement &&
    document.activeElement.id === 'input';
  const prevValue = prevInput ? prevInput.value : null;
  const prevSel = (hadInputFocus && prevInput)
    ? [prevInput.selectionStart, prevInput.selectionEnd] : null;

  const r = state.results[i];
  const p = document.getElementById('practice');

  // 收藏命中索引（带缓存）：单词/短语/整句的收藏状态全在这里，渲染时只查表
  const favRes = favMarksOf(s.text);
  // 选区文本（选区归属当前句才有效），供「收藏所选」按钮展示与提交
  const selActive = state.favSelFor === i && state.favSel.length > 0;
  const selWords = answerTokens(s.text);
  const selText = selActive ? state.favSel.map((k) => selWords[k]).join(' ') : '';
  // 当前句是否已收藏（整句）。收藏去重键 = type+text（忽略大小写），对齐宿主
  const sentFav = favRes.sentFav;
  // 选区是否覆盖整句：全覆盖时优先按「整句」比对，避免把整句当成短语取消
  const selWhole = selActive && selWords.length > 0 &&
    state.favSel.length === selWords.length && state.favSel[0] === 0;
  const selKey = selActive ? favWordKey(selText) : '';
  // 选区恰好等于一条已收藏条目（整句 / 短语 / 单词）→ 按钮变「取消收藏」。
  // ⚠️ 必须用 favWordKey：整句收藏带标点、选区不带，直接比 favKey 永远不相等。
  const selFav = !selActive ? null
    : ((selWhole
        ? state.favorites.find((f) => f.type === 'sentence' && favWordKey(f.text) === selKey)
        : null) ||
       state.favorites.find((f) =>
         f.type === (state.favSel.length > 1 ? 'phrase' : 'word') &&
         favWordKey(f.text) === selKey));

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
      // 初始文案必须按播放器实际状态渲染：render() 重建 DOM 会把按钮文案
      // 重置，而「正在播放中切句/跳句」时 play() 在未暂停状态下不会再次
      // 触发 play 事件，按钮就会停留在错误的「▶ 播放」
      // （2026-09-20 反馈：切句后播放按钮状态错乱）
      '<button id="play">' + (player.paused ? '▶ 播放' : '⏸ 暂停') + '</button>' +
      '<button id="prev" class="ghost">上一句</button>' +
      '<button id="next" class="ghost">下一句</button>' +
      '<button id="rate" class="ghost">' + state.rate + 'x</button>' +
      '<button id="loop" class="ghost">' + PLAY_MODE_LABEL[state.playMode] + '</button>' +
      // 音频诊断是开发者工具：默认不渲染（listenAndWrite.showAudioDiagnostics）
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

    '<div class="answer" id="answerBox" style="display:' +
      (state.revealAnswer ? 'block' : 'none') + '">' +
      '<div class="lbl">标准答案（点击单词可选中，再点相邻词扩展成短语）</div>' +
      // 整句命中只给这层染绿（标点与空格跟着变），token 上的单词/短语标记再覆盖它
      '<div class="ans-line' + (sentFav ? ' fav-sentence' : '') + '">' +
        renderAnswerTokens(s.text) + '</div>' +
      '<div class="fav-bar">' +
        // 有选区时只显示「收藏所选」（收藏整句隐藏）；无选区时只显示收藏整句
        // 整句收藏二态：已收藏显示「已收藏」，再点取消收藏
        (!selActive
          ? '<button id="favSentence" class="ghost">' +
            (sentFav ? '✓ 已收藏整句（点击取消）' : '⭐ 收藏整句') + '</button>'
          : '<span class="sel-text">已选「' + esc(selText) + '」</span>' +
            // 选区已是收藏条目 → 二态成「取消收藏」（整句 / 短语 / 单词各自措辞）
            (selFav
              ? '<button id="favSelRemove" class="ghost">' +
                (selFav.type === 'sentence'
                  ? '✓ 已收藏整句（点击取消）' : '✓ 已收藏（点击取消）') + '</button>'
              : '<button id="favSelAdd" class="ghost">⭐ 收藏所选</button>') +
            '<button id="favSelClear" class="ghost">取消选择</button>') +
      '</div>' +
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

  // 播放按钮二态（连播/循环模式下也能随时暂停）：
  // 播放中 → 暂停；暂停且播放位置仍在当前句区间内 → 原地恢复（不重新 seek）；
  // 播放控制按钮：与快捷键共用同一套动作函数（行为一致，改一处两边生效）
  // play 二态逻辑见 togglePlayPause：播放中 → 暂停；
  // 暂停且播放位置仍在当前句区间内 → 原地恢复（不重新 seek）；
  // 否则（停着/已播到句尾）→ 从句首播
  document.getElementById('play').onclick = togglePlayPause;
  document.getElementById('replay').onclick = playCurrent;
  document.getElementById('prev').onclick = gotoPrev;
  document.getElementById('next').onclick = gotoNext;
  document.getElementById('rate').onclick = cycleRate;
  document.getElementById('loop').onclick = cyclePlayMode;
  // 看答案：显隐走 state（切句/倍速/切模式后依然保持），内容跟随当前句
  document.getElementById('reveal').onclick = () => {
    state.revealAnswer = !state.revealAnswer;
    render();
  };

  /* ---- 答案面板点选收藏 ---- */
  // 点词：首次选中；点相邻词扩展成短语；点不相邻词重置为新选择；
  // 再点已选中的唯一单词取消。选区只对当前句有效（favSelFor 锁句号）。
  // 例外：点在已收藏的短语/整句里 → 整块选中，只能整体取消（见 favUnitAt）。
  document.querySelectorAll('#answerBox .tok').forEach((el) => {
    el.onclick = () => {
      const wi = Number(el.dataset.tok);
      if (state.favSelFor !== i) { state.favSelFor = i; state.favSel = []; }

      // ① 点在已收藏的短语 / 整句里 → 整块锁定：只能整体取消，不能拆成单词再收藏。
      //    favUnitAt 取跨度最小的单元：短语优先于整句，整句里的短语因此仍能单独取消。
      const unit = favUnitAt(favRes, wi);
      if (unit) {
        const same = state.favSel.length === unit.end - unit.start + 1 &&
          state.favSel[0] === unit.start;
        if (same) {
          state.favSel = [];
          state.favSelFor = -1;
        } else {
          state.favSel = [];
          for (let k = unit.start; k <= unit.end; k++) state.favSel.push(k);
          state.favSelFor = i;
        }
        render();
        return;
      }

      // ② 普通选区：首次选中 / 相邻扩展 / 不相邻重置 / 再点取消
      const sel = state.favSel;
      if (sel.indexOf(wi) >= 0) {
        // 再点已选中的词 → 取消该词；一个不剩就回到初始状态
        state.favSel = sel.filter((k) => k !== wi);
        if (state.favSel.length === 0) state.favSelFor = -1;
      } else if (sel.length === 0) {
        state.favSel = [wi];
      } else if (sel.indexOf(wi - 1) >= 0 || sel.indexOf(wi + 1) >= 0) {
        state.favSel = sel.concat(wi).sort((a, b) => a - b);
      } else {
        state.favSel = [wi];
      }
      render();
    };
  });
  const favContext = () => ({
    sentenceText: s.text,
    sentenceTranslation: s.translation || '',
    talkTitle: m.title || '',
    sourceUrl: m.sourceUrl || '',
    sentenceIndex: i,
  });
  const favSelAdd = document.getElementById('favSelAdd');
  if (favSelAdd) {
    favSelAdd.onclick = () => {
      const text = state.favSel.map((k) => selWords[k]).join(' ');
      if (!text) return;
      vscode.postMessage({
        type: 'favAdd',
        fav: { type: state.favSel.length > 1 ? 'phrase' : 'word', text, context: favContext() },
      });
      state.favSel = [];
      render();
    };
  }
  const favSelRemove = document.getElementById('favSelRemove');
  if (favSelRemove && selFav) {
    favSelRemove.onclick = () => {
      // 与整句取消同一条通道：本地先移除让标记/按钮立即翻转，宿主回推 favList 再对账
      vscode.postMessage({ type: 'favRemove', id: selFav.id });
      state.favorites = state.favorites.filter((f) => f.id !== selFav.id);
      state.favSel = [];
      state.favSelFor = -1;
      render();
    };
  }
  const favSelClear = document.getElementById('favSelClear');
  if (favSelClear) {
    favSelClear.onclick = () => { state.favSel = []; render(); };
  }
  const favSentence = document.getElementById('favSentence');
  if (favSentence) {
    favSentence.onclick = () => {
      if (sentFav) {
        // 已收藏 → 取消收藏。本地先行移除让按钮立即变回，宿主回推 favList 再对账
        vscode.postMessage({ type: 'favRemove', id: sentFav.id });
        state.favorites = state.favorites.filter((f) => f.id !== sentFav.id);
      } else {
        vscode.postMessage({
          type: 'favAdd',
          fav: { type: 'sentence', text: s.text, context: favContext() },
        });
      }
      render();
    };
  }
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
  // 聚焦策略：不自动聚焦（避免吞掉快捷键 a/d/空格/w/s）。
  // 唯一例外：输入框本来就有焦点（用户自己点进去打字），重建后原样恢复，
  // 否则切句重渲染会把用户的手动焦点悄悄丢掉。
  if (hadInputFocus) ta.focus();
  // 内容没变（同句重渲染）才恢复光标位置；切句后是新内容，恢复旧偏移无意义
  if (prevSel && prevValue !== null && ta.value === prevValue) {
    ta.setSelectionRange(prevSel[0], prevSel[1]);
  }
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doCheck(); }
  });

  player.playbackRate = state.rate;
  // 原生循环是「整个文件」循环，与句级播放模型冲突，恒为关闭
  player.loop = false;
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

async function ensurePlayerSource(uri, mimeOverride) {
  if (lastLoadedUrl === uri && activeSrc) return activeSrc;

  pageLog('[LT-PAGE] ensurePlayerSource 入参 uri =', uri);

  // ★ 唯一加载路线：请扩展宿主直接读文件，把字节传过来。
  //   实测 asWebviewUri 产出的 vscode-cdn.net 地址会被资源服务 401 拒绝
  //   （fetch 拿到 12 字节 "Unauthorized"，audio 报 code=4），
  //   直链交给 player 则因不保证 Content-Type 报 SRC_NOT_SUPPORTED ——
  //   原来的「直链 / Blob / 宿主字节」三级降级的前两级恒失败，已移除。
  //   走宿主 fs 完全绕开 webview 的 CDN 权限层。
  //   uri + mime 一并下传：例句播放可能请求非当前素材的音频文件
  const r3 = await loadViaHostBytes(uri, mimeOverride || audioMime());
  pageLog('[LT-PAGE] 宿主字节结果 =', r3);
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
function loadViaHostBytes(uri, mime) {
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
        // MIME 优先用请求时声明的（例句可能来自非当前素材），否则按当前素材容器
        const blob = new Blob([u8], { type: msg.mime || audioMime() });
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
    // 把 uri + 期望 MIME 一起带给宿主：例句播放可能请求非当前素材的音频，
    // 宿主必须按 uri 读文件、按声明的 MIME 回包（否则会送来错误素材的字节）
    vscode.postMessage({ type: 'requestAudioBytes', uri: uri, mime: mime });
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
      '音频无法加载（宿主字节路线失败）。\\n' +
      (stale
        ? '当前容器是「' + m.audioFormat + '」，而 VS Code 内置 ffmpeg 不支持裸 ADTS。\\n' +
          '→ 这是旧版缓存，删除该素材后重新加载即可（v3 起改为 MP4 容器）。\\n'
        : '') +
      '直链: ' + m.audioUri + '\\n' +
      // 诊断按钮默认是关的（开发者开关），提示不能指向一个不存在的按钮
      (state.showAudioDiag
        ? '请点 🔧 查看诊断详情（含容器判定与播放器能力），并把扩展宿主输出里的 [LT-TRACE] 行发出来。'
        : '把扩展宿主输出里的 [LT-TRACE] 行发出来即可定位；需要更详细的现场信息时，' +
          '可在设置里开启 listenAndWrite.showAudioDiagnostics，界面上会出现 🔧 诊断按钮。')
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

  armStopTimer(start, end);
}

/**
 * 句尾看门狗：轮询到 currentTime 越过句尾时暂停，并按播放模式分派：
 * - loop：回到句首重播，并重新布防（否则重播那遍没有看门狗，会失控播穿到后面句子）
 * - auto：自动进入下一句继续播（纯听模式）；末句停下
 * - off：只暂停
 */
function armStopTimer(start, end) {
  if (player._stopTimer) clearInterval(player._stopTimer);
  player._stopTimer = setInterval(() => {
    if (player.paused || player.currentTime < end) return;
    player.pause();
    clearInterval(player._stopTimer);
    const m = state.material;
    if (state.playMode === 'loop') {
      player.currentTime = start;
      player.play().catch(() => {});
      armStopTimer(start, end);
    } else if (state.playMode === 'auto' && m) {
      if (state.currentIndex < m.sentences.length - 1) {
        state.currentIndex += 1;
        render();
        playCurrent();
      } else {
        pageLog('[LT-PAGE] 连播到末句，停止');
      }
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
