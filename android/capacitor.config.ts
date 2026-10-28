import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'cn.lazycat.lptv',
  appName: 'LPTV',
  // 加载本地 index.html (桥接页), 不直接指向央视频 —
  // 桥接页内部用 iframe 加载央视频, 再注入 inject.js UI 覆盖层
  webDir: 'www',
  android: {
    backgroundColor: '#04070d',
    allowMixedContent: true,
    // 启用 WebView 跨域访问 (允许 iframe 内页面加载 yangshipin.cn 的 JS)
    webViewLogLevel: 1,
    // 禁用缩放手势, 保持电视体验
    preferRelativeTargets: true,
  },
};

export default config;
