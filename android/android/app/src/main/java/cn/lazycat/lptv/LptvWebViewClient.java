package cn.lazycat.lptv;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * LPTV 专用 WebViewClient。
 *
 * 背景：央视频页面返回 `Content-Security-Policy: frame-ancestors 'self'`，
 * 导致 APK 本地页用 <iframe> 嵌入央视频时被 Chromium 拒绝（net::ERR_BLOCKED_BY_RESPONSE），
 * 视频区黑屏。盒子 Electron 版用 loadURL 顶层导航天然绕过，但 APK 采用 iframe 模型
 * （保留 LPTV 自建 UI 覆盖层），故需拦截央视频响应、去掉 frame-ancestors 头。
 *
 * 关键：Capacitor 的 shouldInterceptRequest 对远程（非本地）URL 返回 null，
 * 即响应头不会经过我们——必须【自己发起请求】拿到响应，剥离 CSP 后构造
 * WebResourceResponse 返回，才能真正改写响应头。
 *
 * 仅对央视频域名（www.yangshipin.cn / m.yangshipin.cn / 相关子域）做此拦截，
 * 其余请求完全交给 Capacitor 默认处理（返回 null → 系统默认网络加载）。
 */
public class LptvWebViewClient extends BridgeWebViewClient {

    public LptvWebViewClient(Bridge bridge) {
        super(bridge);
    }

    /** 仅处理央视频主站的 CSP 头（iframe 被拒的根因）。 */
    private static boolean isYangshipinHost(String host) {
        if (host == null) {
            return false;
        }
        return host.equals("yangshipin.cn")
                || host.endsWith(".yangshipin.cn");
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        // 本地资源 / CapacitorHttp 代理交给 Capacitor 处理
        WebResourceResponse local = super.shouldInterceptRequest(view, request);
        if (local != null) {
            return local;
        }

        // 非央视频 URL：返回 null，走系统默认网络加载（不改写响应头）
        if (!isYangshipinHost(request.getUrl().getHost())) {
            return null;
        }

        // 央视频 URL：自己发起请求，剥离 frame-ancestors 后返回改写后的响应
        try {
            return fetchYangshipin(request);
        } catch (Exception e) {
            android.util.Log.w("LPTV", "fetch yangshipin failed: " + e.getMessage()
                    + " url=" + request.getUrl());
            return null; // 失败回退系统默认
        }
    }

    /** 用 HttpURLConnection 自己拉取央视频页面，剥离 frame-ancestors CSP 后返回。 */
    private WebResourceResponse fetchYangshipin(WebResourceRequest request) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(request.getUrl().toString()).openConnection();
        try {
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setRequestMethod("GET");
            // 透传请求头（含 UA / Referer / Cookie / Accept 等），保持与 WebView 一致
            Map<String, String> reqHeaders = request.getRequestHeaders();
            if (reqHeaders != null) {
                for (Map.Entry<String, String> e : reqHeaders.entrySet()) {
                    if (e.getKey() != null && e.getValue() != null) {
                        // 某些头不能手工设置（由 HttpURLConnection 管理）
                        String k = e.getKey().toLowerCase();
                        if (k.equals("host") || k.equals("connection") || k.equals("content-length")) {
                            continue;
                        }
                        conn.setRequestProperty(e.getKey(), e.getValue());
                    }
                }
            }

            int code = conn.getResponseCode();
            // 读取响应体（注意：错误流也要读，但 3xx/4xx 对 iframe 无意义，主要 200）
            InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            byte[] body = readAll(is);

            // 组装响应头：剥离 frame-ancestors 的 CSP
            Map<String, String> respHeaders = new LinkedHashMap<>();
            boolean stripped = false;
            for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                String key = e.getKey();
                if (key == null) {
                    continue;
                }
                String val = joinValues(e.getValue());
                if (key.equalsIgnoreCase("Content-Security-Policy") && val != null
                        && val.toLowerCase().contains("frame-ancestors")) {
                    String cleaned = removeFrameAncestors(val);
                    if (cleaned != null && !cleaned.isEmpty()) {
                        respHeaders.put(key, cleaned);
                    }
                    stripped = true;
                    continue;
                }
                respHeaders.put(key, val);
            }
            if (stripped) {
                android.util.Log.i("LPTV", "stripped frame-ancestors for "
                        + request.getUrl().getHost() + " code=" + code);
            }

            String mime = conn.getContentType();
            String encoding = conn.getContentEncoding();
            if (mime != null && mime.contains(";")) {
                mime = mime.substring(0, mime.indexOf(';')).trim();
            }
            if (mime == null) {
                mime = "text/html";
            }
            if (encoding == null) {
                encoding = "utf-8";
            }

            // WebResourceResponse 构造器 (API 21+)：含 statusCode/reasonPhrase/headers
            return new WebResourceResponse(mime, encoding, code,
                    conn.getResponseMessage(), respHeaders,
                    new ByteArrayInputStream(body));
        } finally {
            conn.disconnect();
        }
    }

    private static byte[] readAll(InputStream is) throws IOException {
        if (is == null) {
            return new byte[0];
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) {
            bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }

    private static String joinValues(List<String> vals) {
        if (vals == null || vals.isEmpty()) {
            return null;
        }
        StringBuilder sb = new StringBuilder();
        for (String v : vals) {
            if (v == null) {
                continue;
            }
            if (sb.length() > 0) {
                sb.append(", ");
            }
            sb.append(v);
        }
        return sb.toString();
    }

    /**
     * 从 CSP 值中移除 frame-ancestors 指令。
     * CSP 指令以分号分隔，形如 "frame-ancestors 'self'; other-directive ..."。
     */
    private static String removeFrameAncestors(String csp) {
        if (csp == null) {
            return null;
        }
        StringBuilder sb = new StringBuilder();
        boolean removed = false;
        for (String directive : csp.split(";")) {
            String trimmed = directive.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            if (!removed && trimmed.toLowerCase().startsWith("frame-ancestors")) {
                removed = true;
                continue; // 跳过 frame-ancestors
            }
            if (sb.length() > 0) {
                sb.append("; ");
            }
            sb.append(trimmed);
        }
        return sb.toString();
    }
}
