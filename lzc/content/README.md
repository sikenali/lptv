# LPTV catlink 远程包装（content/）

本目录是 LPTV 作为一个**懒猫远程应用（catlink）**所需的容器内文件。
整体结构对标 `cloud.lazycat.catlink.chrome.lpk`，复用其"会话骨架"，只替换 App。

## 文件说明

| 文件 | 作用 | 来源 |
|---|---|---|
| `manifest.yml` `package.yml` | 包清单（见 `lzc/`） | LPTV 自写 |
| `run.sh` | LPK 入口：准备 Xpra 配置/补丁，启动 xpra seamless | LPTV 模板（可改用 chrome 的 run.sh） |
| `launch_lptv.sh` | 首个浏览器连接后启动 LPTV AppImage | LPTV 自写 |
| `90_lzc.conf` | Xpra seamless 配置（start-child-after-connect=launch_lptv.sh） | LPTV 改编 |
| `appimage/LPTV.AppImage` | LPTV 本体（Electron 单包，自带 H.264） | 由 `build/build_electron.sh` 产出 |
| `cde-supervisor` `rim` `drop` `web/` `dummyscreen.sh` `patch/compress.py` | catlink 会话骨架（Xpra 渲染 / 输入 / 拖拽 / SPA） | **复用 chrome LPK**，经 `assemble_lpk.sh` 拷入 |

## 数据流（远程化路径）

```
盒子上的 LPTV (Electron) 加载央视频官方页 + 注入 inject.js
   ↓ 官方 video 渲染解密后的帧到 X11 窗口（Xdummy 虚拟显示）
Xpra seamless 抓这个窗口 → 视频编码(x264/libyuv) → WS :7890  (/catlink/)
rim (:8888) 负责会话/输入/剪贴板 (/rim/)
   ↓ 懒猫网关反代
用户浏览器打开 https://rlptv.<盒子名>/  →  catlink SPA 双 WS 客户端
   → 看到"LPTV 窗口"并可用鼠标/键盘控制换台、音量等
```

## 组装最终 LPK

```bash
# 先产出 AppImage（Electron）
bash ../../build/build_electron.sh

# 再组装（三选一，按优先级）
CHROME_LPK=/path/to/cloud.lazycat.catlink.chrome.lpk \
APP=/path/to/LPTV.AppImage \
bash assemble_lpk.sh                      # 复用 chrome LPK 的会话骨架（推荐）

LZC_SKELETON=/path/to/extracted/chrome/content bash assemble_lpk.sh  # 已有解包目录

bash assemble_lpk.sh                      # 都没有：按纯 LPTV 内容打包（见下）
# 产出 cloud.lazycat.catlink.lptv.lpk
```

LPK 外层结构：`manifest.yml` + `package.yml` + `icon.png` + `content.tar`
（content.tar 内含 `run.sh` / `launch_lptv.sh` / `90_lzc.conf` /
`appimage/LPTV.AppImage`，均带可执行位）。

**没有 chrome 骨架时**（第三种模式）只能产出结构合法的 LPK：容器会按 `run.sh`
起 Xpra 抓窗，但 `manifest.yml` 里的 `public_path` / `routes` 需要会话骨架提供
`content/web/`（catlink SPA）与 `rim` 二进制，二者缺失时浏览器端看不到画面。
这是 catlink 的平台侧组件，本机没有该 LPK，需在盒子上取
`cloud.lazycat.catlink.chrome.lpk` 后走前两种模式重打。

## 关键风险

- **Widevine/CDM**：Electron 官方构建自带 Widevine CDM（Chrome branding），
  央视频 H.264/MSE 直接能播，无需外部 CDM。若黑屏，先确认容器缺库
  （libgtk-3 / libnss3 / libasound2 / libatk-1.0 / libcups2 / libxss1 / libdrm2 / libgbm1）。
- **无 WM 最小化/最大化**：容器无窗口管理器时 `minimize/maximize` 可能不生效，
  已退回 `setBounds` 模拟；浮窗/置顶/全屏不依赖 WM。
- **会话启动方式**：若懒猫基础镜像的会话入口与 `run.sh` 直启 xpra 不一致，
  直接复制 chrome LPK 的 `run.sh` 再替换 launch / 90_lzc.conf 即可。
