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
 * 关键点：
 *  1. Capacitor 的 shouldInterceptRequest 对远程(非本地)URL 返回 null，响应头不经过我们，
 *     必须【自己发起请求】拿到响应，剥离 CSP 后构造 WebResourceResponse 返回。
 *  2. 只拦截【HTML 文档】请求（iframe/主文档导航，Accept 含 text/html），
 *     不拦 JS/CSS/图片/API 子资源——避免 gzip 压缩字节被错误透传导致脚本挂掉。
 *  3. 自建请求【不发送 Accept-Encoding: gzip】，让服务器返回明文，
 *     避免返回 gzip 字节流而 WebView 不解压。
 *
 * 仅对央视频域名（www.yangshipin.cn / m.yangshipin.cn / 相关子域）做此拦截。
 */
public class LptvWebViewClient extends BridgeWebViewClient {

    public LptvWebViewClient(Bridge bridge) {
        super(bridge);
    }

    /** 央视频主站域名。 */
    private static boolean isYangshipinHost(String host) {
        if (host == null) {
            return false;
        }
        return host.equals("yangshipin.cn")
                || host.endsWith(".yangshipin.cn");
    }

    /** 仅拦截 HTML 文档（iframe/主文档导航），不拦 JS/CSS/图片/API。 */
    private static boolean isHtmlDocument(WebResourceRequest request) {
        Map<String, String> headers = request.getRequestHeaders();
        if (headers == null) {
            return false;
        }
        String accept = null;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase("accept")) {
                accept = e.getValue();
                break;
            }
        }
        // 文档导航 Accept 通常含 text/html；子资源(JS/CSS/图片/API)不含
        return accept != null && accept.toLowerCase().contains("text/html");
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        // 本地资源 / CapacitorHttp 代理交给 Capacitor 处理
        WebResourceResponse local = super.shouldInterceptRequest(view, request);
        if (local != null) {
            return local;
        }

        // 仅央视频 HTML 文档（iframe 导航）才拦截；其余(子资源/XHR)走系统默认
        if (!isYangshipinHost(request.getUrl().getHost()) || !isHtmlDocument(request)) {
            return null;
        }

        try {
            return fetchYangshipin(request);
        } catch (Exception e) {
            android.util.Log.w("LPTV", "fetch yangshipin failed: " + e.getMessage()
                    + " url=" + request.getUrl());
            return null; // 失败回退系统默认
        }
    }

    /** 用 HttpURLConnection 自己拉取央视频 HTML 文档，剥离 frame-ancestors CSP 后返回。 */
    private WebResourceResponse fetchYangshipin(WebResourceRequest request) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(request.getUrl().toString()).openConnection();
        try {
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setRequestMethod("GET");

            // 透传请求头（UA / Referer / Cookie 等），但不发 Accept-Encoding，
            // 让服务器返回明文，避免 gzip 字节被 WebView 误解析。
            Map<String, String> reqHeaders = request.getRequestHeaders();
            if (reqHeaders != null) {
                for (Map.Entry<String, String> e : reqHeaders.entrySet()) {
                    if (e.getKey() == null || e.getValue() == null) {
                        continue;
                    }
                    String k = e.getKey().toLowerCase();
                    if (k.equals("host") || k.equals("connection") || k.equals("content-length")
                            || k.equals("accept-encoding") || k.equals("accept-language")) {
                        continue;
                    }
                    conn.setRequestProperty(e.getKey(), e.getValue());
                }
            }

            int code = conn.getResponseCode();
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
            String encoding = null; // 服务器返回明文（未发 Accept-Encoding），不设 gzip
            if (mime != null && mime.contains(";")) {
                mime = mime.substring(0, mime.indexOf(';')).trim();
            }
            if (mime == null) {
                mime = "text/html";
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
