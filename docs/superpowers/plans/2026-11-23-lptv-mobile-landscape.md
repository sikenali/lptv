# LPTV 网页版移动端强制横屏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网页版播放器在真·触摸移动设备竖屏时引导强制横屏（与 APK 的 `screenOrientation=landscape` 一致），避免 UI 缩成 16:9 小条不可用。

**Architecture:** 在唯一源 `android/www/inject.js` 加 `applyRotatePrompt()`：用 `matchMedia("(hover: none) and (pointer: coarse)")` 判真·移动（**不用 `__lptvBridge`**，避免桌面竖窗误判），竖屏时 best-effort `screen.orientation.lock('landscape')`，不行则显示全屏“请横屏观看”覆盖层（z-index 2147483002，盖住 UI/视频），`orientationchange`/`resize` 随方向显隐；同步生成物 `lpk/content/web/web/inject.js`。

**Tech Stack:** 浏览器注入脚本（ES5，无构建）；无单测框架，用 `node --check` / `grep` / `cmp` 验证。

**Spec:** `docs/superpowers/specs/2026-11-23-lptv-mobile-landscape-design.md`

## Global Constraints

- `android/www/inject.js` 是唯一源；`lpk/content/web/web/inject.js` 由其生成（`lpk/build.sh`），改动后须同步（`cmp -s` 一致）。
- 触发条件用 `matchMedia("(hover: none) and (pointer: coarse)")`，**不用 `__lptvBridge`**。
- 覆盖层 z-index `2147483002`（高于底衬 2147483000、视频 2147483001），背景 `#04070d`。
- `screen.orientation.lock` 仅 best-effort，失败静默（`.catch(function(){})`）。
- 桌面（hover 存在）与智慧屏（非 coarse pointer）不出现引导层。
- 执行于当前分支 `main`；`android/www/inject.js` 产生真实提交。

## Review Focus

- **桌面竖窗不误判**：桌面浏览器（hover 存在）即使竖窗也不出引导层 → 用 `(hover:none) and (pointer:coarse)` 而非 `__lptvBridge`。
- **智慧屏不受影响**：智慧屏（`/catlink/` xpra 客户端，非 coarse touch）不出引导层。
- **横屏不遮挡**：横屏时覆盖层 `display:none`，播放/UI 不受影响。
- **锁屏失败兜底**：`screen.orientation.lock` 不可用/被拒时静默，靠覆盖层引导，无报错。
- **生成物一致**：`lpk/content/web/web/inject.js` 与 `android/www/inject.js` 字节一致（`cmp -s`）。

---

### Task 1: 移动端竖屏引导（applyRotatePrompt）

**Files:**
- Modify: `android/www/inject.js`（加 `applyRotatePrompt()` + boot 调用 + orientationchange 监听）
- Sync: `lpk/content/web/web/inject.js`（gitignored 生成物）

**Interfaces:**
- Consumes: 无（纯新增，不改现有 UI/缩放逻辑）。
- Produces: `applyRotatePrompt()` 在 `boot()` 后调用；移动端竖屏显示“请横屏观看”覆盖层。

- [ ] **Step 1: 写实现（GREEN 目标）**

在 `android/www/inject.js` 的 `applyDesignScale()`（约 L1915-1929）之后插入：

