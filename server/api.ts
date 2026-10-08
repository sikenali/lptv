import { Router, Request, Response } from 'express';
import { getAllChannels, getByPid } from './channels.js';
import { ygbrowser } from './playwright.js';
import { StateManager } from './state.js';
import { epgRouter } from './epgProxy.js';
import { hlsRouter, streamRouter } from './hlsProxy.js';
import { cookieHeader } from './cookies.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = join(__dirname, '../frontend');
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '../data');
const SHOTS_DIR = join(DATA_DIR, 'shots');
const CAPI_BASE = 'https://capi.yangshipin.cn';

export const apiRouter = Router();

apiRouter.use('/epg', epgRouter);
apiRouter.use('/manifest', hlsRouter);
apiRouter.use('/seg', hlsRouter);
apiRouter.use('/stream', streamRouter);

apiRouter.get('/channels', (_req: Request, res: Response) => {
  res.json(getAllChannels());
});

apiRouter.get('/play', async (req: Request, res: Response) => {
  const pid = req.query.pid as string;
  if (!pid) {
    res.status(400).json({ error: 'pid required' });
    return;
  }
  const url = await ygbrowser.getPlayUrl(pid);
  if (!url) {
    res.status(502).json({ error: 'Failed to get play URL. Try refreshing cookies.' });
    return;
  }
  res.json({ url });
});

apiRouter.get('/state', async (_req: Request, res: Response) => {
  const state = await StateManager.load();
  res.json({ ok: true, ...state });
});

apiRouter.post('/state', async (req: Request, res: Response) => {
  const patch = req.body as Partial<any>;
  await StateManager.save(patch);
  res.json({ ok: true });
});

apiRouter.post('/shot', async (req: Request, res: Response) => {
  const { name, b64 } = req.body as { name: string; b64: string };
  if (!b64) {
    res.status(400).json({ error: 'b64 required' });
    return;
  }
  const fs = await import('fs');
  const path = await import('path');
  if (!fs.existsSync(SHOTS_DIR)) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
  }
  const filename = `${name}_${Date.now()}.png`;
  const filepath = path.join(SHOTS_DIR, filename);
  fs.writeFileSync(filepath, Buffer.from(b64, 'base64'));
  res.json({ ok: true, name: filename });
});

apiRouter.get('/live_info', async (req: Request, res: Response) => {
  const pid = req.query.pid as string;
  if (!pid) { res.status(400).json({ error: 'pid required' }); return; }
  // 官方 get_live_info 需 SDK 签名, 服务端无法伪造。用 Playwright 加载官方页面
  // 并在页面内 hook 捕获真实 playurl (官方页面自己生成签名)。
  try {
    const playurl = await ygbrowser.getPlayUrl(pid);
    if (!playurl) {
      res.status(502).json({ error: 'Failed to resolve play URL' });
      return;
    }
    res.json({ data: { iretcode: 0, playurl } });
  } catch (e) {
    console.error('[live_info proxy] failed:', e);
    res.status(502).json({ error: 'Failed to fetch live info' });
  }
});

apiRouter.get('/assets/:name', (req: Request, res: Response) => {
  const filepath = join(FRONTEND_DIR, req.params.name);
  if (!existsSync(filepath)) {
    res.status(404).json({ error: 'Asset not found' });
    return;
  }
  res.sendFile(filepath);
});

apiRouter.post('/cookies/refresh', async (_req: Request, res: Response) => {
  ygbrowser.dispose().then(() => {
    ygbrowser.init().then(ok => res.json({ ok }));
  });
});

apiRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', cookiesLoaded: ygbrowser.isLoggedIn() });
});
