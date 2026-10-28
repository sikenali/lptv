# 方案 2：公网受信任 HTTPS 入口（Caddy + Let's Encrypt）

让任何手机/平板/桌面浏览器的用户**零配置**访问 LPTV 远程界面，彻底解决「安卓手机浏览器拒绝盒子自签证书」。

## 拓扑

```
手机/平板/桌面浏览器
      │  https://lptv.10012049.xyz   （Let's Encrypt 真证书，浏览器天然信任）
      ▼
Caddy（盒子或任一台公网主机）
      │  内网反代（纯 HTTP/内联证书，安全）
      ▼
盒子平台  https://rlptv.<盒名>/  ──►  / = SPA
                                        /catlink/ = xpra(:7890)
                                        /rim/     = rim(:8888)
```

Caddy 只做一件事：**在盒子现有端点外包一层真证书**。内部所有路由（SPA / WS / rim）由盒子平台原样转发，Caddy 无需知道细节。

## 前置条件（缺一不可）

| 项 | 要求 |
|---|---|
| 域名 | `10012049.xyz`（已有） |
| DNS | `lptv.10012049.xyz` 的 **A 记录** → 盒子公网 IP |
| 端口映射 | 路由器把 **80 和 443** 转发到 Caddy 所在主机 |
| 可达性 | Caddy 主机能访问盒子的 `rlptv.<盒名>`（或改成盒子内网 IP/端口） |

> 用子域 `lptv.` 而非 `www.`，避免与同域名其他服务冲突、也方便以后加 `tv.`/`api.` 等。

## 步骤

### 1. DNS 解析
在你的域名 DNS 服务商（如 Cloudflare/阿里/腾讯）添加：
```
类型: A    主机记录: lptv    记录值: <盒子公网IP>    TTL: 600
```
验证：`ping lptv.10012049.xyz` 应返回盒子公网 IP。

### 2. 端口映射
路由器 → 端口转发：
- 外部 `80` → 内部 `80`（Caddy 所在主机，用于 ACME http-01 验证 + http→https 跳转）
- 外部 `443` → 内部 `443`（Caddy 所在主机）

> Caddy 自动申请证书必须 **80 可达**（ACME http-01）。部分运营商封锁 80/443 外网入站，遇到签发失败先查这个。

### 3. 安装 Caddy（Caddy 所在主机）
```bash
# Debian/Ubuntu 官方源
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```
（其他发行版见 https://caddyserver.com/docs/install）

### 4. 配置
把仓库 `deploy/caddy/Caddyfile` 拷到 `/etc/caddy/Caddyfile`，把 `{BOX_UPSTREAM}` 改成盒子端点：

```bash
sudo mkdir -p /var/log/caddy /etc/caddy
sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
# 找到:  reverse_proxy {BOX_UPSTREAM} {
# 改成:  reverse_proxy https://rlptv.lzc/ {       ← 盒子的实际地址
```

> 如何填 `BOX_UPSTREAM`：优先用盒子的平台端点（含全部路由）。若 Caddy 和盒子同网，也可直接用容器服务（`http://<盒内网IP>:7890` 不行，需平台统一入口）；**推荐保持 rlptv.<盒名> 整端代理**，避免拆路由。

### 5. 启动 + 校验
```bash
sudo caddy validate --config /etc/caddy/Caddyfile   # 语法检查
sudo systemctl enable --now caddy                   # 常驻
sudo journalctl -u caddy -f                         # 看证书签发日志
```
- 首次签发成功会看到 `certificate obtained`。
- 浏览器打开 `https://lptv.10012049.xyz/` → 地址栏**小锁**（无警告）即成功。
- 排障：`curl -vk https://lptv.10012049.xyz/lptv-health` 返回 `LPTV proxy OK`；`/catlink/` 的 WS 由 reverse_proxy 自动支持。

## 常见问题

| 现象 | 原因/解决 |
|---|---|
| 证书签发失败 `acme: error` | 80 未映射 / 运营商封锁 80 入站 / DNS 未生效。先 `curl -v http://lptv.10012049.xyz` 看是否达本机 |
| 502 Bad Gateway | `BOX_UPSTREAM` 填错或 Caddy 主机不可达盒子。改内网 IP 或确认 `rlptv.<盒名>` 可解析 |
| `tls_insecure_skip_verify` 报警 | 正常（内联信任自签），日志会有 warning，可忽略；或导出盒子 CA 用 `tls_trust_pool` 替换 |
| 页面打开但 WS 连不上 | `/catlink/` 没走对。确认整端代理（未拆路由），WS 升级由 Caddy 自动处理 |

## 与方案 1/3 的关系
- 方案 2 上线后，**所有设备零配置**，无需导 CA、无需 catlink App。
- 若暂时没有公网环境，仍可用方案 1（安卓导 CA）或方案 3（catlink App）过渡。

## 安全提示
- 公网暴露的是整个 `rlptv` 端点，**建议在盒子平台侧为公网访问加上认证**（若平台支持），或在 Caddy 上加 `basic_auth` 保护，避免任何人访问你的电视会话。
- 定期 `caddy upgrade`（`sudo apt upgrade caddy`）获取安全补丁。
