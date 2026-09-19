/**
 * TED 素材源适配器
 *
 * 依据实测报告：ted-probe/TED-API-probe-report.md
 *
 * 完整流程（已验证）：
 *   1. GET talk 页面 HTML
 *   2. indexOf 抽 __NEXT_DATA__ JSON
 *   3. 取 title/presenter/hlsUrl，正则提取 projectMasterId
 *   4. GET metadata.json → duration + 各语言 VTT URL
 *   5. GET en/full.vtt → parseWebVtt → Sentence[]
 *   6. GET zh-cn/full.vtt → mergeTranslation（可选）
 *   7. GET master m3u8 → parseAudioRenditionUri
 *   8. GET variant m3u8 → parseVariantSegments（85 片，首片为 intro）
 *   9. 并发下载 → 逐片解封装 → concat → 裸 AAC
 *  10. 裁掉 intro 并补偿时间轴 -3504ms
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ListeningMaterial,
  MaterialSourceAdapter,
  MaterialSource,
  AudioProgress,
  Sentence,
  TedNextData,
  TedStreamMetadata,
  AudioInfo,
  parseWebVtt,
  extractNextDataJson,
  extractProjectMasterId,
  parseAudioRenditionUri,
  parseVariantSegments,
  mergeTranslation,
  applyOffset,
  clampSentencesToAudio,
  AUDIO_CACHE_VERSION,
} from '../core/types';
import { demuxTsToAac, quickValidateAac } from '../core/demux';
import { adtsToMp4, inspectMp4 } from '../core/mp4';
import { transcodeToMp3, isValidMp3 } from '../core/transcode';
import { httpGetBuffer, httpGetText, mapLimit } from '../core/http';

/**
 * TED 片头偏移常量
 *
 * 实测：__NEXT_DATA__ 的 cue.time 比 VTT 时间轴恒定少 3504ms，
 * 差值等于 intro 分片时长 3.527s。
 * 裁掉 intro 后，所有句子时间需减去 3504ms。
 */
export const TED_INTRO_OFFSET_MS = 3504;

export interface TedAdapterOptions {
  quality: 'low' | 'medium' | 'high';
  concurrency: number;
  skipIntro: boolean;
  /** 是否拉取中文字幕做对照 */
  withTranslation: boolean;
  /** 代理地址，空则用默认 */
  proxy?: string;
  log?: (msg: string) => void;
}

export class TedSource implements MaterialSourceAdapter {
  readonly source: MaterialSource = 'ted';

  constructor(private opts: TedAdapterOptions) {}

  canHandle(input: string): boolean {
    return /^https?:\/\/(www\.)?ted\.com\/talks\//i.test(input.trim());
  }

  private log(msg: string): void {
    this.opts.log?.(`[TED] ${msg}`);
  }

  /**
   * 从任意 TED talk URL 解析出 slug
   * 支持：https://www.ted.com/talks/bill_gates_the_next_outbreak_we_re_not_ready
   *      以及带 ?language= 等 query 的形式
   */
  private extractSlug(input: string): string {
    const m = input.trim().match(/\/talks\/([a-z0-9_\-]+)/i);
    if (!m) throw new Error(`无法从链接中解析出 talk slug：${input}`);
    return m[1];
  }

