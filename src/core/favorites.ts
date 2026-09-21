/**
 * 收藏（单词 / 短语 / 整句）持久化 + 百度翻译客户端
 *
 * 设计要点：
 * - 整句收藏的译文直接用 TED zh-cn 字幕（sentence.translation），零 API 成本；
 *   单词/短语的译文走百度翻译通用 API（标准版免费，QPS=1）。
 * - QPS=1 → TranslationQueue 串行执行，相邻请求间隔 ≥1.1s（留余量）。
 * - 未配置 API（appId/secret 为空）时照常收藏：条目 pending=true、译文为空，
 *   收藏视图里手动点「更新翻译」补译 —— 不自动重试，尊重用户节奏。
 * - 翻译结果写回条目，同一词条一生只查一次。
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { httpGetText } from './http';

export type FavoriteType = 'word' | 'phrase' | 'sentence';

export interface FavoriteContext {
  /** 收藏时的原句（记忆锚点） */
  sentenceText: string;
  /** 原句中译（TED 字幕自带；整句收藏的译文就来自这里） */
  sentenceTranslation: string;
  talkTitle: string;
  /** talk 页面 URL，宿主据此用 slugFromUrl 算 slug 并对齐素材目录 */
  sourceUrl: string;
  sentenceIndex: number;
  /** 来源素材目录名（宿主收藏时通过 scanCached 按 slug 对齐补充） */
  dirName?: string;
}

export interface FavoriteEntry {
  id: string;
  type: FavoriteType;
  text: string;
  translation: string;
  /** true = 还没有译文（未配置 API 或查询失败），可在收藏视图手动重试 */
  pending: boolean;
  context: FavoriteContext;
  createdAt: number;
}

const BAIDU_ENDPOINT = 'https://fanyi-api.baidu.com/api/trans/vip/translate';
/** 百度标准版 QPS=1：串行队列相邻请求的最小间隔（略大于 1s，留余量） */
export const BAIDU_QPS_INTERVAL_MS = 1100;

/** 签名规则：MD5(appid + q + salt + 密钥)，32 位小写；q 用 urlencode 前的原文 */
export function baiduSign(appId: string, q: string, salt: string, secret: string): string {
  return crypto
    .createHash('md5')
    .update(appId + q + salt + secret, 'utf8')
    .digest('hex');
}

/** 单次请求：q 传入的数组以 \n 拼接，返回按序对应的 trans_result 数组 */
async function baiduRequest(
  texts: string[],
  appId: string,
  secret: string,
  proxy?: string
): Promise<Array<{ src: string; dst: string }>> {
  const q = texts.join('\n');
  const salt = String(Date.now());
  const sign = baiduSign(appId, q, salt, secret);
  const url =
    BAIDU_ENDPOINT +
    '?q=' + encodeURIComponent(q) +
    '&from=en&to=zh' +
    '&appid=' + encodeURIComponent(appId) +
    '&salt=' + salt +
    '&sign=' + sign;

  const raw = await httpGetText(url, { proxy: proxy || undefined, timeout: 15000, retries: 2 });

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('百度翻译响应不是 JSON（可能被代理/网关拦截）');
  }
  if (data.error_code) {
    throw new Error('百度翻译错误 ' + data.error_code + ': ' + (data.error_msg || ''));
  }
  if (!Array.isArray(data.trans_result) || data.trans_result.length === 0) {
    throw new Error('百度翻译返回为空');
  }
  return data.trans_result.map((x: any) => ({ src: String(x.src ?? ''), dst: String(x.dst ?? '') }));
}

/** 查一条译文（多义项由百度合并进一个字符串，如「人类；人的」）；失败抛错 */
export async function baiduTranslate(
  text: string,
  appId: string,
  secret: string,
  proxy?: string
): Promise<string> {
  const arr = await baiduRequest([text], appId, secret, proxy);
  return arr.map((x) => x.dst).join('\n');
}

