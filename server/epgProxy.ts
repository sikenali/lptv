import { Router, Request, Response } from 'express';
import { ygbrowser, EpgProgram } from './playwright.js';
import { cookieHeader } from './cookies.js';
import { join } from 'path';

const CACHE_TTL_MS = 30 * 60 * 1000;
const EPG_DAY_MAX = 5;
const CAPI_BASE = 'https://capi.yangshipin.cn';

interface CacheEntry {
  data: EpgProgram[];
  expiry: number;
}

interface RawCacheEntry {
  data: Uint8Array;
  expiry: number;
}

export const epgRouter = Router();

const cache = new Map<string, CacheEntry>();
const rawCache = new Map<string, RawCacheEntry>();

epgRouter.get('/', async (req: Request, res: Response) => {
  const pid = req.query.pid as string;
  const ymd = req.query.ymd as string;
  if (!pid || !ymd) {
    res.status(400).json({ error: 'pid and ymd required' });
    return;
  }

  const programs = await fetchEpg(pid, ymd);
  res.json(programs);
});

epgRouter.get('/raw', async (req: Request, res: Response) => {
  const pid = req.query.pid as string;
  const ymd = req.query.ymd as string;
  if (!pid || !ymd) {
    res.status(400).json({ error: 'pid and ymd required' });
    return;
  }
  const key = `raw|${pid}|${ymd}`;
  const cached = rawCache.get(key);
  if (cached && cached.expiry > Date.now()) {
    res.set('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(cached.data));
    return;
  }
  try {
    const headers = cookieHeader();
    const r = await fetch(`${CAPI_BASE}/api/yspepg/program/${pid}/${ymd}`, { headers });
    if (r.status === 404 || r.status === 403) {
      rawCache.set(key, { data: new Uint8Array(0), expiry: Date.now() + CACHE_TTL_MS });
      res.status(404).send();
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    rawCache.set(key, { data: new Uint8Array(buf), expiry: Date.now() + CACHE_TTL_MS });
    res.set('Content-Type', 'application/octet-stream');
    res.send(buf);
  } catch (e) {
    console.error(`[epg/raw] failed pid=${pid} ymd=${ymd}:`, e);
    res.status(502).json({ error: 'Failed to fetch EPG' });
  }
});

epgRouter.get('/probe', async (req: Request, res: Response) => {
  const pid = req.query.pid as string;
  if (!pid) {
    res.status(400).json({ error: 'pid required' });
    return;
  }
  const days = await probeAvailableDays(pid);
  res.json(days);
});

async function fetchEpg(pid: string, ymd: string): Promise<EpgProgram[]> {
  const key = `${pid}|${ymd}`;
  const cached = cache.get(key);
  if (cached && cached.expiry > Date.now()) {
    return cached.data;
  }

  const data = await ygbrowser.getEpg(pid, ymd);
  if (data.length > 0) {
    cache.set(key, {
      data,
      expiry: Date.now() + CACHE_TTL_MS,
    });
  }
  return data;
}

async function probeAvailableDays(pid: string): Promise<number[]> {
  if (!/^\d+$/.test(pid)) return [0];
  const available: number[] = [];
  const today = new Date();

  const todayYmd = toYmd(today);
  const todayData = await fetchEpg(pid, todayYmd);
  if (todayData.length > 0) available.push(0);

  for (const dir of [1, -1] as const) {
    for (let off = dir; Math.abs(off) <= EPG_DAY_MAX; off += dir * 2) {
      const d = new Date(today);
      d.setDate(d.getDate() + off);
      const ymd = toYmd(d);
      const data = await fetchEpg(pid, ymd);
      if (data.length > 0) {
        available.push(off);
      }
    }
  }
  return available.sort((a, b) => a - b);
}

function toYmd(date: Date): string {
  return date.getFullYear() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0');
}

