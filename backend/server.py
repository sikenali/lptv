#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LPTV —— 懒猫微服 web 播放器后端
=====================================

职责 (对应原 EXE 的 bridge / inject.js 中被剥离的「取流」能力):

1. 静态托管前端 SPA (index.html / app.js / style.css / lib/*)
2. /api/channels        返回频道列表 (channels.json)
3. /api/resolve?url=..  解析 789iptv 播放页 -> 提取并解密各线路真实地址
4. /proxy?u=..          反向代理真实流 (m3u8 / ts / flv / key)，
                        自动携带 Referer + Cookie 并跟随重定向，绕过防盗链。

设计要点
--------
* 纯标准库实现，零第三方依赖，懒猫 Debian 容器自带 python3 即可运行。
* 789iptv 的线路地址经过「反转 + base64 + XOR(fuwlr+盐) + base64」混淆，
  解密算法完全移植自原站前端脚本 (ebhfv / xiuhw / jybnk)。
* p.iptv200.com 的 play.php 必须带 Referer=789iptv.com，并经多次带签名
  重定向 (migu8.php -> CDN)，因此取流必须在服务端完成，浏览器侧只认本域
  /proxy，从而彻底规避 CORS 与防盗链。

运行:
    python3 server.py --port 8080 --content ../content --channels ../channels.json
"""

import argparse
import base64
import json
import os
import re
import ssl
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# 789iptv 混淆解密
# ---------------------------------------------------------------------------
# 重要: 原站会对变量名 / XOR 密钥 / 盐 进行**每请求随机化**，因此这里不能写死常量，
# 必须从实时抓取的播放页 HTML 中结构性提取 (见 extract_secrets)。下面这组为兜底常量
# (仅当页面结构异常、解析失败时回退使用)。
FUWLR_DEF = "ed4cd8eb1ea1b41409ea52a53e2696e4"
OBQKH_DEF = "ac6fc12bf7dde2d3b2c2413359a23f8b"
HBGCC_DEF = "PwClTpZDoNzyaUIjZ1jq9IQped4cd8eb1ea1b41409ea52a53e2696e4"
SUFFIX_DEF = "1abcfebfe7137f29"

_B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"


def _b64_idx(c: str) -> int:
    try:
        return _B64_ALPHABET.index(c)
    except ValueError:
        return 0  # 脏字符按 0，与原站对未命中时的宽松行为尽量对齐


def jybnk(data: str) -> str:
    """原站 base64 解码器 (标准字母表)。末尾不足 4 字节的残组直接丢弃，
    以兼容 XOR 后长度非 4 倍数的情形 (JS 对此不报错，仅产生少量尾垃圾)。"""
    if not data:
        return data
    data = str(data)
    i = 0
    out = []
    while i + 4 <= len(data):
        h1 = _b64_idx(data[i]); h2 = _b64_idx(data[i + 1])
        h3 = _b64_idx(data[i + 2]); h4 = _b64_idx(data[i + 3])
        i += 4
        bits = h1 << 18 | h2 << 12 | h3 << 6 | h4
        a1 = bits >> 16 & 0xff
        a2 = bits >> 8 & 0xff
        a3 = bits & 0xff
        if h3 == 64:
            out.append(chr(a1))
        elif h4 == 64:
            out.append(chr(a1)); out.append(chr(a2))
        else:
            out.append(chr(a1)); out.append(chr(a2)); out.append(chr(a3))
    return "".join(out)


def xiuhw(s: str, key: str, suffix: str) -> str:
    string = jybnk(s)
    key = key + suffix
    L = len(key)
    code = "".join(chr(ord(string[i]) ^ ord(key[i % L])) for i in range(len(string)))
    return jybnk(code)


_CTRL_RE = re.compile(r'[\x00-\x1f\x7f]')


def ebhfv(msr: str, key: str, placeholder: str, real: str, suffix: str) -> str:
    """解密单条线路地址，得到真实 play.php / flv 直链。

    末端的 XOR→base64 解码过程会零星产生尾随 NUL / 控制字符
    (JS 侧对此不报错，仅留下尾垃圾)，而 urllib 在发请求时会直接拒绝
    含控制字符的 URL (URL can't contain control character)。因此这里在
    返回前统一剔除所有控制字符，保证输出一定是可发请求的干净 URL。
    """
    msr = msr[::-1]
    msr = xiuhw(msr, key, suffix)
    if placeholder and real:
        msr = msr.replace("token=" + placeholder, "token=" + real)
    if key:
        msr = msr.replace(key, "")
    return _CTRL_RE.sub('', msr).strip()


# ---------------------------------------------------------------------------
# 从实时页面结构性提取解密密钥 (应对变量名 / 密钥 / 盐 的随机化)
# ---------------------------------------------------------------------------
def _eval_expr(expr: str, assigns: dict, depth: int = 0):
    """求值形如 "a"+"b".split("").reverse().join("")+VAR 的表达式。"""
    expr = expr.strip()
    parts = re.split(r'\+', expr)
    out = []
    for p in parts:
        p = p.strip()
        m = re.match(r'^"((?:[^"\\]|\\.)*)"$', p)
        if m:
            out.append(m.group(1)); continue
        m2 = re.match(
            r'^"((?:[^"\\]|\\.)*)"\.split\(\s*""\s*\)\.reverse\(\)\.join\(\s*""\s*\)$',
            p)
        if m2:
            out.append(m2.group(1)[::-1]); continue
        if re.match(r'^[A-Za-z_$][\w$]*$', p):
            if p in assigns and depth < 12:
                out.append(_eval_expr(assigns[p], assigns, depth + 1))
            else:
                out.append('')
            continue
        out.append('')
    return ''.join(out)


def extract_secrets(html: str):
    """
    返回 (xor_key, placeholder, real_token, suffix)。
    解析页面内联脚本:
      1) 找到 ebhfv 等价函数 (同时含 '.reverse()' 与 'token=' 的函数体)；
      2) 该函数体内的 'token=" + VAR' 给出 placeholder / real_token；
      3) 该函数体内 '= func(arg, KEYVAR)' 的第二个参数即 XOR 密钥变量；
      4) xiuhw 内 'key + "SALT"' 给出盐。
    变量名每次随机，但结构固定，因此提取与命名无关。
    """
    scripts = re.findall(r'<script[^>]*>(.*?)</script>', html, re.S)
    blob = '\n'.join(s for s in scripts
                      if ('reverse' in s or 'token=' in s or 'function' in s))
    funcs = re.findall(
        r'function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{([^}]*)\}', blob, re.S)
    ebhfv_body = None
    for _name, _args, body in funcs:
        if 'token=' in body and 'reverse' in body:
            ebhfv_body = body
            break
    scope = ebhfv_body if ebhfv_body else blob

    assigns = {}
    for m in re.finditer(r'(?:var\s+)?([A-Za-z_$][\w$]*)\s*=\s*([^;]+);', blob):
        name, expr = m.group(1), m.group(2)
        if name == 'function':
            continue
        assigns[name] = expr
    resolved = {k: _eval_expr(v, assigns) for k, v in assigns.items()}

    toks = re.findall(r'token="\s*\+\s*([A-Za-z_$][\w$]*)', scope)
    xm = re.search(
        r'=\s*([A-Za-z_$][\w$]*)\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*([A-Za-z_$][\w$]*)\s*\)',
        scope)
    sm = re.search(r'key\s*\+\s*"([^"]+)"', blob)

    key = resolved.get(xm.group(2)) if xm else None
    placeholder = resolved.get(toks[0]) if toks else None
    real = resolved.get(toks[1]) if len(toks) > 1 else None
    suffix = sm.group(1) if sm else SUFFIX_DEF

    if not key:
        key = FUWLR_DEF
    if not placeholder:
        placeholder = OBQKH_DEF
    if not real:
        real = HBGCC_DEF
    return key, placeholder, real, suffix


# ---------------------------------------------------------------------------
# HTTP 取流客户端 (带 Cookie 罐 + Referer + 重定向跟随 + m3u8 改写)
# ---------------------------------------------------------------------------
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

# 禁用自动跟重定向，由我们手动跟（带 cookie 传递），避免 302 循环
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

class _InsecureHTTPS(urllib.request.HTTPSHandler):
    def __init__(self, **kwargs):
        kwargs["context"] = CTX
        super().__init__(**kwargs)

_OPENER = urllib.request.build_opener(_NoRedirect(), _InsecureHTTPS())

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
REFERER_ORIGIN = "https://www.789iptv.com/"

# 各类请求的超时预算：抓页快失败快重试，探测短超时并发跑，取流保持宽松。
TIMEOUT_PAGE = 12       # 抓 789iptv 播放页
TIMEOUT_PROBE = 4.5     # 单条线路探测
PROBE_BUDGET = 6.0      # 探测阶段总预算（超时即放弃，保留线路兜底）
PROBE_BYTES = 8192      # 探测读取字节数，够判断流魔数
PROBE_REDIRECTS = 5
TIMEOUT_STREAM = 12     # /proxy 取流：也是套接字读超时，死 CDN 挂起最多拖 12s
RESOLVE_TTL = 300       # 解析结果缓存秒数

# 极简 Cookie 罐: (host, name) -> value
_COOKIE_LOCK = threading.Lock()
_COOKIES = {}


def _host_of(url: str) -> str:
    return urllib.parse.urlparse(url).netloc


def _load_cookies(host: str) -> str:
    with _COOKIE_LOCK:
        items = [(n, v) for (h, n), v in _COOKIES.items() if h == host]
    return "; ".join(f"{n}={v}" for n, v in items)


def _store_cookies_from_headers(host: str, headers):
    """从响应头解析并持久化 Set-Cookie (用 get_all 避免逗号/expires 误切)。"""
    try:
        vals = headers.get_all("Set-Cookie") or []
    except Exception:
        vals = []
    for v in vals:
        # 取第一个分号前为 name=value
        pair = v.split(";", 1)[0].strip()
        if "=" in pair:
            n, val = pair.split("=", 1)
            with _COOKIE_LOCK:
                _COOKIES[(host, n.strip())] = val.strip()


def _referer_for(url: str) -> str:
    """play.php / iptv200 系列必须带 789iptv referer；其余 CDN 带自身源。"""
    host = _host_of(url)
    if "iptv200.com" in host or "789iptv.com" in host:
        return REFERER_ORIGIN
    return f"{urllib.parse.urlparse(url).scheme}://{host}/"


def fetch_stream(url: str, max_redirects: int = 8, timeout: float = TIMEOUT_STREAM):
    """
    跟随重定向取到最终响应体。
    返回 (body_bytes, content_type, final_url)。
    """
    resp = _open_upstream(url, max_redirects, timeout)
    ct = resp.headers.get("Content-Type", "")
    body = resp.read()
    return body, ct, resp.geturl()


def _open_upstream(url: str, max_redirects: int = 8, timeout: float = TIMEOUT_STREAM):
    """
    跟随重定向打开上游连接，返回 resp 对象（不读 body）。
    用于 FLV 直播流等需要流式转发的场景。
    timeout 为**单跳**超时；重定向链整体可能耗时更久，调用方按需给小值快失败。
    """
    cur = url
    for _ in range(max_redirects):
        host = _host_of(cur)
        req = urllib.request.Request(cur, headers={
            "User-Agent": UA,
            "Referer": _referer_for(cur),
            "Accept": "*/*",
            "Connection": "keep-alive",
        })
        cookie = _load_cookies(host)
        if cookie:
            req.add_header("Cookie", cookie)
        try:
            resp = _OPENER.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location")
            if e.code in (301, 302, 303, 307, 308):
                if loc:
                    cur = urllib.parse.urljoin(cur, loc)
                    _store_cookies_from_headers(_host_of(cur), e.headers)
                    continue
                # 空 Location：尝试 <meta refresh>
                body = e.read(4096).decode("utf-8", "ignore")
                m = re.search(r'http-equiv=["\']?refresh["\']?[^>]*url=([^"\'>\s]+)', body, re.I)
                if m:
                    cur = m.group(1).strip()
                    continue
                raise RuntimeError(f"30{e.code-300} redirect with empty Location at {cur[:80]}")
            raise
        _store_cookies_from_headers(host, resp.headers)
        code = resp.getcode()
        if code in (301, 302, 303, 307, 308):
            loc = resp.headers.get("Location")
            if loc:
                cur = urllib.parse.urljoin(cur, loc)
                continue
            # 空 Location：尝试 <meta refresh>
            body = resp.read(4096).decode("utf-8", "ignore")
            m = re.search(r'http-equiv=["\']?refresh["\']?[^>]*url=([^"\'>\s]+)', body, re.I)
            if m:
                cur = m.group(1).strip()
                continue
            raise RuntimeError(f"HTTP {code} redirect with empty Location at {cur[:80]}")
            continue
        return resp
    raise RuntimeError(f"too many redirects for {url}")


