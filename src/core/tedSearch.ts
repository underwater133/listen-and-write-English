/**
 * TED 搜索/浏览（宿主代理）
 *
 * TED 站内搜索走 Algolia：POST https://www.ted.com/api/search，
 * body 是 JSON 数组，每个元素 {indexName, params}；响应为 {results: [...]}。
 *
 * ⚠️ 为什么由宿主代理而不是 webview 直接 fetch：
 *   webview 的 CSP 不可能放行 https: 的 connect-src（等于对任意域开放），
 *   且 TED 有 UA 反爬（非浏览器 UA 反而更稳 —— 需 curl UA，见 sources/ted.ts）。
 *   宿主侧请求 + postMessage 回传是唯一可控的路径。
 *
 * indexName 支持 4 种排序（2026-09-18 实测全部可用，响应里的 "index"
 * 字段即回显实际索引名）：
 *   relevance（默认，等价于带 hash 的 alias）/ popular / newest / oldest
 */

const SEARCH_URL = 'https://www.ted.com/api/search';

/** 每页条数（列表卡片较高，10 条一屏正好） */
export const PAGE_SIZE = 10;

export type TedSort = 'relevance' | 'popular' | 'newest' | 'oldest';

export interface TedHit {
  /** TED 的 talk 数字 id（如 113508） */
  id: string;
  title: string;
  slug: string;
  speakers: string;
  /** 秒（TED 返回的是字符串） */
  durationSec: number;
  /** 封面缩略图 URL（已挑好尺寸） */
  thumb: string;
}

export interface TedSearchPage {
  hits: TedHit[];
  nbHits: number;
  page: number;
  nbPages: number;
  sort: TedSort;
}

function request(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(body);
    const req = require('https').request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'User-Agent': 'curl/8.4.0', // TED 反爬：浏览器 UA 反而被拒，见 sources/ted.ts
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          'Accept-Encoding': 'gzip',
        },
        timeout: 30000,
      },
      (res: any) => {
        const cs: Buffer[] = [];
        res.on('data', (c: Buffer) => cs.push(c));
        res.on('end', () => {
          let b = Buffer.concat(cs);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc.includes('gzip')) b = require('zlib').gunzipSync(b);
            else if (enc.includes('br')) b = require('zlib').brotliDecompressSync(b);
          } catch { /* 保留原始字节 */ }
          resolve({ status: res.statusCode, body: b.toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.write(data);
    req.end();
  });
}

/** 从 photos 里挑一张适合做列表缩略图的 URL（优先小尺寸横向图） */
function pickThumb(hit: any): string {
  const photos = hit.photos || [];
  for (const p of photos) {
    const sizes = p.photo_sizes || [];
    // 1350x675（aspect 36）是列表横图；其次 embed 2880x1620；再次任意
    const small = sizes.find((s: any) => s.talkstar_aspect_ratio_id === 36);
    if (small) return small.url;
    const embed = sizes.find((s: any) => s.talkstar_aspect_ratio_id === 2);
    if (embed) return embed.url;
    if (sizes[0]) return sizes[0].url;
  }
  return '';
}

/** slug → 可被 TED 源适配器处理的 talk 页面 URL */
export function tedHitUrl(slug: string): string {
  return 'https://www.ted.com/talks/' + slug;
}

/**
 * 搜索/浏览 TED talks。
 * @param query 关键词（空串 = 浏览）
 * @param sort 排序方式（对应 TED 站点的 4 种索引）
 * @param page 从 0 开始
 */
export async function tedApiSearch(
  query: string,
  sort: TedSort,
  page: number
): Promise<TedSearchPage> {
  const payload = [
    {
      indexName: sort,
      params: {
        attributeForDistinct: 'objectID',
        distinct: 1,
        facets: ['subtitle_languages', 'tags'],
        highlightPostTag: '__/ais-highlight__',
        highlightPreTag: '__ais-highlight__',
        // 每页 10 条：一屏能看完，翻页比长列表滚动更好定位（2026-09-19 调整）
        hitsPerPage: PAGE_SIZE,
        maxValuesPerFacet: 500,
        page: Math.max(0, page | 0),
        query: query || '',
      },
    },
  ];

  const r = await request(SEARCH_URL, JSON.stringify(payload));
  if (r.status !== 200) {
    throw new Error('TED 搜索接口返回 ' + r.status);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(r.body);
  } catch {
    throw new Error('TED 搜索接口返回非 JSON（可能是反爬页）');
  }
  const first = parsed && parsed.results && parsed.results[0];
  if (!first) throw new Error('TED 搜索接口返回结构异常');

  const hits: TedHit[] = (first.hits || []).map((h: any) => ({
    id: String(h.objectID ?? ''),
    title: String(h.title ?? '(无标题)'),
    slug: String(h.slug ?? ''),
    speakers: String(h.speakers ?? ''),
    durationSec: Math.round(Number(h.duration) || 0),
    thumb: pickThumb(h),
  }));

  return {
    hits,
    nbHits: Number(first.nbHits) || 0,
    page: Number(first.page) || 0,
    nbPages: Number(first.nbPages) || 0,
    sort,
  };
}
