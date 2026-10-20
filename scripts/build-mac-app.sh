#!/usr/bin/env bash
# build-mac-app.sh — 生成 dist/橦云数据库.app 并打包为 dist/tongyun-database-mac.zip
# 用法：bash scripts/build-mac-app.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="橦云数据库"
APP_DIR="$REPO_ROOT/dist/${APP_NAME}.app"
VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)" 2>/dev/null || echo "0.1.0")"
BUNDLE_ID="com.tongyun.database"

echo "==> 橦云数据库.app  v${VERSION}  build started"
echo "    repo: $REPO_ROOT"

# ---------- 清理 & 目录骨架 ----------
rm -rf "$APP_DIR"
mkdir -p \
  "$APP_DIR/Contents/MacOS" \
  "$APP_DIR/Contents/Resources/app/src" \
  "$APP_DIR/Contents/Resources/app/scripts" \
  "$APP_DIR/Contents/Resources/app/public"

# ---------- Info.plist ----------
cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleSignature</key>
  <string>????</string>
  <key>CFBundleExecutable</key>
  <string>tongyun-database</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSUIElement</key>
  <false/>
</dict>
</plist>
PLIST

# ---------- 复制应用源文件 ----------
cp -R "$REPO_ROOT/src/"      "$APP_DIR/Contents/Resources/app/src/"
cp -R "$REPO_ROOT/public/"   "$APP_DIR/Contents/Resources/app/public/"
cp    "$REPO_ROOT/package.json" "$APP_DIR/Contents/Resources/app/"
# 只复制生产依赖（跳过可选的 devDependencies）
if [ -d "$REPO_ROOT/node_modules" ]; then
  cp -R "$REPO_ROOT/node_modules" "$APP_DIR/Contents/Resources/app/"
fi

# scripts 中只保留必要脚本，不含 build 脚本自身
for f in benchmark.mjs benchmark-remote.mjs check.mjs fixture-config.mjs services.mjs; do
  [ -f "$REPO_ROOT/scripts/$f" ] && cp "$REPO_ROOT/scripts/$f" "$APP_DIR/Contents/Resources/app/scripts/" || true
done

# ---------- 启动脚本 ----------
cat > "$APP_DIR/Contents/MacOS/tongyun-database" <<'LAUNCHER'
#!/usr/bin/env bash
# 橦云数据库启动脚本
set -euo pipefail

APP_RESOURCES="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
DATA_DIR="${HOME}/Library/Application Support/tongyun-database"

# ---- 1. 查找 node ----
find_node() {
  # 1a. 系统 PATH
  if command -v node &>/dev/null; then
    echo "$(command -v node)"; return
  fi
  # 1b. Homebrew
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$p" ] && echo "$p" && return
  done
  # 1c. fnm multi-shell
  for p in "$HOME"/.local/state/fnm_multishells/*/bin/node; do
    [ -x "$p" ] && echo "$p" && return
  done
  # 1d. fnm 版本目录
  for p in "$HOME"/.fnm/node-versions/*/installation/bin/node; do
    [ -x "$p" ] && echo "$p" && return
  done
  # 1e. nvm
  for p in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$p" ] && echo "$p" && return
  done
  echo ""
}

NODE="$(find_node)"

if [ -z "$NODE" ]; then
  osascript <<'APPLESCRIPT'
display dialog "橦云数据库需要 Node.js 20 或更高版本。\n\n请访问 https://nodejs.org 安装 Node.js 后再次打开。" \
  with title "需要 Node.js" \
  buttons {"打开 nodejs.org", "取消"} \
  default button "打开 nodejs.org" \
  with icon caution
if button returned of result is "打开 nodejs.org" then
  open location "https://nodejs.org/zh-cn/download"
end if
APPLESCRIPT
  exit 1
fi

# ---- 2. 检查 Node 版本（需 ≥ 24） ----
NODE_MAJOR="$("$NODE" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$NODE_MAJOR" -lt 24 ] 2>/dev/null; then
  osascript <<APPLESCRIPT
display dialog "当前 Node.js 版本为 ${NODE_MAJOR}，橦云数据库需要 24 或更高版本。\n\n请升级后再试。" \
  with title "Node.js 版本过旧" \
  buttons {"打开 nodejs.org", "取消"} \
  default button "打开 nodejs.org" \
  with icon caution
if button returned of result is "打开 nodejs.org" then
  open location "https://nodejs.org/zh-cn/download"
end if
APPLESCRIPT
  exit 1
fi

# ---- 3. 准备数据目录 ----
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

ENDPOINT_FILE="$DATA_DIR/endpoint.json"

# ---- 4. 检查服务是否已在运行 ----
if [ -f "$ENDPOINT_FILE" ]; then
  EXISTING_URL="$(node -e "try{const d=JSON.parse(require('fs').readFileSync('${ENDPOINT_FILE}','utf8'));process.stdout.write(d.url||'')}catch{}" 2>/dev/null || true)"
  if [ -n "$EXISTING_URL" ]; then
    # 检查端口是否实际在监听
    PORT="${EXISTING_URL##*:}"
    PORT="${PORT%%/*}"
    if lsof -iTCP:"$PORT" -sTCP:LISTEN -t &>/dev/null 2>&1; then
      open "$EXISTING_URL"
      exit 0
    fi
  fi
fi

# ---- 5. 启动服务 ----
export TONGYUN_DATA_DIR="$DATA_DIR"

nohup "$NODE" "$APP_RESOURCES/src/server.mjs" \
  >> "$DATA_DIR/server.log" 2>&1 &
SERVER_PID=$!

# ---- 6. 等待服务就绪（最多 15 秒） ----
READY_URL=""
for i in $(seq 1 30); do
  sleep 0.5
  if [ -f "$ENDPOINT_FILE" ]; then
    READY_URL="$(node -e "try{const d=JSON.parse(require('fs').readFileSync('${ENDPOINT_FILE}','utf8'));process.stdout.write(d.url||'')}catch{}" 2>/dev/null || true)"
    if [ -n "$READY_URL" ]; then
      break
    fi
  fi
  # 如果服务挂了提前退出
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    osascript -e 'display dialog "橦云数据库启动失败，请查看 ~/Library/Application Support/tongyun-database/server.log。" with title "启动失败" buttons {"好"} default button "好" with icon stop' || true
    exit 1
  fi
done

if [ -z "$READY_URL" ]; then
  osascript -e 'display dialog "橦云数据库启动超时，请查看 ~/Library/Application Support/tongyun-database/server.log。" with title "启动超时" buttons {"好"} default button "好" with icon stop' || true
  exit 1
fi

open "$READY_URL"
LAUNCHER

chmod +x "$APP_DIR/Contents/MacOS/tongyun-database"

# ---------- 打包 zip ----------
mkdir -p "$REPO_ROOT/dist"
ZIP_PATH="$REPO_ROOT/dist/tongyun-database-mac.zip"
rm -f "$ZIP_PATH"
cd "$REPO_ROOT/dist"
ditto -c -k --sequesterRsrc --keepParent "${APP_NAME}.app" "tongyun-database-mac.zip"
cd "$REPO_ROOT"

echo "==> Build complete"
echo "    App:  $APP_DIR"
echo "    Zip:  $ZIP_PATH"
echo "    Size: $(du -sh "$ZIP_PATH" | cut -f1)"