/**
 * 批量翻译：多个文本合并为一次请求（q 内用 \n 分行，百度按行返回、计费按字符，
 * 请求数只算 1 次）——「更新翻译」N 个待译词条只需 1 个请求，不用逐条等 QPS。
 * 单请求 q 上限 6000 字节（UTF-8），超限自动分块，每块之间仍由队列保证 QPS 间隔。
 * 返回数组顺序与入参一致。
 */
export async function baiduTranslateBatch(
  texts: string[],
  appId: string,
  secret: string,
  proxy?: string
): Promise<string[]> {
  // 行内不能有换行（会破坏 \n 分行协议）；单词/短语正常不含，兜底替换掉
  const safe = texts.map((t) => t.replace(/\r?\n/g, ' '));
  const out: string[] = [];
  let chunk: string[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (!chunk.length) return;
    const arr = await baiduRequest(chunk, appId, secret, proxy);
    if (arr.length !== chunk.length) {
      throw new Error('百度翻译返回行数(' + arr.length + ')与请求(' + chunk.length + ')不一致');
    }
    for (const x of arr) out.push(x.dst);
    chunk = [];
    bytes = 0;
  };
  for (const t of safe) {
    const b = Buffer.byteLength(t, 'utf8') + 1; // +1 = \n 占位
    if (bytes + b > 5000) await flush(); // 5000 < 6000，留余量
    chunk.push(t);
    bytes += b;
  }
  await flush();
  return out;
}

/** 串行翻译队列：QPS=1，任务逐个执行，相邻任务之间强制间隔 */
export class TranslationQueue {
  private chain: Promise<void> = Promise.resolve();

  /**
   * 入队一个任务。返回该任务自身的 Promise（结果/异常透传给调用方），
   * 但队列链吞掉异常 —— 一条失败不影响后面的任务。
   */
  push<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      try {
        return await task();
      } finally {
        // 无论成败都让出 QPS 间隔
        await new Promise((r) => setTimeout(r, BAIDU_QPS_INTERVAL_MS));
      }
    });
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/**
 * 收藏存储：globalStorage/favorites.json，整文件读写。
 * 每次变更都重新 load → 改 → save（侧边栏与编辑器面板是两个实例共享同一
 * 文件，重读能把丢写窗口压到最小；用户实际只会同时操作一个界面）。
 * 文件损坏 → 视为空列表，绝不抛错（页面脚本抛错会整页按钮失效）。
 */
export class FavoriteStore {
  private file: string;

  constructor(storageRoot: string) {
    this.file = path.join(storageRoot, 'favorites.json');
  }

  private load(): FavoriteEntry[] {
    if (!fs.existsSync(this.file)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data?.items) ? data.items : [];
    } catch {
      return [];
    }
  }

  private save(items: FavoriteEntry[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      JSON.stringify({ version: 1, items }, null, 2),
      'utf8'
    );
  }

  /** 最新在前 */
  list(): FavoriteEntry[] {
    return this.load().sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 新增。去重键 = type + text（忽略大小写）：重复收藏同一词条时不新增，
   * 只把 context 刷新为最近一次（例句/课程换成最新的），原译文保留。
   */
  add(
    entry: Omit<FavoriteEntry, 'id' | 'createdAt'>
  ): { fav: FavoriteEntry; deduped: boolean } {
    const items = this.load();
    const key = entry.type + ':' + entry.text.toLowerCase();
    const exist = items.find((x) => x.type + ':' + x.text.toLowerCase() === key);
    if (exist) {
      exist.context = entry.context;
      this.save(items);
      return { fav: exist, deduped: true };
    }
    const fav: FavoriteEntry = {
      ...entry,
      id: 'fav' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      createdAt: Date.now(),
    };
    items.push(fav);
    this.save(items);
    return { fav, deduped: false };
  }

  remove(id: string): void {
    const items = this.load();
    const out = items.filter((x) => x.id !== id);
    if (out.length !== items.length) this.save(out);
  }

  setTranslation(id: string, translation: string): void {
    const items = this.load();
    const it = items.find((x) => x.id === id);
    if (it) {
      it.translation = translation;
      it.pending = false;
      this.save(items);
    }
  }
}
