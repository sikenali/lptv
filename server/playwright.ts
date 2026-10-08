import { chromium, Browser, BrowserContext, Page, BrowserContextOptions } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '../data');
const COOKIES_FILE = join(DATA_DIR, 'cookies.json');
const OFFICIAL_BASE = 'https://www.yangshipin.cn';
const API_BASE = 'https://capi.yangshipin.cn';

export interface EpgProgram {
  id: string;
  name: string;
  start: string;
  end: string;
  s0: number;
  e0: number;
  dur: number;
}

const HOOK_SCRIPT = `
(function() {
  if (window.__lptvHookInstalled) return;
  window.__lptvHookInstalled = true;
  window.__lptvPlayUrl = '';
  window.__lptvLastPid = '';

  var OrigHlsLoad = window.Hls && window.Hls.prototype && window.Hls.prototype.loadSource;
  if (OrigHlsLoad) {
    window.Hls.prototype.loadSource = function(url) {
      window.__lptvPlayUrl = url;
      window.__lptvLastPid = (new URL(url, location.href).searchParams.get('pid')) || '';
      return OrigHlsLoad.call(this, url);
    };
  }

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var self = this;
    if (String(url).indexOf('get_live_info') >= 0) {
      this.addEventListener('load', function() {
        try {
          var dd = JSON.parse(this.responseText).data;
          if (!dd) return;
          // 新版字段: backurl_list[0].url; 旧版: playurl
          var pu = (dd.backurl_list && dd.backurl_list[0] && dd.backurl_list[0].url) || dd.playurl || '';
          if (pu) window.__lptvPlayUrl = pu;
        } catch (e) {}
      });
    }
    return origOpen.apply(this, arguments);
  };

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      var url = String(arguments[0] || '');
      var p = origFetch.apply(this, arguments);
      if (url.indexOf('get_live_info') >= 0) {
        p.then(function (r) {
          return r.clone().json().then(function (d) {
            var dd = d && d.data;
            if (!dd) return;
            var pu = (dd.backurl_list && dd.backurl_list[0] && dd.backurl_list[0].url) || dd.playurl || '';
            if (pu) window.__lptvPlayUrl = pu;
          }).catch(function () {});
        });
      }
      return p;
    };
  }
})();
`;

class YangshipinBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private _page: Page | null = null;
  private cookiesLoaded = false;
  private currentPid = '';
  private cachedPlayUrl = '';
  private cachedPlayUrlPid = '';
  private cachedPlayUrlAt = 0;

  get page(): Page {
    if (!this._page) throw new Error('Browser not initialized. Call init() first.');
    return this._page;
  }

  async init() {
    if (this.browser) return true;

    try {
      let contextOptions: BrowserContextOptions = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      };
      // 有 cookies.json 则加载登录态 (无 cookie 也可匿名观看央视台)
      if (existsSync(COOKIES_FILE)) {
        try {
          const state = JSON.parse(readFileSync(COOKIES_FILE, 'utf-8'));
          contextOptions = { ...contextOptions, ...state };
        } catch (e) { console.warn('[Playwright] cookies parse failed, continue anonymous:', e); }
      }
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext(contextOptions);
      this._page = await this.context.newPage();
      // 注册 hook: 每次新 document 自动执行 (必须在任何 goto 之前)
      await this._page.addInitScript(HOOK_SCRIPT);
      this.cookiesLoaded = true;
      return true;
    } catch (e) {
      console.error('[Playwright] Failed to init browser:', e);
      this.cookiesLoaded = false;
      return false;
    }
  }

  isLoggedIn(): boolean {
    return this.cookiesLoaded && this._page !== null;
  }

  async getPlayUrl(pid: string): Promise<string | null> {
    // 短缓存: 同一 pid 60s 内复用 playurl, 避免 hls.js 反复触发 Playwright 导航
    const now = Date.now();
    if (this.cachedPlayUrl && this.cachedPlayUrlPid === pid && now - this.cachedPlayUrlAt < 60000) {
      return this.cachedPlayUrl;
    }

    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const got = await this.getPlayUrlOnce(pid);
      if (got) {
        this.cachedPlayUrl = got;
        this.cachedPlayUrlPid = pid;
        this.cachedPlayUrlAt = Date.now();
        return got;
      }
      // 重试: 重新导航 (页面加载有时序抖动, 可能不发 get_live_info 请求)
      if (attempt < MAX_ATTEMPTS - 1) {
        console.log(`[Playwright] getPlayUrl(${pid}) attempt ${attempt + 1} empty, retrying...`);
        await this._page?.goto('about:blank').catch(() => {});
        await new Promise(r => setTimeout(r, 800));
      }
    }
    return null;
  }

  private async getPlayUrlOnce(pid: string): Promise<string | null> {
    if (!this._page) await this.init();
    if (!this._page) return null;

    this.currentPid = pid;
    const url = `${OFFICIAL_BASE}/tv/home?pid=${pid}`;

    try {
      // 先清空, 轮询等待 hook 捕获 (比 waitForFunction 更抗页面加载竞态)
      await this._page.evaluate(() => { (window as any).__lptvPlayUrl = ''; }).catch(() => {});
      await this._page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      // ERR_ABORTED: 页面被拦截但仍可能已触发 hook, 继续轮询避免不必要的重试
      console.warn(`[Playwright] goto aborted for pid=${pid}, continuing to poll:`, String(e).slice(0, 120));
    }

    let playUrl = '';
    for (let i = 0; i < 20 && !playUrl; i++) {
      await new Promise(r => setTimeout(r, 1000));
      playUrl = await this._page.evaluate(() => (window as any).__lptvPlayUrl || '').catch(() => '');
    }
    if (playUrl) {
      console.log(`[Playwright] Captured playUrl for pid=${pid}: ${String(playUrl).slice(0, 80)}...`);
    }
    return playUrl || null;
  }

  async switchChannel(pid: string): Promise<boolean> {
    if (!this._page) return false;
    try {
      await this._page.waitForSelector('.tv-main-con-r-list-left', { timeout: 10000 }).catch(() => null);

      const clicked = await this._page.evaluate((p: string) => {
        const btn = document.querySelector(`.tv-main-con-r-list-left > div[data-pid="${p}"]`) as HTMLElement;
        if (btn) { btn.click(); return true; }
        return false;
      }, pid);

      if (!clicked) {
        console.warn(`[Playwright] switchChannel(${pid}): button not found`);
        return false;
      }

      this._page.evaluate(() => { (window as any).__lptvPlayUrl = ''; });
      const playUrl = await this._page.waitForFunction(
        () => (window as any).__lptvPlayUrl || '',
        { timeout: 4000 }
      ).catch(() => null);

      if (!playUrl) {
        console.warn(`[Playwright] switchChannel(${pid}): no playUrl in 4s, retrying`);
        const secondPid = await this._page.evaluate(() => (window as any).__lptvLastPid || '');
        if (secondPid && secondPid !== pid) {
          await this._page.evaluate((p: string) => {
            const btn = document.querySelector(`.tv-main-con-r-list-left > div[data-pid="${p}"]`) as HTMLElement;
            if (btn) btn.click();
          }, secondPid);
        }
      }

      this.currentPid = pid;
      return true;
    } catch (e) {
      console.error(`[Playwright] switchChannel(${pid}) failed:`, e);
      return false;
    }
  }

  async getEpg(pid: string, ymd: string): Promise<EpgProgram[]> {
    if (!this._page) await this.init();
    if (!this._page) return [];

    try {
      const buffer = await this._page.evaluate(async ({ pid, ymd }: { pid: string; ymd: string }) => {
        const resp = await fetch(`${API_BASE}/api/yspepg/program/${pid}/${ymd}`);
        if (resp.status === 404 || resp.status === 403) return null;
        return new Uint8Array(await resp.arrayBuffer());
      }, { pid, ymd });

      if (!buffer) return [];
      return parseEpg(Buffer.from(buffer));
    } catch (e) {
      console.error(`[Playwright] getEpg(${pid}, ${ymd}) failed:`, e);
      return [];
    }
  }

  async dispose() {
    await this._page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this._page = null;
    this.cookiesLoaded = false;
    this.cachedPlayUrl = '';
    this.cachedPlayUrlPid = '';
    this.cachedPlayUrlAt = 0;
  }
}

