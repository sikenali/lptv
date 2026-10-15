#!/bin/bash
# 本地打包脚本：构建 contentdir → 生成 LPK → 重命名为版本化文件名（lzmail 式）
set -euo pipefail

LPK_TAG="${LPK_VERSION:-}"
LPK_TAG="${LPK_TAG#v}"
if [ -z "$LPK_TAG" ]; then
  LPK_TAG=$(git -C "$(dirname "$0")/.." describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || echo "1.0.1")
fi
export LPK_VERSION="$LPK_TAG"
echo "Packaging version: $LPK_VERSION"

# 1. 运行 build.sh（build.sh 读取 LPK_VERSION 环境变量）
bash "$(dirname "$0")/build.sh"

# 2. 调用 lzc-cli 生成 LPK
CLI_BIN="/usr/local/lib/node_modules/@lazycatcloud/lzc-cli/scripts/cli.js"
if [ ! -f "$CLI_BIN" ]; then
  CLI_BIN=$(which lzc-cli 2>/dev/null || echo "")
fi
if [ -z "$CLI_BIN" ]; then
  echo "Error: lzc-cli not found"
  exit 1
fi
rm -f "$(dirname "$0")/output.lpk"
(
  cd "$(dirname "$0")"
  node "$CLI_BIN" project release -o output.lpk --file lzc-build.yml
)

# 3. 重命名
LPK_NAME="cloud.lazycat.app.lptv-${LPK_VERSION}.lpk"
if [ -f "$(dirname "$0")/output.lpk" ]; then
  mv "$(dirname "$0")/output.lpk" "$(dirname "$0")/$LPK_NAME"
  echo "Done: $LPK_NAME"
else
  echo "Error: output.lpk not produced"
  exit 1
fi
