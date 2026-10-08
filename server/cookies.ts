import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '../data');
const COOKIES_FILE = join(DATA_DIR, 'cookies.json');

export function cookieHeader(): Record<string, string> {
  if (!existsSync(COOKIES_FILE)) return {};
  try {
    const state = JSON.parse(readFileSync(COOKIES_FILE, 'utf-8')) as { cookies?: Array<{ name: string; value: string; domain: string }> };
    const cookies = state.cookies || [];
    const header: Record<string, string> = {};
    for (const c of cookies) {
      if (c.domain && c.domain.includes('yangshipin')) {
        header[c.name] = c.value;
      }
    }
    return header;
  } catch { return {}; }
}
