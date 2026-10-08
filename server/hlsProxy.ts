import { Router, Request, Response } from 'express';
import { ygbrowser } from './playwright.js';
import { cookieHeader } from './cookies.js';

export const hlsRouter = Router();
export const streamRouter = Router();

/* ================= 流代理 (盒子主路径) =================
 *
 * /api/stream?pid=X          -> 用 Playwright 加载官方页取 playurl (官方 SDK 签名),
 *                               拉 m3u8 并改写为同源分片
 * /api/stream?u=<base64>&t=  -> 代理任意 URL (分片 ts/密钥 key/嵌套 m3u8)
 *     t 可选: ts | key | m3u8 (缺省时按响应 Content-Type 判断)
 * /api/stream?u=... 代理上游分片时带官方站 referer/cookie。
 *
 * 改写策略: 所有 m3u8 内 URI (KEY/MAP/MEDIA/STREAM-INF/EXTINF 分片/裸 URL 行)
 * 一律换成 /api/stream?u=<base64>, 让 hls.js 走同源, 规避 CORS。
 */

async function fetchUpstream(url: string): Promise<globalThis.Response> {
  return fetch(url, {
    headers: {
      ...cookieHeader(),
      Referer: 'https://www.yangshipin.cn/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    },
  });
}

streamRouter.get('/', async (req: Request, res: Response) => {
  const pid = req.query.pid as string;
  const u = req.query.u as string;
  const t = (req.query.t as string) || '';

  try {
    let target = '';
    if (u) {
      target = Buffer.from(u, 'base64').toString('utf-8');
    } else if (pid) {
      const playurl = await ygbrowser.getPlayUrl(pid);
      if (!playurl) {
        res.status(502).json({ error: 'Failed to resolve play URL' });
        return;
      }
      target = playurl;
    } else {
      res.status(400).json({ error: 'pid or u required' });
      return;
    }

    const upstream = await fetchUpstream(target);
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `upstream ${upstream.status}` });
      return;
    }
    const ctype = String(upstream.headers.get('content-type') || '');
    const bodyBuf = Buffer.from(await upstream.arrayBuffer());
    // 判断是否是 m3u8: content-type 或 body 前缀 (CDN 有时返回错误 content-type)
    const isM3u8 = ctype.includes('mpegurl') || ctype.includes('application/vnd.apple')
      || (t === 'm3u8') || bodyBuf.subarray(0, 7).toString('utf-8').startsWith('#EXTM3U');
    if (isM3u8) {
      const text = bodyBuf.toString('utf-8');
      const rewritten = rewriteManifest(text, target);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Access-Control-Allow-Origin', '*');
      res.send(rewritten);
      return;
    }

    // 非 m3u8: 原样透传二进制 (TS 分片/密钥)
    const buf = bodyBuf;
    if (t === 'key' || ctype.includes('octet-stream') || ctype.includes('binary')) {
      res.set('Content-Type', 'application/octet-stream');
    } else {
      res.set('Content-Type', ctype || 'video/mp2t');
    }
    res.set('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch (e) {
    console.error('[stream] failed:', e);
    res.status(502).json({ error: 'Stream proxy failed' });
  }
});

/* ================= Playwright 兜底 (原 /api/manifest + /api/seg, 保留兼容) ================= */

hlsRouter.get('/manifest', async (req: Request, res: Response) => {
  const pid = req.query.pid as string;
  if (!pid) {
    res.status(400).json({ error: 'pid required' });
    return;
  }

  try {
    const playUrl = await ygbrowser.getPlayUrl(pid);
    if (!playUrl) {
      res.status(502).json({ error: 'Failed to get play URL. Try refreshing cookies.' });
      return;
    }

    const m3u8Content = await ygbrowser.page.evaluate(async (url: string) => {
      const resp = await fetch(url);
      return await resp.text();
    }, playUrl);

    if (!m3u8Content) {
      res.status(502).json({ error: 'Failed to fetch manifest' });
      return;
    }

    const rewritten = rewriteManifest(m3u8Content, playUrl);

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(rewritten);
  } catch (e) {
    console.error('[HLS] Manifest rewrite failed:', e);
    res.status(500).json({ error: 'Manifest processing failed' });
  }
});

hlsRouter.get('/seg', async (req: Request, res: Response) => {
  const u = req.query.u as string;
  const type = req.query.type as 'ts' | 'key' | undefined;

  if (!u) {
    res.status(400).json({ error: 'u parameter required' });
    return;
  }

  try {
    const originalUrl = Buffer.from(u, 'base64').toString('utf-8');

    const buffer = await ygbrowser.page.evaluate(async (url: string) => {
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      return Array.from(new Uint8Array(buf));
    }, originalUrl);

    const data = Buffer.from(buffer);

    if (type === 'key') {
      res.set('Content-Type', 'application/octet-stream');
      res.set('Access-Control-Allow-Origin', '*');
      res.send(data);
      return;
    }

    res.set('Content-Type', 'video/mp2t');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(data);
  } catch (e) {
    console.error('[HLS] Segment proxy failed:', e);
    res.status(502).json({ error: 'Segment fetch failed' });
  }
});

/* ================= m3u8 改写 ================= */

function toStreamRef(url: string): string {
  return '/api/stream?u=' + encodeURIComponent(Buffer.from(url).toString('base64'));
}

function rewriteManifest(m3u8: string, originalUrl: string): string {
  const baseUrl = new URL(originalUrl);

  function abs(u: string): string {
    if (/^https?:/i.test(u)) return u;
    if (u.startsWith('//')) return baseUrl.protocol + u;
    if (u.startsWith('/')) return baseUrl.origin + u;
    return new URL(u, baseUrl).href;
  }

  const lines = m3u8.split(/\r?\n/);

  // 1) 标签内 URI="..." (KEY/MAP/MEDIA/I-FRAME-STREAM-INF 等)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#')) continue;
    lines[i] = line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
      return 'URI="' + toStreamRef(abs(uri)) + '"';
    });
  }

  // 2) 裸 URL 行 (变体/分片/嵌套播放列表) — 需知道上一行是不是 URI 型标签。
  //    规则: 非注释、非空、不以 '#' 开头的行 -> URL
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    out.push(toStreamRef(abs(trimmed)));
  }
  return out.join('\n');
}