def rewrite_m3u8(text: str, base_url: str) -> str:
    """把 m3u8 内的相对/绝对地址改写为 /proxy?u=...，使浏览器统一走本域反代。"""
    def wrap(uri: str) -> str:
        absu = urllib.parse.urljoin(base_url, uri) if not uri.startswith("http") else uri
        return "/proxy?u=" + urllib.parse.quote(absu, safe="")

    out = []
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            # 处理带 URI="..." 的属性 (EXT-X-KEY / EXT-X-MAP / I-FRAME-STREAM-INF)
            m = re.search(r'(URI=")([^"]+)(")', line)
            if m:
                uri = m.group(2)
                if not uri.startswith("#"):
                    line = line[:m.start(2)] + wrap(uri) + line[m.end(2):]
            out.append(line)
            continue
        out.append(wrap(line.strip()))
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# 789iptv 播放页解析
# ---------------------------------------------------------------------------
_OPTION_RE = re.compile(
    r'<select[^>]*id=["\']playURL["\'][^>]*>(.*?)</select>', re.S | re.I)
_OPT_VAL_RE = re.compile(r'<option[^>]*value=["\']([^"\']+)["\']', re.I)


def resolve_789_raw(page_url: str):
    """
    抓取 789iptv 播放页，提取 #playURL 各线路并解密（不探测、不排序）。
    返回 [{"label": "线路N", "url": "<真实地址>", "type": "hls|flv"}, ...]
    """
    body, _, _ = fetch_stream(page_url, max_redirects=8, timeout=TIMEOUT_PAGE)
    try:
        html = body.decode("utf-8", "ignore")
    except Exception:
        html = ""
    m = _OPTION_RE.search(html)
    lines = []
    if not m:
        return lines
    # 从实时页面提取随机化的密钥 (兜底用常量)
    key, placeholder, real, suffix = extract_secrets(html)
    opts = _OPT_VAL_RE.findall(m.group(1))
    for idx, raw in enumerate(opts, 1):
        try:
            u = ebhfv(raw, key, placeholder, real, suffix)
        except Exception:
            continue
        # 再保险：任何残留控制字符都剔除，确保 url 可发请求
        u = _CTRL_RE.sub('', u).strip()
        if not u.startswith("http"):
            continue
        typ = "flv" if (".flv" in u.split("?")[0] or "type=.flv" in u) else "hls"
        lines.append({"label": f"线路{idx}", "url": u, "type": typ})
    return lines


