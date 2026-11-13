#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# release.sh — 混合方案发布：本地构建 LPK+AppImage，CI 构建 exe/dmg/apk，
#              本地 gh release 合并推送。
#
# 背景：lzc-cde（LPK 打包骨架源头）是 Gitee 私有仓库，GitHub CI 拉不到；
#       本地无 wine / 非 macOS，无法构建 exe/dmg。故：
#         - 本地：构建 AppImage + LPK（lpk/rchrome + lzc-cli，CHROME_APPIMAGE=本地 AppImage）
#         - CI  ：构建 windows exe / macos dmg / android apk（不依赖 lzc-cde）
#         - 本地：gh release create（AppImage+LPK）+ gh run download 拉 CI 产物
#                + gh release upload（exe/dmg/apk）合并推送
#
# 用法：
#   bash release.sh                    # 用 electron/package.json 版本号
#   bash release.sh 1.0.1              # 指定版本
#   SKIP_CI=1 bash release.sh          # 不触发 CI（仅本地产物，需已有 CI 产物在 release-tmp/）
#   SKIP_CI=1 SKIP_DL=1 bash release.sh  # 本地产物 + 已下载好 release-tmp/（跳过 CI 拉取）
#
# 前置：
#   - gh 已认证（gh auth status，仓库为 github.com/sikenali/lptv）
#   - go / pnpm / node 已装（lpk 构建 rim + vite ui）
#   - electron 依赖已装（SKIP_INSTALL=1 可复用，见 build/build_electron.sh）
#   - lzc-cli 已装（npm install -g @lazycatcloud/lzc-cli）
# -----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# ---- 版本 ----
VERSION="${1:-$(node -p "require('./electron/package.json').version")}"
echo "==> 发布版本：v$VERSION"

# ---- 前置检查 ----
command -v gh >/dev/null || { echo "错误：未找到 gh CLI" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "错误：gh 未认证（gh auth login）" >&2; exit 1; }
command -v lzc-cli >/dev/null || { echo "错误：未找到 lzc-cli（npm install -g @lazycatcloud/lzc-cli）" >&2; exit 1; }
command -v go >/dev/null || { echo "错误：未找到 go（lpk 构建 rim 需要）" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "错误：未找到 pnpm（lpk 构建 ui 需要）" >&2; exit 1; }

REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo '')"
[ -n "$REPO" ] || { echo "错误：无法确定当前 git 仓库（需在 lptv 仓库内）" >&2; exit 1; }
echo "==> 仓库：$REPO"

# 同步版本号到 lzc/package.yml → lpk/rchrome/package.yml、electron/package.json
# （lpk 的 package.yml 是 lzc-cde 拷贝来的，需与 electron 版本一致）
node tools/set_version.js "$VERSION"

# =============================================================================
# 1) 本地构建 AppImage
# =============================================================================
echo ""
echo "=============================================================="
echo "==> [1/5] 构建 AppImage（electron-builder --linux AppImage）"
echo "=============================================================="
cd electron
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  npm install --silent
fi
npm run dist
cd ..
APPIMAGE="$(ls -t electron/dist/LPTV-linux-*.AppImage 2>/dev/null | head -1)"
[ -n "$APPIMAGE" ] || { echo "错误：AppImage 未生成（electron/dist/LPTV-linux-*.AppImage）" >&2; exit 1; }
echo "AppImage: $APPIMAGE ($(du -h "$APPIMAGE" | cut -f1))"

# =============================================================================
# 2) 本地构建 LPK（rchrome 脚本，CHROME_APPIMAGE=本地 AppImage）
# =============================================================================
echo ""
echo "=============================================================="
echo "==> [2/5] 构建 LPK（lpk/rchrome + lzc-cli project build）"
echo "=============================================================="
cd lpk/rchrome
CHROME_APPIMAGE="$HERE/$APPIMAGE" lzc-cli project build -f lzc-build.yml
LPK="$(ls -t cloud.lazycat.catlink.lptv-*.lpk 2>/dev/null | head -1)"
[ -n "$LPK" ] || { echo "错误：LPK 未生成（lpk/rchrome/cloud.lazycat.catlink.lptv-*.lpk）" >&2; exit 1; }
echo "LPK: $LPK ($(du -h "$LPK" | cut -f1))"
cd "$HERE"