  async fetchMetadata(input: string, cacheDir: string): Promise<ListeningMaterial> {
    const slug = this.extractSlug(input);
    const pageUrl = `https://www.ted.com/talks/${slug}`;

    this.log(`拉取页面 ${pageUrl}`);
    const html = await httpGetText(pageUrl, { proxy: this.opts.proxy });

    const json = extractNextDataJson(html);
    if (!json) {
      throw new Error(
        '解析失败：页面中找不到 __NEXT_DATA__。TED 可能改版了，请到仓库提 issue。'
      );
    }

    let data: TedNextData;
    try {
      data = JSON.parse(json) as TedNextData;
    } catch (e) {
      throw new Error(`解析 __NEXT_DATA__ JSON 失败：${(e as Error).message}`);
    }

    const vd = data.props?.pageProps?.videoData;
    if (!vd) {
      throw new Error('解析失败：JSON 中缺少 videoData。TED 数据结构可能已变更。');
    }

    const pmId = extractProjectMasterId(vd.hlsUrl ?? '');
    if (!pmId) {
      throw new Error(`解析失败：无法从 hlsUrl 提取 projectMasterId（${vd.hlsUrl}）`);
    }

    this.log(`talkId=${vd.id} projectMasterId=${pmId} 标题="${vd.title}"`);

    // metadata.json —— 字幕总索引
    const introMasterId = this.extractIntroMasterId(vd.hlsUrl);
    const metaUrl = this.buildMetadataUrl(pmId, introMasterId);
    this.log('拉取字幕索引 metadata.json');
    const meta = await httpGetText(metaUrl, { proxy: this.opts.proxy });

    let metaJson: TedStreamMetadata;
    try {
      metaJson = JSON.parse(meta) as TedStreamMetadata;
    } catch (e) {
      throw new Error(`解析 metadata.json 失败：${(e as Error).message}`);
    }

    const availableLanguages = metaJson.subtitles.map((s) => s.code);
    this.log(`可用字幕语言 ${availableLanguages.length} 种`);

    const enEntry =
      metaJson.subtitles.find((s) => s.code === 'en') ??
      metaJson.subtitles.find((s) => s.code.startsWith('en'));
    if (!enEntry) {
      throw new Error('该 talk 没有英文字幕，无法用于精听练习。');
    }

    this.log('拉取英文字幕');
    const enVtt = await httpGetText(enEntry.webvtt, { proxy: this.opts.proxy });
    let sentences: Sentence[] = parseWebVtt(enVtt);
    if (sentences.length === 0) {
      throw new Error('英文字幕解析后为空，VTT 格式可能已变更。');
    }
    this.log(`解析出 ${sentences.length} 句`);

    // 可选译文
    if (this.opts.withTranslation) {
      const zhEntry = metaJson.subtitles.find((s) => s.code === 'zh-cn');
      if (zhEntry) {
        try {
          this.log('拉取中文字幕做对照');
          const zhVtt = await httpGetText(zhEntry.webvtt, { proxy: this.opts.proxy });
          const zhSentences = parseWebVtt(zhVtt);
          if (zhSentences.length > 0) {
            sentences = mergeTranslation(sentences, zhSentences);
            this.log('译文合并完成');
          }
        } catch (e) {
          this.log(`中文字幕拉取失败，跳过对照：${(e as Error).message}`);
        }
      }
    }

    // 时间轴补偿：裁掉 intro
    const startOffsetMs = this.opts.skipIntro ? -TED_INTRO_OFFSET_MS : 0;
    if (this.opts.skipIntro) {
      sentences = applyOffset(sentences, startOffsetMs);
      this.log(`时间轴补偿 ${startOffsetMs}ms（已裁掉片头）`);
    }

    const materialDir = path.join(cacheDir, `ted-${vd.id}`);
    fs.mkdirSync(materialDir, { recursive: true });

    const material: ListeningMaterial = {
      id: `ted:${vd.id}`,
      source: 'ted',
      sourceId: String(vd.id),
      sourceUrl: vd.canonicalUrl ?? pageUrl,
      title: vd.title ?? slug,
      presenter: vd.presenterDisplayName,
      description: vd.description,
      coverUrl: vd.primaryImageSet?.[0]?.url,
      language: 'en',
      availableLanguages,
      license: 'cc', // TED Talks 采用 CC BY-NC-ND 授权
      sentences,
      status: 'remote',
      cacheDir: materialDir,
      fetchedAt: Date.now(),
    };

    // 落盘元数据（音频未下载也可恢复）
    fs.writeFileSync(
      path.join(materialDir, 'material.json'),
      JSON.stringify({ ...material, pmId, introMasterId }, null, 2),
      'utf8'
    );

    this.log(`素材就绪：${sentences.length} 句，音频未下载`);
    return material;
  }

