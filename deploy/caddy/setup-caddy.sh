#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# setup-caddy.sh — 在公网主机上安装并配置 Caddy，为 LPTV 远程访问加真证书。
#
# 用法：
#   sudo bash setup-caddy.sh                     # 交互填域名/上游, 安装+启动
#   DOMAIN=lptv.10012049.xyz UPSTREAM=https://rlptv.lzc/ \
#     sudo -E bash setup-caddy.sh                # 非交互
#   sudo bash setup-caddy.sh --dry-run           # 只打印将写入的 Caddyfile
#
# 需要：root、DNS A 记录已指向本机公网 IP、路由器 80/443 已映射到本机。
# -----------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${DOMAIN:-}"
UPSTREAM="${UPSTREAM:-}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

if [ "$DRY" != "1" ] && [ "$(id -u)" != "0" ]; then
  echo "错误：需要 root（sudo）" >&2; exit 1
fi

# ---- 交互填参 --------------------------------------------------------------
if [ -z "$DOMAIN" ]; then
  read -rp "对外域名（如 lptv.10012049.xyz）: " DOMAIN
fi
if [ -z "$UPSTREAM" ]; then
  read -rp "盒子端点（如 https://rlptv.lzc/ 或 https://rlptv.<盒名>/）: " UPSTREAM
fi
[ -z "$DOMAIN" ] && { echo "错误：域名为空" >&2; exit 1; }
[ -z "$UPSTREAM" ] && { echo "错误：上游为空" >&2; exit 1; }

# ---- 校验 DNS 指向本机 ------------------------------------------------------
if command -v dig >/dev/null 2>&1; then
  A_IP="$(dig +short A "$DOMAIN" | head -1 || true)"
  LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "==> DNS: $DOMAIN -> ${A_IP:-未解析}  本机: ${LOCAL_IP:-未知}"
  if [ -n "$A_IP" ] && [ -n "$LOCAL_IP" ] && [ "$A_IP" != "$LOCAL_IP" ]; then
    echo "  警告：A 记录($A_IP) ≠ 本机 IP($LOCAL_IP)，证书可能签给他人/失败"
  fi
else
  echo "==> 未安装 dig，跳过 DNS 校验"
fi

# ---- 生成 Caddyfile ----------------------------------------------------------
CFG="$(mktemp)"
cat > "$CFG" <<EOF
$DOMAIN {
	tls {
		# email you@example.com   # 建议填真实邮箱收续期告警
	}

	reverse_proxy $UPSTREAM {
		transport http {
			tls_insecure_skip_verify
		}
	}

	handle /lptv-health {
		respond "LPTV proxy OK" 200
	}

	log {
		output file /var/log/caddy/lptv.access.log {
			roll_size 10MiB
			roll_keep 5
		}
		format console
	}
	encode gzip
}
EOF

if [ "$DRY" = "1" ]; then
  echo "===== 将写入的 Caddyfile ====="; cat "$CFG"; rm -f "$CFG"; exit 0
fi

# ---- 安装 Caddy（Debian/Ubuntu 官方源）--------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> 安装 Caddy..."
  apt-get update -y
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
else
  echo "==> Caddy 已安装: $(caddy version | head -1)"
fi

# ---- 落盘 + 校验 + 启动 ------------------------------------------------------
mkdir -p /etc/caddy /var/log/caddy
install -m 644 "$CFG" /etc/caddy/Caddyfile
rm -f "$CFG"

echo "==> 校验配置..."
caddy validate --config /etc/caddy/Caddyfile
echo "==> 启动 caddy (systemd)..."
systemctl enable --now caddy 2>/dev/null || true
systemctl restart caddy

echo ""
echo "完成。首次申请证书约 10-30s，查看日志："
echo "  sudo journalctl -u caddy -f"
echo "浏览器打开：https://$DOMAIN/  →  地址栏应显示小锁（无证书警告）。"
