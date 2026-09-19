/**
 * 扩展主入口
 *
 * 职责：
 * - 注册命令
 * - 管理素材缓存目录
 * - 管理练习会话状态与错误记录持久化
 * - 桥接 webview <-> 素材源
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ListeningMaterial, MaterialSourceAdapter } from './core/types';
import { TedSource } from './sources/ted';
import { MistakeRecord, SentenceResult } from './core/diff';
import { PracticePanel } from './webview/panel';
import { SidebarViewProvider } from './webview/sidebar';

let cacheRoot: string;
/** 默认素材位置（globalStorage/materials）——materialsDir 未配置时的落点，也是迁移的源 */
let defaultCacheRoot: string;
let adapters: MaterialSourceAdapter[] = [];
let outChannel: vscode.OutputChannel;

/**
 * 解析素材根目录：配置了 materialsDir 用它（绝对路径），否则默认位置。
 * 空串/空白 = 使用默认位置（与设置项描述一致）。
 */
function resolveCacheRoot(cfgValue: string): string {
  const v = (cfgValue || '').trim();
  return v ? path.resolve(v) : defaultCacheRoot;
}

/**
 * 修正素材目录内记录里的【绝对路径】。
 *
 * ⚠️ 为什么搬迁后必须做这一步：
 *   audio.json.path 与 material.json.cacheDir 存的是写入时的绝对路径。
 *   目录被搬走后它们仍指向旧位置，后果是：
 *     - 点素材库卡片 → 判 existsSync 失败 → 误报「音频缓存已过期」
 *     - 恢复上次素材时 readFileSync 抛错 → 素材被静默跳过
 *     - audioUri 指向不存在的文件 → 播放静默失败
 *   （2026-09-19 实测：配置 materialsDir 后必现）
 *
 * 读取侧也做了兜底重定位（core/types.ts 的 relocateAudioPath），
 * 这里就地修正则是为了让磁盘上的数据自愈，避免旧路径一直留在文件里。
 */
function fixAbsolutePathsInDir(dir: string): void {
  const audioJson = path.join(dir, 'audio.json');
  if (fs.existsSync(audioJson)) {
    try {
      const info = JSON.parse(fs.readFileSync(audioJson, 'utf8')) as { path?: string };
      // 只按文件名重定位，绝不接受记录里的目录部分（防越界）
      const target = path.join(dir, path.basename(info.path || 'audio.mp3'));
      if (info.path !== target && fs.existsSync(target)) {
        info.path = target;
        fs.writeFileSync(audioJson, JSON.stringify(info, null, 2), 'utf8');
        trace(`已修正音频路径记录 → ${target}`);
      }
    } catch {
      /* 单条记录损坏不影响迁移 */
    }
  }

  const metaJson = path.join(dir, 'material.json');
  if (fs.existsSync(metaJson)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaJson, 'utf8')) as { cacheDir?: string };
      if (m.cacheDir !== dir) {
        m.cacheDir = dir;
        fs.writeFileSync(metaJson, JSON.stringify(m, null, 2), 'utf8');
      }
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 把 from 下的素材目录整体搬到 to。
 *
 * 规则（保证幂等与安全）：
 *   - 只搬「含 material.json」的目录，跳过杂项文件
 *   - 目标同名目录已存在则跳过（两边都保留，绝不覆盖 —— 用户数据面前宁可多余不可丢失）
 *   - rename 失败（跨盘 EXDEV）退化为复制 + 删除源
 *   - 搬完立刻修正目录内的绝对路径（否则缓存会「看起来过期」）
 */