  async fetchAudio(
    material: ListeningMaterial,
    onProgress?: (p: AudioProgress) => void
  ): Promise<ListeningMaterial> {
    const cacheDir = material.cacheDir;
    const metaPath = path.join(cacheDir, 'material.json');
    const aacPath = path.join(cacheDir, 'audio.aac'); // 下载后的裸 ADTS（中间产物）
    const mp4Path = path.join(cacheDir, 'audio.m4a'); // 转码中间产物
    const mp3Path = path.join(cacheDir, 'audio.mp3'); // 最终产物
    const infoPath = path.join(cacheDir, 'audio.json');

    // 已有缓存 —— 必须先校验再复用
    //
    // ⚠️ 早期实现只要文件存在就直接复用，导致修复后仍长期使用坏文件，
    //    表现为「代码明明改了但播放依旧失败」。三道闸门：
    //      1. cacheVersion 必须匹配（下载 / 封装 / 转码逻辑变更时递增）
    //      2. 最终产物必须是 v5 约定的 MP3
    //      3. 文件本身要能通过基本校验
    if (fs.existsSync(mp3Path) && fs.existsSync(infoPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as AudioInfo;
        if (info.cacheVersion !== AUDIO_CACHE_VERSION) {
          this.log(
            `缓存版本过期（${info.cacheVersion ?? '无'} → ${AUDIO_CACHE_VERSION}），重新下载并转码`
          );
        } else if (info.format !== 'mp3') {
          // v5 起最终产物必须是 MP3 —— VS Code 没有 AAC 解码器
          this.log(`缓存格式不是 MP3（${info.format}），重新转码`);
        } else if (isValidMp3(fs.readFileSync(mp3Path))) {
          // ★ audio.json 里的 path 是写入时的绝对路径。素材目录被整体迁移过
          //   （materialsDir 变更会自动搬运）就指向旧位置，复用时会把这个坏路径
          //   一路带到 webview 的 audioUri 上 → 播放静默失败。
          //   这里一律按当前目录修正，并写回磁盘（自愈，免得下游再踩一次）。
          if (info.path !== mp3Path) {
            this.log(`修正 audio.json 里的音频路径：${info.path} → ${mp3Path}`);
            info.path = mp3Path;
            try {
              fs.writeFileSync(infoPath, JSON.stringify(info, null, 2), 'utf8');
            } catch {
              /* 写回失败不影响本次复用 */
            }
          }
          this.log(`复用缓存音频：${(info.bytes / 1024 / 1024).toFixed(2)}MB (MP3)`);
          // ⚠️ 命中缓存这条路径也必须钳制时间轴！
          //    这里拿到的 material.sentences 是刚抓下来的 VTT（未钳制），
          //    直接返回就绕过了函数末尾的 clampSentencesToAudio。
          //    实测（2026-09-19）：末句 end=499868ms 而音频只有 499670ms，
          //    超界 198ms —— UI 会 seek 到不存在的区间（第 7 节那个坑的变体）。
          //    判据单一来源：钳制只在这一层做，调用方一律读返回值的 .sentences。
          const clamped = clampSentencesToAudio(material.sentences, info.durationMs);
          return { ...material, sentences: clamped, audio: info, status: 'ready' };
        } else {
          this.log('缓存 MP3 校验失败，重新转码');
        }
      } catch (e) {
        this.log(`缓存读取失败（${(e as Error).message}），重新解封装`);
      }

      // 走到这里说明缓存不可用，清掉避免下次又读到
      for (const p of [aacPath, mp4Path, mp3Path, infoPath]) {
        try {
          fs.rmSync(p, { force: true });
        } catch {
          /* 删除失败不阻塞重建 */
        }
      }
    }

    if (!fs.existsSync(metaPath)) {
      throw new Error('内部错误：material.json 不存在，请先调用 fetchMetadata');
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ListeningMaterial & {
      pmId: string;
      introMasterId: string | null;
    };

    const { pmId, introMasterId } = meta;

    // master m3u8
    const masterUrl = `https://hls.ted.com/project_masters/${pmId}/manifest.m3u8?intro_master_id=${
      introMasterId ?? ''
    }&preview`;
    this.log('拉取 master m3u8');
    const master = await httpGetText(masterUrl, { proxy: this.opts.proxy });

    const variantUri = parseAudioRenditionUri(master, this.opts.quality);
    if (!variantUri) {
      throw new Error('解析失败：master m3u8 中找不到 audio-only 轨道。TED 可能变更了流结构。');
    }
    this.log(`音频轨道：${variantUri}`);

    const variantUrl = new URL(variantUri, masterUrl).toString();
    const variant = await httpGetText(variantUrl, { proxy: this.opts.proxy });

    let segments = parseVariantSegments(variant, introMasterId);
    if (segments.length === 0) {
      throw new Error('解析失败：音频分片列表为空');
    }

    const introCount = segments.filter((s) => s.isIntro).length;
    if (this.opts.skipIntro && introCount > 0) {
      this.log(`丢弃 ${introCount} 个片头分片`);
      segments = segments.filter((s) => !s.isIntro);
    }

    this.log(`开始下载 ${segments.length} 个分片（并发 ${this.opts.concurrency}）`);

    let done = 0;
    const buffers = await mapLimit(segments, this.opts.concurrency, async (seg) => {
      const buf = await httpGetBuffer(seg.url, { proxy: this.opts.proxy });
      done++;
      onProgress?.({
        stage: 'download',
        done,
        total: segments.length,
        ratio: done / segments.length,
        message: `下载音频 ${done}/${segments.length}`,
      });
      return buf;
    });

    this.log('解封装分片');
    const aacParts: Buffer[] = [];
    // 分片自报的采样率/声道，用于和最终封装结果交叉核对（不一致往往意味着
    // 某个分片解出了错位数据，而错位数据的帧参数可能与正常帧不同）
    let sampleRate = 44100;
    let channels = 2;
    let totalFrames = 0;

    // 解封装是同步计算（分片多时会有可感知的停顿），按约 10% 的粒度上报
    const demuxTick = Math.max(1, Math.ceil(buffers.length / 10));
    for (let i = 0; i < buffers.length; i++) {
      try {
        const r = demuxTsToAac(buffers[i]);
        aacParts.push(r.audio);
        sampleRate = r.frameInfo.sampleRate || sampleRate;
        channels = r.frameInfo.channels || channels;
        totalFrames += r.frameCount;
      } catch (e) {
        this.log(`分片 ${i} 解封装跳过：${(e as Error).message}`);
      }
      if (i % demuxTick === 0) {
        onProgress?.({
          stage: 'demux',
          done: i,
          total: buffers.length,
          ratio: i / buffers.length,
          message: `解封装音频 ${i + 1}/${buffers.length}`,
        });
      }
    }

    if (aacParts.length === 0) {
      throw new Error('所有分片解封装均失败，无法生成音频。');
    }

    const audio = Buffer.concat(aacParts);

    // 落盘前自检 —— 宁可报错也不要写出坏文件
    //
    // 坏文件在浏览器里是「静默失败」（MEDIA_ERR_SRC_NOT_SUPPORTED 或
    // DEMUXER_ERROR_COULD_NOT_OPEN），排查成本极高，不如在这里直接拦住。
    const validation = quickValidateAac(audio, { sampleProbeFrames: 256 });
    if (!validation.ok) {
      throw new Error(
        `音频完整性校验失败：${validation.reason}。` +
          `可能是 TED 流结构变化或分片下载不完整，请重试。`
      );
    }

    // ★ 关键一步：ADTS → MP4 → MP3
    //
    // 为什么要转码（实测结论，不是猜测）：
    //   VS Code 的裁剪版 ffmpeg.dll **没有 AAC 解码器**：
    //     avcodec_find_decoder(86018, 即 AV_CODEC_ID_AAC) → NULL
    //   它的音频解码器只有 12 个：pcm_* / mp3 / vorbis / flac。
    //   所以 AAC 音频无论封成 ADTS 还是 MP4，最终都报
    //     DEMUXER_ERROR_NO_SUPPORTED_STREAMS
    //   （容器开了、音轨也找到了，但没有解码器能处理它）。
    //   而 Chrome 能播，是因为它静态链接了完整 ffmpeg。
    //   → 必须换成宿主有解码器的格式：MP3（体积与源相当，且是裸流不需再封装）。
    //
    // 三步：1) 裸 ADTS 封进 MP4（libav 对 MP4 的解封装最可靠，复用已验过的 muxer）
    //       2) libav(WASM) 解 AAC → PCM
    //       3) lamejs 编 PCM → MP3
    //
    // 实测（8.1MB / 499.7s 的 TED 音频）：封装 30ms + 解码 0.76s + 编码 22.7s。
    const packed = adtsToMp4(audio, { log: (m) => this.log(m) });
    if (packed.frameCount !== totalFrames) {
      this.log(
        `⚠️ 帧数不一致：demux 计 ${totalFrames}，MP4 封装计 ${packed.frameCount}，以封装值为准`
      );
    }
    if (packed.sampleRate !== sampleRate || packed.channels !== channels) {
      this.log(
        `⚠️ 音频参数与分片自报不符：分片 ${sampleRate}Hz/${channels}ch，` +
          `封装 ${packed.sampleRate}Hz/${packed.channels}ch`
      );
    }

    this.log('开始 AAC → MP3 转码（首次较慢，之后走缓存）');
    // 转码是本流程最耗时的一段（实测编码 22.7s / 8MB）。
    // 若不单独上报阶段，UI 会一直停在「下载音频 N/N」——看起来就是卡死了。
    const reportTranscode = (ratio: number, label: string) => {
      onProgress?.({
        stage: 'transcode',
        done: 0,
        total: buffers.length,
        ratio,
        message: `转码 MP3 ${Math.round(ratio * 100)}% · ${label}`,
      });
    };
    reportTranscode(0, '准备中');
    const mp3 = await transcodeToMp3(packed.mp4, {
      bitrateKbps: 128,
      log: (m) => this.log(m),
      onProgress: reportTranscode,
    });
    if (mp3.frameCount !== packed.frameCount) {
      this.log(`⚠️ 转码前后帧数不一致：MP4 ${packed.frameCount}，MP3 ${mp3.frameCount}`);
    }

    fs.writeFileSync(mp3Path, mp3.mp3);
    // 中间产物不再保留：裸 ADTS 与 MP4 都无法被 VS Code 播放，留着只占空间且易混淆
    for (const p of [aacPath, mp4Path]) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* 旧文件删除失败不影响主流程 */
      }
    }