function parseEpg(buf: Buffer): EpgProgram[] {
  const programs: EpgProgram[] = [];
  try {
    const bytes = new Uint8Array(buf);
    let i = 0;
    function readVarint() {
      let v = 0, s = 0, k = 0;
      while (i < bytes.length && k < 5) {
        const b = bytes[i++];
        v += (b & 0x7f) * Math.pow(2, s);
        s += 7;
        k++;
        if (!(b & 0x80)) break;
      }
      return v;
    }
    while (i < bytes.length) {
      const tag = readVarint();
      if (tag === 0) break;
      const f = tag >>> 3, wt = tag & 7;
      if (wt === 2) {
        const len = readVarint();
        const p = parseEpgEntry(bytes, i, i + len);
        if (p) programs.push(p);
        i += len;
      } else if (wt === 0) {
        readVarint();
      } else {
        i += readVarint();
      }
      if (programs.length > 200) break;
    }
  } catch (e) {}
  return programs;
}

function parseEpgEntry(bytes: Uint8Array, a: number, b: number): EpgProgram | null {
  let i = a, p: Partial<EpgProgram> = {};
  function readVarint() {
    let v = 0, s = 0, k = 0;
    while (i < b && k < 5) {
      const x = bytes[i++];
      v += (x & 0x7f) * Math.pow(2, s);
      s += 7;
      k++;
      if (!(x & 0x80)) break;
    }
    return v;
  }
  try {
    while (i < b) {
      const tag = readVarint();
      if (tag === 0) break;
      const f = tag >>> 3, wt = tag & 7;
      if (wt === 2) {
        const len = readVarint();
        if (i + len > b) break;
        const str = Buffer.from(bytes.subarray(i, i + len)).toString('utf-8');
        if (f === 1) p.id = str;
        else if (f === 2) p.name = str;
        else if (f === 5) p.start = str;
        else if (f === 6) p.end = str;
        i += len;
      } else if (wt === 0) {
        const v = readVarint();
        if (f === 3) p.s0 = v;
        else if (f === 4) p.e0 = v;
        else if (f === 7) p.dur = v;
      } else {
        i += readVarint();
      }
    }
  } catch (e) {}
  return p.name ? p as EpgProgram : null;
}

export const ygbrowser = new YangshipinBrowser();