function migrateMaterials(from: string, to: string): { moved: number; skipped: number } {
  if (!from || from === to || !fs.existsSync(from)) return { moved: 0, skipped: 0 };
  fs.mkdirSync(to, { recursive: true });
  let moved = 0;
  let skipped = 0;
  for (const d of fs.readdirSync(from, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const src = path.join(from, d.name);
    if (!fs.existsSync(path.join(src, 'material.json'))) continue;
    const dst = path.join(to, d.name);
    if (fs.existsSync(dst)) {
      skipped++;
      continue;
    }
    try {
      fs.renameSync(src, dst);
    } catch {
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
    // 搬完立刻把目录内的绝对路径改成新位置 —— 否则缓存会被判成「已过期」
    fixAbsolutePathsInDir(dst);
    moved++;
  }
  return { moved, skipped };
}

/**
 * 素材位置变更时的统一处理：迁移数据 + 提示重载窗口。
 * deps.cacheRoot 在各视图创建时已固定，运行中热切会让新旧面板指向不同根，
 * 所以迁移完成后只提示重载，不在运行中热切换。
 */
function handleMaterialsDirChange(): void {
  const newCfg = vscode.workspace
    .getConfiguration('listeningTrainer')
    .get<string>('materialsDir', '');
  const newRoot = resolveCacheRoot(newCfg);
  if (newRoot === cacheRoot) return;

  trace('materialsDir 变更: ' + cacheRoot + ' → ' + newRoot);
  // 当前根 + 默认根都作为迁移源兜底（配置可能来回切过）
  const r1 = migrateMaterials(cacheRoot, newRoot);
  const r2 =
    defaultCacheRoot === cacheRoot
      ? { moved: 0, skipped: 0 }
      : migrateMaterials(defaultCacheRoot, newRoot);
  const total = r1.moved + r2.moved;
  trace(`迁移完成: moved=${total} skipped=${r1.skipped + r2.skipped}`);

  fs.mkdirSync(newRoot, { recursive: true });
  vscode.window
    .showInformationMessage(
      total > 0
        ? `已迁移 ${total} 个素材到新位置。重载窗口后生效。`
        : '素材位置已更新。重载窗口后生效。',
      '重载窗口'
    )
    .then((pick) => {
      if (pick) vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
}

export function trace(msg: string): void {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
  if (outChannel) outChannel.appendLine(line);
  else console.log(line);
}

export function activate(context: vscode.ExtensionContext): void {
  outChannel = vscode.window.createOutputChannel('Listen & Write · 听写英语');
  context.subscriptions.push(outChannel);

  defaultCacheRoot = path.join(context.globalStorageUri.fsPath, 'materials');
  const cfg = vscode.workspace.getConfiguration('listeningTrainer');
  cacheRoot = resolveCacheRoot(cfg.get<string>('materialsDir', ''));
  fs.mkdirSync(cacheRoot, { recursive: true });
  trace('activate: cacheRoot = ' + cacheRoot);

  // 用户先在默认位置用了很久、后来才配置自定义位置的场景：
  // 激活时把默认位置的素材迁过去（幂等，目标同名则跳过）
  if (cacheRoot !== defaultCacheRoot) {
    const r = migrateMaterials(defaultCacheRoot, cacheRoot);
    if (r.moved) {
      trace(`activate: 从默认位置迁移 ${r.moved} 个素材（跳过 ${r.skipped}）`);
      vscode.window.showInformationMessage(
        `已迁移 ${r.moved} 个素材到配置的素材位置。` +
          (r.skipped ? `另有 ${r.skipped} 个因目标位置已存在同名素材被跳过。` : '')
      );
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('listeningTrainer.materialsDir')) {
        handleMaterialsDirChange();
      }
    })
  );

  const log = (msg: string) => trace(msg);

  adapters = [
    new TedSource({
      quality: cfg.get<'low' | 'medium' | 'high'>('audioQuality', 'medium'),
      concurrency: cfg.get<number>('concurrency', 6),
      skipIntro: cfg.get<boolean>('skipIntro', true),
      withTranslation: true,
      proxy: cfg.get<string>('proxy', '') || undefined,
      log,
    }),
  ];

  const panelDeps = {
    adapters,
    cacheRoot,
    storage: context.globalStorageUri.fsPath,
  };

  context.subscriptions.push(
    // 侧边栏视图：承载完整练习 UI（与编辑器面板同一套宿主逻辑）
    vscode.window.registerWebviewViewProvider(
      SidebarViewProvider.viewType,
      new SidebarViewProvider(context, panelDeps),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),

    vscode.commands.registerCommand('listeningTrainer.openPractice', () => {
      PracticePanel.createOrShow(context, panelDeps);
    }),

    vscode.commands.registerCommand('listeningTrainer.loadTed', async () => {
      const url = await vscode.window.showInputBox({
        title: '从 TED 加载素材',
        prompt: '粘贴 TED talk 链接',
        placeHolder: 'https://www.ted.com/talks/bill_gates_the_next_outbreak_we_re_not_ready',
        validateInput: (v) =>
          /^https?:\/\/(www\.)?ted\.com\/talks\//i.test(v.trim())
            ? undefined
            : '请输入有效的 TED talk 链接',
      });
      if (!url) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '听力素材', cancellable: false },
        async (progress) => {
          progress.report({ message: '解析页面…' });
          const adapter = adapters.find((a) => a.canHandle(url));
          if (!adapter) {
            vscode.window.showErrorMessage('没有可处理该链接的素材源。');
            return;
          }

          try {
            const material = await adapter.fetchMetadata(url, cacheRoot);
            progress.report({
              message: `已解析 ${material.sentences.length} 句，准备音频…`,
            });

            const ready = await adapter.fetchAudio(material, (p) => {
              progress.report({ message: p.message });
            });

            PracticePanel.createOrShow(context, panelDeps);
            // 侧边栏与编辑器面板是两个独立 webview 实例，素材要同时喂
            PracticePanel.current?.loadMaterial(ready);
            PracticePanel.sidebar?.loadMaterial(ready);

            vscode.window.showInformationMessage(
              `《${ready.title}》已就绪：${ready.sentences.length} 句`
            );
          } catch (e) {
            const msg = (e as Error).message;
            vscode.window.showErrorMessage(`加载失败：${msg}`);
            log('loadTed error: ' + msg);
          }
        }
      );
    }),

    vscode.commands.registerCommand('listeningTrainer.loadLocal', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 音频: ['aac', 'mp3', 'm4a', 'wav'] },
        title: '选择本地音频',
      });
      if (!uris || uris.length === 0) return;
      vscode.window.showInformationMessage(
        '本地音频源依赖强制对齐（尚未实现）。建议先用 TED 源验证体验。'
      );
    }),

    vscode.commands.registerCommand('listeningTrainer.showReport', () => {
      PracticePanel.createOrShow(context, panelDeps);
      PracticePanel.current?.showReport();
    }),

    vscode.commands.registerCommand('listeningTrainer.clearCache', async () => {
      const pick = await vscode.window.showWarningMessage(
        '确定清空所有已下载的音频缓存？',
        { modal: true },
        '清空'
      );
      if (pick !== '清空') return;
      if (fs.existsSync(cacheRoot)) {
        fs.rmSync(cacheRoot, { recursive: true, force: true });
      }
      fs.mkdirSync(cacheRoot, { recursive: true });
      vscode.window.showInformationMessage('音频缓存已清空。');
    })
  );
}