    const info: AudioInfo = {
      path: mp3Path,
      format: 'mp3',
      // ⚠️ 由帧数自算，不用播放器 duration（会漂移）
      durationMs: mp3.durationMs,
      sampleRate: mp3.sampleRate,
      channels: mp3.channels,
      frameCount: mp3.frameCount,
      bytes: mp3.mp3.length,
      startOffsetMs: this.opts.skipIntro ? -TED_INTRO_OFFSET_MS : 0,
      cacheVersion: AUDIO_CACHE_VERSION,
    };

    // 把句子时间轴钳制到音频实际范围内
    //
    // 为什么必须做：实测音频 495.93s，但 VTT 末两句标注到 499.87s（超出 3.9s）。
    // 根因是丢弃 intro 分片（3.527s）与 VTT 偏移常量（3.504ms）之间存在
    // 23ms 的系统误差，且片尾可能存在截断，误差累积到末尾。
    // 若不钳制，UI 会 seek 到不存在的区间，导致播放器行为异常。
    const clamped = clampSentencesToAudio(material.sentences, info.durationMs);
    const clampedCount = material.sentences.filter(
      (s, i) => s.endMs !== clamped[i].endMs || s.startMs !== clamped[i].startMs
    ).length;

    // 更新 material.json，保证恢复缓存时数据一致
    if (fs.existsSync(metaPath)) {
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      raw.sentences = clamped;
      fs.writeFileSync(metaPath, JSON.stringify(raw, null, 2), 'utf8');
    }

