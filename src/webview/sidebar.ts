/**
 * 侧边栏视图提供者 —— 承载完整练习 UI
 *
 * 历史：最初侧边栏只做「入口 + 状态」（列缓存、跳编辑器面板），
 * 因为担心 300px 宽度放不下练习界面。实际用下来用户明确要求
 * 把完整精听 UI 直接放进侧边栏，不再跳编辑器标签页。
 *
 * 实现：PracticePanel 已把容器抽象为 vscode.Webview 接口
 * （WebviewPanel 与 WebviewView 的 .webview 同构），侧边栏只需把
 * WebviewView 的 webview 交给 PracticePanel.attachToSidebar()。
 * 注意两点：
 *   - localResourceRoots 必须含 globalStorageUri（音频要加载）
 *   - retainContextWhenHidden 由 extension.ts 的 registerWebviewViewProvider
 *     选项保证，切走再回来听写进度不丢
 */

import * as vscode from 'vscode';
import { PracticePanel, PanelDeps } from './panel';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'listenAndWrite.practice';

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly deps: PanelDeps
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      // 练习 UI 要加载音频（globalStorage）——与编辑器面板保持一致
      localResourceRoots: [this.ctx.extensionUri, this.ctx.globalStorageUri],
    };

    PracticePanel.attachToSidebar(this.ctx, this.deps, view);
  }
}
