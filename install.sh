#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_CONFIG="$HOME/.cursor/mcp.json"
MEMORY_DIR="$HOME/.cursor/memory"
HOOKS_FILE="$HOME/.cursor/hooks.json"
GLOBAL_RULES_DIR="$HOME/.cursor/rules"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}[OK]${NC} $1"; }
warn() { echo -e "  ${YELLOW}[!]${NC} $1"; }
fail() { echo -e "  ${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo "======================================"
echo " Cursor Memory Server - 一键安装"
echo "======================================"

# --- 1. 检查 Bun ---
echo ""
echo "[1/6] 检查 Bun 环境..."
if ! command -v bun &>/dev/null; then
  warn "未检测到 Bun，正在安装..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    fail "Bun 安装失败，请手动安装: https://bun.sh"
  fi
fi
ok "Bun $(bun --version)"

# --- 2. 安装依赖 ---
echo ""
echo "[2/6] 安装项目依赖..."
cd "$SCRIPT_DIR"
bun install --silent 2>/dev/null || bun install
ok "依赖安装完成"

# --- 3. 验证服务器 ---
echo ""
echo "[3/6] 验证服务器启动..."
STARTUP_OUTPUT=$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | MEMORY_DIR=/tmp/.cursor-memory-test bun run src/index.ts 2>/dev/null | head -1)

if echo "$STARTUP_OUTPUT" | grep -q '"protocolVersion"'; then
  ok "服务器启动验证通过"
  rm -rf /tmp/.cursor-memory-test
else
  fail "服务器启动失败，请检查错误信息"
fi

# --- 4. 配置 MCP ---
echo ""
echo "[4/6] 配置 MCP Server..."
mkdir -p "$(dirname "$MCP_CONFIG")"

if [ -f "$MCP_CONFIG" ]; then
  if grep -q '"memory"' "$MCP_CONFIG"; then
    warn "MCP 配置中已存在 memory server，跳过"
  else
    bun -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$MCP_CONFIG', 'utf8'));
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers.memory = {
        command: 'bun',
        args: ['run', '$SCRIPT_DIR/src/index.ts'],
        env: { MEMORY_DIR: '$MEMORY_DIR' }
      };
      fs.writeFileSync('$MCP_CONFIG', JSON.stringify(cfg, null, 2) + '\n');
    "
    ok "已添加到现有 MCP 配置"
  fi
else
  cat > "$MCP_CONFIG" << MCPEOF
{
  "mcpServers": {
    "memory": {
      "command": "bun",
      "args": ["run", "$SCRIPT_DIR/src/index.ts"],
      "env": {
        "MEMORY_DIR": "$MEMORY_DIR"
      }
    }
  }
}
MCPEOF
  ok "已创建 MCP 配置"
fi

# --- 5. 安装全局 Cursor Rule ---
echo ""
echo "[5/6] 安装全局 Cursor Rule..."
mkdir -p "$GLOBAL_RULES_DIR"

if [ -f "$GLOBAL_RULES_DIR/memory-auto.md" ]; then
  cp "$SCRIPT_DIR/cursor-rule-template.md" "$GLOBAL_RULES_DIR/memory-auto.md"
  ok "Cursor Rule 已更新: $GLOBAL_RULES_DIR/memory-auto.md"
else
  cp "$SCRIPT_DIR/cursor-rule-template.md" "$GLOBAL_RULES_DIR/memory-auto.md"
  ok "Cursor Rule 已创建: $GLOBAL_RULES_DIR/memory-auto.md"
fi

# --- 6. 安装全局 Hooks ---
echo ""
echo "[6/6] 安装全局 Hooks..."

if [ -f "$HOOKS_FILE" ]; then
  if grep -q "session-start.ts" "$HOOKS_FILE"; then
    warn "Hooks 配置中已存在 memory hooks，跳过"
  else
    # Auto-merge memory hooks into existing hooks.json
    bun -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$HOOKS_FILE', 'utf8'));
      cfg.hooks = cfg.hooks || {};

      // Merge sessionStart hook
      cfg.hooks.sessionStart = cfg.hooks.sessionStart || [];
      cfg.hooks.sessionStart.push({
        command: 'bun run $SCRIPT_DIR/src/hooks/session-start.ts',
        timeout: 5
      });

      // Merge preToolUse hook (privacy guard)
      cfg.hooks.preToolUse = cfg.hooks.preToolUse || [];
      cfg.hooks.preToolUse.push({
        command: 'bun run $SCRIPT_DIR/src/hooks/pre-tool-use.ts',
        timeout: 3
      });

      // Merge postToolUse hook (save/delete/update notification)
      cfg.hooks.postToolUse = cfg.hooks.postToolUse || [];
      cfg.hooks.postToolUse.push({
        command: 'bun run $SCRIPT_DIR/src/hooks/post-tool-use.ts',
        timeout: 3
      });

      // Merge preCompact hook (save reminder before context compaction)
      cfg.hooks.preCompact = cfg.hooks.preCompact || [];
      cfg.hooks.preCompact.push({
        command: 'bun run $SCRIPT_DIR/src/hooks/pre-compact.ts',
        timeout: 3
      });

      // Merge stop hook
      cfg.hooks.stop = cfg.hooks.stop || [];
      cfg.hooks.stop.push({
        command: 'bun run $SCRIPT_DIR/src/hooks/stop.ts',
        timeout: 3,
        loop_limit: 1
      });

      fs.writeFileSync('$HOOKS_FILE', JSON.stringify(cfg, null, 2) + '\n');
    "
    ok "已合并到现有 Hooks 配置: $HOOKS_FILE"
  fi
else
  sed "s|/path/to/cursor-memory-server|$SCRIPT_DIR|g" \
    "$SCRIPT_DIR/hooks.json" > "$HOOKS_FILE"
  ok "Hooks 已安装: $HOOKS_FILE"
fi

echo ""
echo "======================================"
echo -e " ${GREEN}安装完成!${NC}"
echo "======================================"
echo ""
echo "  MCP 配置:   $MCP_CONFIG"
echo "  Cursor Rule: $GLOBAL_RULES_DIR/memory-auto.md"
echo "  Hooks:       $HOOKS_FILE"
echo "  数据存储:    $MEMORY_DIR"
echo ""
echo -e "  ${BOLD}重启 Cursor IDE 即可使用${NC}"
echo ""
