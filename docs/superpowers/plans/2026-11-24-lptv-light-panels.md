# LPTV 浅色主题频道/节目单面板液态玻璃化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 浅色主题（`data-theme=light`）下，左侧频道面板与右侧节目单面板由深色玻璃改为浅色液态玻璃（浅色半透明 + 深色文字 + 细边框），与首页卡片/设置弹窗一致；深色主题不受影响。

**Architecture:** 纯 CSS 变更，仅在 `android/www/inject.js` 的 `[data-theme=light]` 块内为左/右面板内部元素补一组覆盖。无 JS 逻辑改动。取值镜像首页卡片浅色令牌。

**Tech Stack:** 原生 CSS（无构建）；验证用 `node --check` + 手动 `bash run.sh`。

**Spec:** `docs/superpowers/specs/2026-11-24-lptv-light-panels-design.md`

## Global Constraints

- 唯一改动文件：`android/www/inject.js`，全部改动在 `[data-theme=light]` 选择器块内（现 `:1327-1336` 附近）。
- 不改 JS 逻辑、不改面板 DOM 结构、不改深色主题、不改动效。
- 颜色镜像首页卡片浅色：表面条目 `rgba(255,255,255,.85)`/hover `#fff`；文字主 `#1a2233`、次 `#5a6b8c`、弱 `#8a94ab`；强调 `#4d7cfe`/`#6aa8ff`；边框 `rgba(0,0,0,.12)`/分隔 `rgba(0,0,0,.08)`；台标底 `#f2f4f8`。
- 每步 `node --check android/www/inject.js` 必须通过。

## Review Focus

1. 深色主题回归：所有新规则限定在 `[data-theme=light]` 下，深色选择器零改动——Task 1 验证新选择器均带 `[data-theme=light]` 前缀。
2. 浅色下文字可读性：主/次/弱文字用深色系（`#1a2233`/`#5a6b8c`/`#8a94ab`），不用白色——Task 1 逐元素核对。
3. `.on` 激活态（右面板日期标签）与 `.cur`/`.now`（当前项）在浅色下仍突出——Task 1 覆盖 `.lv-right-tab.on`、`.lv-left-item.cur`、`.lv-right-item.now`。

---

### Task 1: 浅色主题下左/右面板内部元素覆盖

**Files:**
- Modify: `android/www/inject.js`（`[data-theme=light]` 块内，现 `:1327-1336` 附近）

**Interfaces:**
- Consumes: 现有 `[data-theme=light]` 覆盖块、左/右面板 CSS 类。
- Produces: 无（纯样式）。

- [ ] **Step 1: 补面板背景为浅色液态玻璃**

在 `#lptv-root[data-theme=light] #lptv-view-left .lv-left-panel, #lptv-root[data-theme=light] #lptv-view-right .lv-right-panel{...}` 中把 `background:var(--panel)` 改为 `background:rgba(255,255,255,.72)`（保留 `backdrop-filter`，投影改浅色 `rgba(30,45,80,.18)`）。

- [ ] **Step 2: 补左面板内部覆盖**

为以下选择器各加 `[data-theme=light]` 规则：`.lv-left-title`（`#1a2233`）、`.lv-left-tab`/`.lv-left-tab.on`（浅底/白卡+深字）、`.lv-left-item`/`.lv-left-item:hover`/`.lv-left-item.cur`（`rgba(255,255,255,.85)`/`#fff`/`#fff`+强调边框）、`.lv-left-num`（`#8a94ab`，cur `#4d7cfe`）、`.lv-left-logo`（`#f2f4f8`）、`.lv-left-name`（`#1a2233`）、`.lv-left-playing`（`#4d7cfe`）、`.lv-left-prog`（`#8a94ab`）、`.lv-left-foot`（`#8a94ab`）。

- [ ] **Step 3: 补右面板内部覆盖**

为以下选择器各加 `[data-theme=light]` 规则：`.lv-right-title`（`#1a2233`）、`.lv-right-ch`（`#5a6b8c`）、`.lv-right-tab`/`.lv-right-tab.on`（`rgba(0,0,0,.06)` 底/白卡 `#fff`+深字 `#1a2233`）、`.lv-right-item`/`.lv-right-item:hover`/`.lv-right-item.now`/`.lv-right-item.focus`（浅底/白卡/白卡+强调边框）、`.lv-right-time`（`#8a94ab`，now `#4d7cfe`）、`.lv-right-pt`（`#5a6b8c`，now `#1a2233`）、`.lv-right-prog .track`（`rgba(0,0,0,.14)`）、`.lv-right-prog .pct`（`#8a94ab`）、`.lv-right-status`（`#8a94ab`）、`.lv-right-badge`（`rgba(77,124,254,.14)` 底+`rgba(77,124,254,.5)` 边+`#1a2233`）、`.lv-right-book`/`.lv-right-book.on`（浅底/强调底）、`.lv-right-foot`/`.lv-right-foot .warn`（`#8a94ab`）。

- [ ] **Step 4: 语法门禁 + 提交**

```bash
node --check android/www/inject.js && git add android/www/inject.js && git commit -m "feat(lptv): 浅色主题——频道/节目单面板改浅色液态玻璃"
```

---

### Task 2: 全量验证

**Files:**
- Modify: 无（仅验证）

- [ ] **Step 1: 语法门禁**

```bash
node --check android/www/inject.js
```

- [ ] **Step 2: 手动验证（`bash run.sh`）**

浅色下频道/节目单面板为浅色玻璃、内部文字可读；`.on`/`.cur`/`.now` 状态仍突出；深色主题回归一致。