# =============================================================================
# 3) 触发 CI 构建 windows exe / macos dmg / android apk（workflow_dispatch）
# =============================================================================
if [ "${SKIP_CI:-0}" != "1" ]; then
  echo ""
  echo "=============================================================="
  echo "==> [3/5] 触发 CI（gh workflow run build.yml -f version=$VERSION）"
  echo "=============================================================="
  gh workflow run build.yml -f version="$VERSION"
  echo "已触发，等待最新 run 出现..."
  RUN_ID=""
  for _ in $(seq 1 30); do
    RUN_ID="$(gh run list --workflow build.yml --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
    [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ] && break
    sleep 2
  done
  [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ] || { echo "错误：未找到 CI run" >&2; exit 1; }
  echo "CI run: $RUN_ID"
  echo "==> 等待 CI 完成（gh run watch）..."
  gh run watch "$RUN_ID" --exit-status --repo "$REPO"
  echo "CI 完成：$(gh run view "$RUN_ID" --repo "$REPO" --json conclusion --jq '.conclusion')"
else
  echo ""
  echo "==> [3/5] SKIP_CI=1，跳过触发 CI（需已有产物在 release-tmp/）"
  RUN_ID=""
fi

# =============================================================================
# 4) 下载 CI 产物（exe/dmg/apk）
# =============================================================================
echo ""
echo "=============================================================="
echo "==> [4/5] 下载 CI 产物（gh run download）"
echo "=============================================================="
if [ "${SKIP_DL:-0}" != "1" ]; then
  [ -n "$RUN_ID" ] || { echo "错误：无 RUN_ID，无法下载 CI 产物" >&2; exit 1; }
  rm -rf release-tmp && mkdir -p release-tmp
  for name in lptv-android lptv-windows lptv-macos; do
    echo "  下载 $name ..."
    gh run download "$RUN_ID" -n "$name" -D "release-tmp/$name" --repo "$REPO"
  done
else
  echo "  SKIP_DL=1，跳过下载（需已有产物在 release-tmp/）"
fi

# =============================================================================
# 5) 创建 GitHub Release + 上传全部产物
# =============================================================================
echo ""
echo "=============================================================="
echo "==> [5/5] gh release create + upload（合并本地 LPK/AppImage + CI exe/dmg/apk）"
echo "=============================================================="
TAG="v$VERSION"
# 本地产物
LOCAL_FILES=("$APPIMAGE" "lpk/rchrome/$LPK")
# CI 产物（若已下载/存在）
CI_FILES=()
for name in lptv-android lptv-windows lptv-macos; do
  if [ -d "release-tmp/$name" ]; then
    while IFS= read -r -d '' f; do CI_FILES+=("$f"); done < <(find "release-tmp/$name" -type f -print0)
  fi
done

if [ -z "$(gh release view "$TAG" --repo "$REPO" 2>/dev/null || true)" ]; then
  echo "  创建 release $TAG ..."
  gh release create "$TAG" "${LOCAL_FILES[@]}" \
    --repo "$REPO" --title "LPTV v$VERSION" --generate-notes
else
  echo "  release $TAG 已存在，仅上传新产物（gh release upload）"
fi

# 上传 CI 产物（若有）
if [ "${#CI_FILES[@]}" -gt 0 ]; then
  echo "  上传 CI 产物（${#CI_FILES[@]} 个）..."
  gh release upload "$TAG" "${CI_FILES[@]}" --repo "$REPO" --clobber
fi

echo ""
echo "=============================================================="
echo "完成！Release：$REPO/releases/tag/$TAG"
echo "  本地：AppImage=$APPIMAGE, LPK=$LPK"
echo "  CI  ：exe/dmg/apk 已合并上传"
echo "=============================================================="