    fs.writeFileSync(infoPath, JSON.stringify(info, null, 2), 'utf8');

    this.log(
      `完成：${(info.bytes / 1024 / 1024).toFixed(2)}MB MP4 / ${info.frameCount} 帧 / ${(
        info.durationMs / 1000
      ).toFixed(1)}s` + (clampedCount > 0 ? ` / 钳制 ${clampedCount} 句` : '')
    );

    return { ...material, sentences: clamped, audio: info, status: 'ready' };
  }

  /** 从 hlsUrl 提取 intro_master_id */
  private extractIntroMasterId(hlsUrl: string): string | null {
    const m = hlsUrl.match(/intro_master_id=(\d+)/);
    return m ? m[1] : null;
  }

  private buildMetadataUrl(pmId: string, introMasterId: string | null): string {
    const q = introMasterId ? `?intro_master_id=${introMasterId}&preview` : '?preview';
    return `https://hls.ted.com/project_masters/${pmId}/metadata.json${q}`;
  }
}

/**
 * MP3 校验走 core/transcode.ts 的 isValidMp3()（与 panel.ts 共用同一判据）。
 *
 * 历史上这里曾有两份各自实现的 MP4 校验器，最终漂移成「坏缓存被判为合格」
 * 并长期复用。判据必须单一来源。
 */
