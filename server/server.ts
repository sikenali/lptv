import express from 'express';
import cors from 'cors';
import { apiRouter } from './api.js';
import { ygbrowser } from './playwright.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3456', 10);

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  credentials: true,
}));

app.use(express.json());
app.use('/api', apiRouter);
app.use(express.static('./frontend'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', cookiesLoaded: ygbrowser.isLoggedIn() });
});

app.get('*', (req, res) => {
  res.sendFile('./frontend/index.html', { root: '.' });
});

async function main() {
  const cookiesLoaded = await ygbrowser.init();
  console.log(`[LPTV Web] Server starting on port ${PORT}`);
  console.log(`[LPTV Web] Cookies loaded: ${cookiesLoaded}`);
  if (!cookiesLoaded) {
    console.log('[LPTV Web] No cookies found. Run: node scripts/init-cookies.js');
  }

  app.listen(PORT, () => {
    console.log(`[LPTV Web] Ready: http://localhost:${PORT}`);
  });
}

process.on('SIGINT', async () => {
  console.log('[LPTV Web] Shutting down...');
  await ygbrowser.dispose();
  process.exit(0);
});

main().catch(console.error);
