/**
 * HTTP 工具 —— 带代理支持、重试、并发控制
 *
 * 设计考虑：
 * - TED 在国内需代理，插件要能读配置
 * - 分片下载要求高成功率，需重试
 * - 85 个分片要并发，但要限流避免被封
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * ⚠️ User-Agent 策略（2026-09-18 实测，违反直觉，务必勿改）
 *
 * TED 由 Varnish 保护，对"伪装成浏览器但指纹不符"的请求直接 403：
 *   "403 Forbidden: automated access to TED.com is not permitted."
 *
 * 实测矩阵（GET talk 页面）：
 *   ❌ Chrome UA + 最简头            → 403
 *   ❌ Chrome UA + 完整 Sec-Fetch 头 → 403
 *   ❌ 旧版 Chrome UA                → 403
 *   ✅ curl/8.4.0 UA                 → 200 (182,981 B)
 *   ✅ 不带 User-Agent               → 200 (182,981 B)
 *
 * 结论：TED 拦截的是「声称浏览器身份但 TLS 指纹不匹配」的组合特征。
 *     越努力伪装浏览器，越容易被拦。保持朴素反而稳定。
 *     curl UA 比"无 UA"更稳妥（避免某些中间层拒绝空 UA）。
 */
const TED_UA = 'curl/8.4.0';

/** 非 TED 域（如 hls.ted.com / pu.tedcdn.com 的 CDN）用通用 UA 即可 */
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * 按目标域名选择 UA
 *
 * www.ted.com 是唯一有反爬策略的入口，其余 CDN 域均可正常访问。
 */
function pickUserAgent(url: string): string {
  try {
    const h = new URL(url).hostname;
    if (h === 'www.ted.com' || h === 'ted.com') return TED_UA;
  } catch {
    /* 忽略解析失败 */
  }
  return DEFAULT_UA;
}

export interface HttpOptions {
  /** 代理地址，如 http://127.0.0.1:7890 */
  proxy?: string;
  /** 超时毫秒 */
  timeout?: number;
  /** 重试次数 */
  retries?: number;
  /** 自定义 headers */
  headers?: Record<string, string>;
}

/** 简易 HTTP GET，返回 Buffer */
export function httpGetBuffer(url: string, opts: HttpOptions = {}): Promise<Buffer> {
  const retries = opts.retries ?? 3;
  return attempt(retries);

  async function attempt(left: number): Promise<Buffer> {
    try {
      return await once(url, opts);
    } catch (e) {
      if (left <= 0) throw e;
      await sleep(300 * (retries - left + 1));
      return attempt(left - 1);
    }
  }
}

/** 简易 HTTP GET，返回文本 */
export async function httpGetText(url: string, opts: HttpOptions = {}): Promise<string> {
  const buf = await httpGetBuffer(url, { ...opts, headers: { Accept: 'text/html,*/*', ...opts.headers } });
  return buf.toString('utf8');
}

function once(url: string, opts: HttpOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const timeout = opts.timeout ?? 30000;

    const headers: Record<string, string> = {
      'User-Agent': pickUserAgent(url),
      Accept: '*/*',
      ...opts.headers,
    };

    let req: http.ClientRequest;

    const handler = (res: http.IncomingMessage) => {
      // 跟随重定向
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(once(next, opts));
        return;
      }

      if (res.statusCode !== 200) {
        // 403 需要额外说明：TED 的反爬拦截，不是网络问题
        if (res.statusCode === 403) {
          res.resume();
          reject(
            new Error(
              `HTTP 403 —— 被 TED 反爬拦截（automated access is not permitted）。\n` +
                `这通常意味着请求特征被识别为自动化。可尝试：\n` +
                `  1. 配置 listenAndWrite.proxy 走代理\n` +
                `  2. 稍后重试（TED 的拦截有时是短时的）\n` +
                `  URL: ${url}`
            )
          );
          return;
        }
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage ?? ''} — ${url}`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    };

    // 代理处理：仅支持 http 代理（CONNECT 隧道）
    if (opts.proxy && isHttps) {
      const p = new URL(opts.proxy);
      const connectReq = http.request({
        host: p.hostname,
        port: p.port || 80,
        method: 'CONNECT',
        path: `${u.hostname}:${u.port || 443}`,
        headers: { Host: `${u.hostname}:${u.port || 443}` },
        timeout,
      });

      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
          return;
        }
        const req2 = https.request(
          {
            host: u.hostname,
            port: Number(u.port || 443),
            path: u.pathname + u.search,
            method: 'GET',
            headers,
            createConnection: () => socket,
            agent: false as unknown as http.Agent,
            timeout,
          },
          handler
        );
        req2.on('error', reject);
        req2.on('timeout', () => {
          req2.destroy();
          reject(new Error(`请求超时：${url}`));
        });
        req2.end();
      });

      connectReq.on('error', reject);
      connectReq.on('timeout', () => {
        connectReq.destroy();
        reject(new Error(`代理连接超时：${opts.proxy}`));
      });
      connectReq.end();
      return;
    }

    const mod = isHttps ? https : http;
    req = mod.request(
      {
        host: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        timeout,
      },
      handler
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时：${url}`));
    });
    req.end();
  });
}

/** 并发映射，限制同时执行数 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));

  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        // 单点失败不阻断整批，由调用方决定如何处理空值
        results[i] = undefined as unknown as R;
      }
    }
  });

  await Promise.all(workers);
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