```js
/* 移动端竖屏引导：真·触摸设备（非 __lptvBridge，避免桌面竖窗误判）竖屏时
   先 best-effort 锁横屏（Capacitor/全屏可用；普通浏览器静默失败），不行则
   显示全屏“请横屏观看”覆盖层，避免 1920x1080 设计画布在竖屏缩成小条。 */
function applyRotatePrompt() {
  var isMobile = window.matchMedia &&
    window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  var prompt = document.getElementById("lptv-rotate-prompt");
  if (!isMobile) {
    if (prompt) prompt.style.display = "none";
    return;
  }
  var portrait = (window.innerHeight || 0) > (window.innerWidth || 0);
  if (portrait && window.screen && window.screen.orientation &&
      typeof window.screen.orientation.lock === "function") {
    try {
      var p = window.screen.orientation.lock("landscape");
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }
  if (!prompt) {
    prompt = document.createElement("div");
    prompt.id = "lptv-rotate-prompt";
    prompt.style.cssText = "position:fixed;inset:0;z-index:2147483002;background:#04070d;" +
      "color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "gap:14px;font-family:system-ui,-apple-system,sans-serif;text-align:center;";
    prompt.innerHTML =
      '<div style="font-size:42px;line-height:1">&#x1F504;</div>' +
      '<div style="font-size:20px;font-weight:600">请横屏观看</div>' +
      '<div style="font-size:14px;opacity:.7">请旋转设备，或点击全屏后自动横屏</div>';
    document.documentElement.appendChild(prompt);
  }
  prompt.style.display = portrait ? "flex" : "none";
}
```

- [ ] **Step 2: 在 boot() 调用 + 监听方向**

在 `boot()` 的 `applyDesignScale();` 之后加 `applyRotatePrompt();`；并在文件末尾 `window.addEventListener("orientationchange", applyRotatePrompt);` 与 `window.addEventListener("resize", applyRotatePrompt);`（紧跟现有 `window.addEventListener('resize', applyDesignScale)` 或 boot 附近）。

- [ ] **Step 3: 验证实现就位**

Run: `grep -c "applyRotatePrompt\|lptv-rotate-prompt\|请横屏观看\|orientation.lock" android/www/inject.js && node --check android/www/inject.js`
Expected: `>= 4` 且语法通过。

- [ ] **Step 4: 同步生成物**

Run: `cp android/www/inject.js lpk/content/web/web/inject.js && cmp -s android/www/inject.js lpk/content/web/web/inject.js && echo SYNC_OK`
Expected: `SYNC_OK`。

- [ ] **Step 5: 验证触发条件用 coarse 而非 __lptvBridge**

Run: `grep -n "hover: none) and (pointer: coarse)" android/www/inject.js && ! grep -n "applyRotatePrompt\|orientation.lock" android/www/inject.js | grep -q "__lptvBridge" && echo GATE_OK`
Expected: 命中 coarse 判定；引导逻辑未依赖 `__lptvBridge`。

- [ ] **Step 6: Commit**

```bash
git add android/www/inject.js
git commit -m "feat(lptv): 网页版移动端竖屏引导横屏（applyRotatePrompt）"
```
（注：`lpk/content/web/web/inject.js` 为 gitignored，不入 commit。）

- [ ] **Step 7: 真机验证清单（人工，盒子侧）**

- [ ] 手机竖屏进 `/web/web/` → 显示“请横屏观看”覆盖层。
- [ ] 手机横屏 → 覆盖层消失，播放/UI 正常。
- [ ] 桌面浏览器竖窗 → 不出现引导层。
- [ ] 智慧屏 → 不出现引导层。
- [ ] `lpk/content/web/web/inject.js` 与 `android/www/inject.js` 一致（`cmp -s`）。

---

## Self-Review

- **Spec coverage**：方案 1-5（触发条件/锁定/覆盖层/随方向显隐/仅移动端）→ Task 1 全部步骤；验证 1-4 → Step 3/4/5/7。无遗漏。
- **Step scan**：每步单一可检查动作；函数体（Step 1）为 spec 固定的小实现，非转录；其余为验证/提交。
- **Type consistency**：无新接口；`applyRotatePrompt` 仅内部使用，命名一致。
- **Review Focus**：5 条风险——桌面竖窗不误判→Step 5；智慧屏不受影响→Step 5/7；横屏不遮挡→Step 1/7；锁屏失败兜底→Step 1（catch）；生成物一致→Step 4。
- **Proportion**：计划约 90 行，spec 约 55 行，比例合理；唯一代码块为 spec 固定的引导函数。

## Execution Handoff

计划已保存：`docs/superpowers/plans/2026-11-23-lptv-mobile-landscape.md`。请审阅并选择执行方式（单任务、纯新增、唯一源 + 生成物同步，改动小）。
