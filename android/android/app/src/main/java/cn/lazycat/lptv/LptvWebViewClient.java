package cn.lazycat.lptv;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.util.HashMap;
import java.util.Map;

/**
 * LPTV 专用 WebViewClient。
 *
 * 背景：央视频页面返回 `Content-Security-Policy: frame-ancestors 'self'`，
 * 导致 APK 本地页用 <iframe> 嵌入央视频时被 Chromium 拒绝（net::ERR_BLOCKED_BY_RESPONSE），
 * 视频区黑屏。盒子 Electron 版用 loadURL 顶层导航天然绕过，但 APK 采用 iframe 模型
 * （保留 LPTV 自建 UI 覆盖层），故需在此拦截央视频响应、去掉 frame-ancestors 头。
 *
 * 仅对央视频域名（www.yangshipin.cn / m.yangshipin.cn / 相关子域）去除该 CSP 头，
 * 其余请求完全交给 Capacitor 默认处理，不影响本地页与其它资源。
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
        // 先让 Capacitor 处理本地资源 / CapacitorHttp 代理
        WebResourceResponse response = super.shouldInterceptRequest(view, request);

        // 仅当是央视频页面响应（非本地、且返回了响应对象）时才处理 CSP
        if (response != null && isYangshipinHost(request.getUrl().getHost())) {
            try {
                Map<String, String> headers = response.getResponseHeaders();
                if (headers != null && !headers.isEmpty()) {
                    // 是否含 frame-ancestors（大小写不敏感匹配 key）
                    boolean hasFrameAncestors = false;
                    for (String key : headers.keySet()) {
                        if (key != null && key.equalsIgnoreCase("Content-Security-Policy")) {
                            String val = headers.get(key);
                            if (val != null && val.toLowerCase().contains("frame-ancestors")) {
                                hasFrameAncestors = true;
                                break;
                            }
                        }
                    }
                    if (hasFrameAncestors) {
                        // 复制一份避免修改原 Map，去掉 frame-ancestors 指令后重设响应头
                        Map<String, String> newHeaders = new HashMap<>(headers);
                        for (Map.Entry<String, String> entry : newHeaders.entrySet()) {
                            if (entry.getKey() != null
                                    && entry.getKey().equalsIgnoreCase("Content-Security-Policy")) {
                                String val = entry.getValue();
                                if (val != null && val.toLowerCase().contains("frame-ancestors")) {
                                    // 移除 frame-ancestors 指令（含分号），其余 CSP 保留
                                    String cleaned = removeFrameAncestors(val);
                                    entry.setValue(cleaned);
                                }
                            }
                        }
                        response.setResponseHeaders(newHeaders);
                        // 日志方便 chrome://inspect 确认
                        android.util.Log.i("LPTV", "removed frame-ancestors for "
                                + request.getUrl().getHost());
                    }
                }
            } catch (Exception e) {
                // 解析失败不阻断页面，让默认行为接管
                android.util.Log.w("LPTV", "CSP strip failed: " + e.getMessage());
            }
        }
        return response;
    }

    /**
     * 从 CSP 值中移除 frame-ancestors 指令。
     * CSP 指令以分号分隔，形如 "frame-ancestors 'self'; other-directive ..."。
     */
    private static String removeFrameAncestors(String csp) {
        if (csp == null) {
            return csp;
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