def probe_line(url: str, timeout: float = TIMEOUT_PROBE):
    """并发探测单条线路：拉取前若干字节并校验流魔数。

    成功返回时延毫秒数（int）；未通过返回 None。
    返回 None **不代表线路真失效**——超时、CDN 抖动、并发限流都会误杀，
    因此调用方仍须把未通过的线路排在末尾兜底，不能丢弃。
    """
    t0 = time.monotonic()
    resp = None
    try:
        resp = _open_upstream(url, max_redirects=PROBE_REDIRECTS, timeout=timeout)
        code = resp.getcode()
        if code is not None and not 200 <= code < 300:
            return None
        chunk = resp.read(PROBE_BYTES)
    except Exception:
        return None
    finally:
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass
    if not chunk or len(chunk) < 16:
        return None
    head = chunk[:64]
    ok = (
        chunk[:3] == b"FLV"               # FLV 直播
        or chunk[:1] == b"\x47"           # MPEG-TS 同步字节
        or head.lstrip()[:4] == b"#EXT"   # HLS 播放列表
        or b"ftyp" in chunk[:32]          # MP4 / fMP4
    )
    if not ok:
        return None
    return int((time.monotonic() - t0) * 1000)


_RESOLVE_CACHE = {}
_RESOLVE_LOCK = threading.Lock()