export function deactivate(): void {
  /* noop */
}

/* ------------------------------------------------------------------ */
/* 错误记录持久化                                                      */
/* ------------------------------------------------------------------ */

/**
 * 追加式写入错误记录（jsonl），便于长期累积与统计
 */
export class MistakeStore {
  private file: string;

  constructor(storageRoot: string) {
    const dir = path.join(storageRoot, 'stats');
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'mistakes.jsonl');
  }

  append(materialId: string, result: SentenceResult): void {
    const lines: string[] = [];
    for (const t of result.tokens) {
      if (t.op === 'equal') continue;
      const rec: MistakeRecord = {
        timestamp: Date.now(),
        materialId,
        sentenceIndex: result.sentenceIndex,
        kind: t.kind ?? 'misheard',
        expected: t.expected ?? t.actual ?? '',
        actual: t.actual,
      };
      lines.push(JSON.stringify(rec));
    }
    if (lines.length > 0) {
      fs.appendFileSync(this.file, lines.join('\n') + '\n', 'utf8');
    }
  }

  readAll(): MistakeRecord[] {
    if (!fs.existsSync(this.file)) return [];
    const out: MistakeRecord[] = [];
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s) as MistakeRecord);
      } catch {
        /* 跳过损坏行 */
      }
    }
    return out;
  }
}
