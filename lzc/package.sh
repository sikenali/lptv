#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

LPK_TAG="${LPK_VERSION:-}"
LPK_TAG="${LPK_TAG#v}"
if [ -z "$LPK_TAG" ]; then
  LPK_TAG=$(git -C "$(dirname "$0")/.." describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)
fi
VERSION="${LPK_TAG:-1.0.1}"
LPK_NAME="cloud.lazycat.app.lptv-v${VERSION}.lpk"
echo "Packaging version: $VERSION"

CLI_BIN=$(npm root -g)/@lazycatcloud/lzc-cli/scripts/cli.js
if [ ! -f "$CLI_BIN" ]; then
  CLI_BIN=$(which lzc-cli 2>/dev/null || echo "")
fi
if [ -z "$CLI_BIN" ] || [ ! -f "$CLI_BIN" ]; then
  echo "Error: lzc-cli not found"
  exit 1
fi

# 在 lzc/ 目录内用 `.` 作为 context 运行 release
rm -f "$SCRIPT_DIR/$LPK_NAME"
(
  cd "$SCRIPT_DIR"
  node "$CLI_BIN" project release . --file lzc-build.yml
)

# 产物名: cloud.lazycat.app.lptv-v{VERSION}.lpk
BUILT="$SCRIPT_DIR/cloud.lazycat.app.lptv-v${VERSION}.lpk"
if [ -f "$BUILT" ]; then
  echo "Done: $BUILT"
else
  echo "Error: expected artifact not found: $BUILT"
  ls -l "$SCRIPT_DIR"/*.lpk 2>/dev/null || true
  exit 1
fi
