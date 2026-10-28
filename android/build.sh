#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# build.sh — 构建 LPTV Android APK (Capacitor + Gradle)
#
# 流程：
#   1. 复制 frontend/ + channels.json + logos/ → android/www/
#   2. npx cap init (仅首次) + npx cap sync android
#   3. gradle assembleRelease / assembleDebug → android/app/build/outputs/apk/
#
# 前置：
#   - JDK 17+  (JAVA_HOME)
#   - Android SDK (命令行工具或完整安装)
#   - ANDROID_HOME 指向 SDK 根目录
#
# 用法：
#   bash android/build.sh                  # debug APK
#   ANDROID_BUILD_TYPE=release bash android/build.sh  # release APK
# -----------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
WWW_DIR="$ANDROID_DIR/www"
BUILD_TYPE="${ANDROID_BUILD_TYPE:-debug}"

echo "==> [1/4] 准备 www/ (frontend + channels + logos + bridge)"
mkdir -p "$WWW_DIR"
cp "$ROOT/frontend/inject.js"  "$WWW_DIR/"
cp "$ROOT/frontend/splash.js"  "$WWW_DIR/"
cp "$ROOT/frontend/lptv.png"   "$WWW_DIR/"
cp "$ROOT/frontend/icon.png"   "$WWW_DIR/"
cp "$ROOT/electron/channels.json" "$WWW_DIR/"
if [ -d "$ROOT/logos" ]; then
  cp -r "$ROOT/logos" "$WWW_DIR/"
fi
echo "    www/: $(ls "$WWW_DIR" | tr '\n' ' ')"

echo "==> [2/4] Cap: init (首次) + sync android"
cd "$ANDROID_DIR"
if [ ! -d "android" ]; then
  echo "    首次初始化 Capacitor Android 工程..."
  npm install --silent 2>/dev/null || npm install
  npx cap init 
fi
npx cap sync android

echo "==> [3/4] Gradle: assemble ${BUILD_TYPE}"
cd android
# 首次需要下载 gradle wrapper
[ -x "./gradlew" ] || ./gradlew --version >/dev/null 2>&1 || true
./gradlew assemble"${BUILD_TYPE^}" \
  --no-daemon \
  --max-workers="$(nproc)" 2>&1 | tail -20

echo "==> [4/4] 产物"
APK=$(find . -path "*/outputs/apk/${BUILD_TYPE}/*.apk" -type f 2>/dev/null | head -1)
if [ -z "$APK" ]; then
  echo "错误：未找到 APK 产物" >&2
  exit 1
fi
echo "APK: $(realpath "$APK") ($(du -h "$APK" | cut -f1))"
echo "完成：$(realpath "$APK")"
