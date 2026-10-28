#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# build.sh — 构建 LPTV Android APK
#
# 产物命名：LPTV-{abi}-{version}.apk
#   abi 取值：all (默认全架构) / arm64-v8a / armeabi-v7a / x86_64
#
# 前置：
#   - JDK 17+ (JAVA_HOME)
#   - Android SDK (ANDROID_HOME)
#
# 用法：
#   bash android/build.sh                       # debug APK (all ABI)
#   ANDROID_BUILD_TYPE=release bash android/build.sh
#   ANDROID_ABI=arm64-v8a bash android/build.sh  # 指定 ABI
# -----------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
WWW_DIR="$ANDROID_DIR/www"
BUILD_TYPE="${ANDROID_BUILD_TYPE:-debug}"
ABI="${ANDROID_ABI:-all}"

VERSION="$(grep -m1 '^version:' "$ROOT/lzc/package.yml" | awk '{print $2}')"
[ -z "$VERSION" ] && VERSION="1.0.0"
echo "版本: $VERSION  ABI: $ABI  类型: $BUILD_TYPE"

echo "==> [1/4] 准备 www/"
mkdir -p "$WWW_DIR"
cp "$ROOT/frontend/inject.js"   "$WWW_DIR/"
cp "$ROOT/frontend/splash.js"   "$WWW_DIR/"
cp "$ROOT/frontend/lptv.png"    "$WWW_DIR/"
cp "$ROOT/frontend/icon.png"    "$WWW_DIR/"
cp "$ROOT/electron/channels.json" "$WWW_DIR/"
[ -d "$ROOT/logos" ] && cp -r "$ROOT/logos" "$WWW_DIR/"
echo "    $(ls "$WWW_DIR" | tr '\n' ' ')"

echo "==> [2/4] Capacitor sync"
cd "$ANDROID_DIR"
[ -d "android" ] || node_modules/.bin/capacitor init "LPTV" "cn.lazycat.lptv" --web-dir=www
node_modules/.bin/capacitor sync android

echo "==> [3/4] Gradle assemble"
cd android
[ -x "./gradlew" ] || ./gradlew --version >/dev/null 2>&1 || true
./gradlew assemble"${BUILD_TYPE^}" --no-daemon --max-workers="$(nproc)" 2>&1 | tail -5

echo "==> [4/4] 产物"
APK=$(find . -path "*/outputs/apk/${BUILD_TYPE}/LPTV-*.apk" -type f 2>/dev/null | head -1)
if [ -z "$APK" ]; then
  APK=$(find . -path "*/outputs/apk/${BUILD_TYPE}/*.apk" -type f 2>/dev/null | head -1)
fi
if [ -z "$APK" ]; then
  echo "错误：未找到 APK" >&2; exit 1
fi
DEST="$ANDROID_DIR/LPTV-${ABI}-${VERSION}-$(echo $BUILD_TYPE).apk"
cp "$APK" "$DEST"
chmod +x "$DEST"
echo "APK: $DEST ($(du -h "$DEST" | cut -f1))"
echo "完成：$DEST"
