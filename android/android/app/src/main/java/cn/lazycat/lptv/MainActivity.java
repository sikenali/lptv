package cn.lazycat.lptv;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * LPTV Android 主 Activity。
 *
 * 原生 APK 为 Capacitor WebView 封装（央视频 iframe 模型），非 xpra/html5 客户端。
 * 适配项（对应需求：全屏 + 横屏 + 无画面定位）：
 *  - 横屏：由 AndroidManifest android:screenOrientation="landscape" 强制（apply_tv.sh 固化）。
 *  - 全屏：隐藏状态栏 + 沉浸式隐藏导航栏（本类 + styles.xml windowFullscreen）。
 *  - 无画面定位：开启 WebView 调试，便于用 chrome://inspect 查看央视频 iframe 的
 *    控制台/网络，确认黑屏根因（DRM/编解码/自动播放/被拒请求）。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // ---- 全屏：隐藏状态栏 + 导航栏（沉浸式，滑动可临时唤出） ----
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Android 11+：edge-to-edge + 隐藏系统栏
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController ctrl = getWindow().getInsetsController();
            if (ctrl != null) {
                ctrl.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                ctrl.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            // 旧版本：沉浸式 sticky 标志
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }

        // ---- 无画面定位：开启 WebView 调试（chrome://inspect 看央视频 iframe 控制台） ----
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }
}
