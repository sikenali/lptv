#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTENT_DIR="$SCRIPT_DIR/_lpk_content"

LPK_TAG="${LPK_VERSION:-}"
LPK_TAG="${LPK_TAG#v}"
VERSION="${LPK_TAG:-$(cd "$PROJECT_ROOT" && git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)}"
VERSION="${VERSION:-1.0.1}"
echo "Building version: $VERSION"

# 1) 编译 TypeScript server → dist/
echo "[build] Compiling server (tsc)..."
(cd "$PROJECT_ROOT" && rm -rf dist && npx tsc)

# 2) 组装 content 目录
echo "[build] Staging content..."
rm -rf "$CONTENT_DIR"
mkdir -p "$CONTENT_DIR/frontend"
mkdir -p "$CONTENT_DIR/server"
mkdir -p "$CONTENT_DIR/scripts"
mkdir -p "$CONTENT_DIR/node_modules"

# 前端静态资源
cp -a "$PROJECT_ROOT/frontend/." "$CONTENT_DIR/frontend/"
cp "$SCRIPT_DIR/icon.png" "$CONTENT_DIR/frontend/icon.png"

# 编译后的 server
cp -a "$PROJECT_ROOT/dist/." "$CONTENT_DIR/server/"

# 生产依赖 (express + cors + playwright, 跳过浏览器下载)
# 注意: 不把 devDependencies 打进去。
# 在临时 staging 目录运行 npm ci，避免 npm 在空目录内再嵌套一层 node_modules。
STAGE_DIR="$SCRIPT_DIR/.stage-npm"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp "$PROJECT_ROOT/package.json" "$PROJECT_ROOT/package-lock.json" "$STAGE_DIR/"
(
  cd "$STAGE_DIR"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts
)
cp -a "$STAGE_DIR/node_modules/." "$CONTENT_DIR/node_modules/"
rm -rf "$STAGE_DIR"

# 后端启动脚本
cat > "$CONTENT_DIR/scripts/start-backend.sh" << 'RUNNER'
#!/bin/sh
set -e
export NODE_PATH="/lzcapp/pkg/content/node_modules"
export PORT="${PORT:-8080}"
export DATA_DIR="${DATA_DIR:-/lzcapp/var/data}"
export NODE_ENV="${NODE_ENV:-production}"
exec node /lzcapp/pkg/content/server/server.js
RUNNER
chmod +x "$CONTENT_DIR/scripts/start-backend.sh"

echo "[build] Content staged at $CONTENT_DIR"