def resolve_789(page_url: str, fresh: bool = False):
    """解析频道线路：抓页 -> 解密 -> 并发探测 -> 按可用性与时延排序 -> 缓存。

    返回 {"lines": [...], "ready": 可用条数, "probe_ms": 探测耗时, "cached": bool}
    lines 元素为 {"label","url","type","latency_ms"}（探测未通过时 latency_ms 为 null）。
    排序规则：可用线路按时延升序在前，未通过线路原样留在末尾兜底。
    fresh=True 绕过缓存强制重新抓页，用于全线路失败后的兜底重试。
    """
    now = time.monotonic()
    with _RESOLVE_LOCK:
        hit = _RESOLVE_CACHE.get(page_url)
        if hit and not fresh and now - hit[0] < RESOLVE_TTL:
            payload = dict(hit[1])
            payload["cached"] = True
            return payload

    # 抓页失败重试一次：播放页抓取常因瞬时网络抖动失败
    lines, last_err = None, None
    for attempt in range(2):
        try:
            lines = resolve_789_raw(page_url)
            break
        except Exception as e:
            last_err = e
            if attempt == 0:
                time.sleep(0.3)
    if lines is None:
        raise last_err or RuntimeError("resolve failed")

    probed, probe_ms = [], 0
    if lines:
        t0 = time.monotonic()
        deadline = t0 + PROBE_BUDGET
        # 不用 with 上下文：__exit__ 会 shutdown(wait=True)，被最慢的一条线程拖住，
        # 使探测阶段远超预算。这里显式 wait=False 收尾。
        ex = ThreadPoolExecutor(max_workers=max(1, min(8, len(lines))))
        futs = [ex.submit(probe_line, ln["url"]) for ln in lines]
        results = []
        for f in futs:
            left = deadline - time.monotonic()
            if left <= 0:
                results.append(None)
                continue
            try:
                results.append(f.result(timeout=left))
            except Exception:
                results.append(None)
        try:
            ex.shutdown(wait=False, cancel_futures=True)
        except TypeError:
            ex.shutdown(wait=False)
        probe_ms = int((time.monotonic() - t0) * 1000)
        for ln, r in zip(lines, results):
            item = dict(ln)
            item["latency_ms"] = r
            probed.append(item)

    ready = [l for l in probed if l["latency_ms"] is not None]
    dead = [l for l in probed if l["latency_ms"] is None]
    ready.sort(key=lambda l: l["latency_ms"])
    payload = {
        "lines": ready + dead,
        "ready": len(ready),
        "probe_ms": probe_ms,
    }
    with _RESOLVE_LOCK:
        _RESOLVE_CACHE[page_url] = (now, payload)
        if len(_RESOLVE_CACHE) > 256:
            _RESOLVE_CACHE.pop(next(iter(_RESOLVE_CACHE)), None)
    return payload


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "LPTVWeb/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass  # 静默

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            if extra:
                for k, v in extra.items():
                    self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _stream_proxy(self, resp, ctype):
        """FLV 直播流：边收边发，不读完整 body。"""
        self.send_response(200)
        self.send_header("Content-Type", ctype or "video/x-flv")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            while True:
                chunk = resp.read(32768)
                if not chunk:
                    break
                size = f"{len(chunk):X}\r\n"
                self.wfile.write(size.encode() + chunk + b"\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except Exception:
                pass

    def _serve_static(self, path: str):
        # 安全：防目录穿越
        path = path.lstrip("/")
        full = os.path.normpath(os.path.join(self.server.content_dir, path))
        if not full.startswith(os.path.abspath(self.server.content_dir)):
            self._send(403, "forbidden")
            return
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            self._send(404, "not found")
            return
        ctype = self._guess_type(full)
        try:
            with open(full, "rb") as f:
                data = f.read()
        except Exception:
            self._send(500, "read error")
            return
        self._send(200, data, ctype)

    def _guess_type(self, path: str) -> str:
        ext = os.path.splitext(path)[1].lower()
        return {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
        }.get(ext, "application/octet-stream")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if route in ("/", "/index.html"):
            self._serve_static("index.html")
            return
        if route == "/api/health":
            self._send(200, json.dumps({"status": "ok"}))
            return
        if route == "/api/channels":
            try:
                with open(self.server.channels_file, "rb") as f:
                    data = f.read()
                self._send(200, data, "application/json; charset=utf-8")
            except Exception as e:
                self._send(500, json.dumps({"error": str(e)}, ensure_ascii=False))
            return
        if route == "/api/resolve":
            page = (qs.get("url") or [None])[0]
            if not page:
                self._send(400, json.dumps({"error": "missing url"}))
                return
            # fresh=1 绕过缓存强制重新抓页，供前端全线路失败后兜底重试
            fresh = (qs.get("fresh") or ["0"])[0] in ("1", "true", "yes", "on")
            try:
                payload = resolve_789(page, fresh=fresh)
                self._send(200, json.dumps(payload, ensure_ascii=False))
            except Exception as e:
                self._send(502, json.dumps({"error": str(e)}, ensure_ascii=False))
            return
        if route == "/proxy":
            target = (qs.get("u") or [None])[0]
            if not target:
                self._send(400, json.dumps({"error": "missing u"}))
                return
            # 注意: 不对 target 二次 unquote —— 保留 token 中的 %2F 等原样，
            # 由 urllib 发请求时再按 URL 规则处理。
            try:
                resp = _open_upstream(target)
            except Exception as e:
                self._send(502, json.dumps({"error": str(e)}, ensure_ascii=False))
                return
            ctype = resp.headers.get("Content-Type", "")
            # FLV 直播流是无限字节流，必须流式转发（不能 read() 全读完）
            is_flv_live = ("flv" in ctype or ".flv" in target.lower())
            if is_flv_live:
                self._stream_proxy(resp, ctype)
            else:
                body = resp.read()
                final_url = resp.geturl()
                # 若拿到的是 m3u8 文本，改写内嵌地址
                if ("mpeg" in ctype or ctype.startswith("text") or
                        body[:20].lstrip().startswith(b"#EXT")):
                    try:
                        text = body.decode("utf-8", "ignore")
                        body = rewrite_m3u8(text, final_url).encode("utf-8")
                        ctype = "application/vnd.apple.mpegurl"
                    except Exception:
                        pass
                self._send(200, body, ctype)
            return
        # 其余按静态文件处理
        self._serve_static(route)

    do_HEAD = do_GET


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--content", default=os.path.join(os.path.dirname(__file__), "..", "content"))
    ap.add_argument("--channels", default=os.path.join(os.path.dirname(__file__), "..", "channels.json"))
    args = ap.parse_args()

    content_dir = os.path.abspath(args.content)
    channels_file = os.path.abspath(args.channels)
    if not os.path.isfile(channels_file):
        # 兜底：若没带 channels.json，则尝试同目录
        alt = os.path.join(content_dir, "channels.json")
        if os.path.isfile(alt):
            channels_file = alt

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.content_dir = content_dir
    httpd.channels_file = channels_file
    print(f"[LPTVWeb] serving static from: {content_dir}")
    print(f"[LPTVWeb] channels file:       {channels_file}")
    print(f"[LPTVWeb] listening on http://{args.host}:{args.port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
