/* Cookie 初始化脚本
 * 启动有头浏览器，引导用户登录 yangshipin.cn
 * 登录完成后自动保存 Cookie 到 data/cookies.json
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function main() {
  const cookiesFile = path.join(__dirname, '../data/cookies.json');
  console.log('[Init] Starting browser for yangshipin.cn login...');
  console.log('[Init] Please login manually, then close this browser window.');
  console.log('[Init] Cookie file:', cookiesFile);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://www.yangshipin.cn/tv/home');
  console.log('[Init] Opened yangshipin.cn, please login...');

  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});

  const state = await context.storageState();
  fs.mkdirSync(path.join(__dirname, '../data'), { recursive: true });
  fs.writeFileSync(cookiesFile, JSON.stringify(state, null, 2));
  console.log('[Init] Cookies saved to', cookiesFile);

  await browser.close();
}

main().catch(err => {
  console.error('[Init] Error:', err.message);
  process.exit(1);
});
