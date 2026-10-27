"""pywebview platform: real Chrome driven over the DevTools Protocol.

Why this backend exists
-----------------------
pywebview ships only two usable Linux backends:

  * ``qt``  - QtWebEngine. The bundled Chromium FFmpeg build has no H.264 decoder,
             so ``MediaSource.isTypeSupported('video/mp4;codecs="avc1.42E01E,mp4a.40.2"')``
             is ``false`` and an MSE stream can never start. Measured: the video
             element stays ``0x0`` / ``readyState=0``.
  * ``gtk`` - WebKit2GTK. No MSE at all, no H.264. Measured: every codec string
             returns ``""``.

Both are permanently black for CCTV (央视频 CMG), which is a pure
H.264/MP4-over-MSE live stream.  ``cef`` is Windows-only (imports ``winreg``).

Real Chrome decodes it: measured ``1920x1080``, ``readyState=4``, continuous
``currentTime`` advance and genuinely varying canvas pixels.

This module therefore drives a real Chrome binary (AppImage, extracted tree or
plain executable) speaking the DevTools Protocol over a websocket, mapping the
result onto pywebview's platform API so ``app/main.py`` runs unchanged with
``webview.start(gui='chromium')``.

Architecture
------------
One Chrome process per ``webview.start()``. One websocket connection to the
*browser* endpoint per pywebview window (browser-level targets expose both the
``Browser`` domain for window bounds and the ``Target`` domain for page
navigation / ``Runtime.evaluate``), multiplexed by ``sessionId``.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import random
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid
from threading import Event, Lock, Thread

from webview.screen import Screen
from webview.util import js_bridge_call, load_js_files

logger = logging.getLogger('pywebview')

renderer = 'chromium'

WINDOWS: dict[str, dict] = {}
_BROWSER_PROC: subprocess.Popen | None = None
_BROWSER_DEAD = Event()
_CHROME_DIR: str | None = None
_SCREEN: tuple[int, int, int, int] = (0, 0, 1280, 720)


# ---------------------------------------------------------------------------
# Minimal synchronous CDP client (RFC 6455, text frames)
# ---------------------------------------------------------------------------
class CDP:
    """One websocket connection, multiplexed by CDP ``sessionId``."""

    def __init__(self, port: int, ws_url: str, name: str = 'cdp') -> None:
        self.port = port
        self.name = name
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=10)
        self.sock.settimeout(3.0)
        self.lock = Lock()
        self.pending: dict[int, dict] = {}
        self.plock = Lock()
        self.listeners: list[dict] = []
        self.alive = True
        self._connect(ws_url)
        self.reader = Thread(target=self._read_loop, daemon=True, name=name)
        self.reader.start()

    def _connect(self, ws_url: str) -> None:
        key = base64.b64encode(os.urandom(16)).decode()
        path = ws_url.replace('ws://127.0.0.1:%d' % self.port, '')
        self.sock.sendall(
            (
                'GET %s HTTP/1.1\r\n'
                'Host: 127.0.0.1:%d\r\n'
                'Upgrade: websocket\r\n'
                'Connection: Upgrade\r\n'
                'Sec-WebSocket-Key: %s\r\n'
                'Sec-WebSocket-Version: 13\r\n'
                '\r\n'
                % (path, self.port, key)
            ).encode()
        )
        hdr = b''
        while b'\r\n\r\n' not in hdr:
            hdr += self.sock.recv(4096)
        if b'101' not in hdr.split(b'\r\n', 1)[0]:
            raise RuntimeError('websocket handshake failed: %r' % hdr[:120])

    def _send(self, obj: dict) -> None:
        payload = json.dumps(obj).encode()
        mask = os.urandom(4)
        n = len(payload)
        head = bytearray([0x81])
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack('>H', n)
        else:
            head.append(0x80 | 127)
            head += struct.pack('>Q', n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(head) + mask + masked)

    def _send_control(self, opcode: int, payload: bytes) -> None:
        n = len(payload)
        head = bytearray([opcode])
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack('>H', n)
        else:
            head.append(0x80 | 127)
            head += struct.pack('>Q', n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(head) + mask + masked)

    def _read_loop(self) -> None:
        buf = b''
        while self.alive:
            try:
                chunk = self.sock.recv(1 << 20)
            except socket.timeout:
                continue
            except (ConnectionError, OSError):
                break
            if not chunk:
                break
            buf += chunk
            while True:
                if len(buf) < 2:
                    break
                opcode = buf[0] & 0x0F
                masked = bool(buf[1] & 0x80)
                length = buf[1] & 0x7F
                off = 2
                if masked:
                    off += 4
                if length == 126:
                    if len(buf) < 4:
                        break
                    length, off = struct.unpack('>H', buf[2:4])[0], off + 2
                elif length == 127:
                    if len(buf) < 10:
                        break
                    length, off = struct.unpack('>Q', buf[2:10])[0], off + 6
                if len(buf) < off + length:
                    break
                data, buf = buf[off:off + length], buf[off + length:]
                if opcode == 8:
                    return
                if opcode == 9:
                    self._send_control(0x8A, data)
                    continue
                if opcode not in (1, 2):
                    continue
                try:
                    msg = json.loads(data.decode('utf-8', 'ignore'))
                except Exception:
                    continue
                self._dispatch(msg)

    def _dispatch(self, msg: dict) -> None:
        mid = msg.get('id')
        if mid is not None:
            with self.plock:
                slot = self.pending.get(mid)
            if slot is not None:
                slot['_done'].set()
                slot['_msg'] = msg
                return
        if 'method' in msg:
            for lst in list(self.listeners):
                lst['_cb'](msg)

    def call(self, method: str, params: dict | None = None, timeout: float = 30.0,
             session_id: str | None = None):
        with self.lock:
            mid = random.randint(1, 2 ** 31 - 1)
            slot = {'_done': Event(), '_msg': None}
            with self.plock:
                self.pending[mid] = slot
            msg = {'id': mid, 'method': method, 'params': params or {}}
            if session_id:
                msg['sessionId'] = session_id
            try:
                self._send(msg)
            except Exception:
                with self.plock:
                    self.pending.pop(mid, None)
                raise
            if not slot['_done'].wait(timeout):
                with self.plock:
                    self.pending.pop(mid, None)
                return {'error': {'message': 'timeout waiting for %s' % method}}
        return slot['_msg'] or {}

    def evaluate(self, expression: str, session_id: str | None = None,
                 timeout: float = 30.0, await_promise: bool = True) -> dict:
        """Return the ``result`` object of a Runtime.evaluate call."""
        resp = self.call(
            'Runtime.evaluate',
            {
                'expression': expression,
                'returnByValue': True,
                'awaitPromise': await_promise,
                'userGesture': True,
            },
            timeout=timeout,
            session_id=session_id,
        )
        if 'error' in resp:
            logger.warning('[chromium] Runtime.evaluate transport error: %r', resp['error'])
            return {}
        return resp.get('result', {}).get('result') or {}

    def on(self, cb) -> None:
        self.listeners.append({'_cb': cb})

    def close(self) -> None:
        self.alive = False
        try:
            self.sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Chrome discovery / launch
# ---------------------------------------------------------------------------
def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _extract_appimage(path: str) -> tuple[str, str]:
    cache = os.environ.get('LPTV_CHROME_DIR')
    if not cache:
        cache = os.path.join(
            os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache'),
            'lptv', 'chrome',
        )
    cache = os.path.abspath(cache)
    os.makedirs(cache, exist_ok=True)
    sentinel = os.path.join(cache, 'squashfs-root', 'opt', 'google', 'chrome', 'chrome')
    if not (os.path.isfile(sentinel) and os.access(sentinel, os.X_OK)):
        logger.info('[chromium] extracting AppImage %s -> %s', path, cache)
        if os.path.isdir(cache):
            for child in os.listdir(cache):
                shutil.rmtree(os.path.join(cache, child), ignore_errors=True)
        proc = subprocess.Popen(
            [path, '--appimage-extract'], cwd=cache,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        rc = proc.wait(timeout=600)
        if rc != 0:
            raise RuntimeError('AppImage extraction failed (%d): %s' % (rc, path))
    root = os.path.join(cache, 'squashfs-root')
    for cand in (
        os.path.join(root, 'opt', 'google', 'chrome', 'chrome'),
        os.path.join(root, 'chrome'),
    ):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand, root
    raise RuntimeError('Chrome binary not found inside %s' % path)


def _find_chrome() -> tuple[str, str | None]:
    """Return ``(executable, containing_dir_or_None)``."""
    explicit = os.environ.get('LPTV_CHROME') or os.environ.get('PYWEBVIEW_CHROME')
    if explicit and os.path.exists(explicit):
        return _extract_appimage(explicit) if explicit.endswith('.AppImage') else (explicit, None)

    candidates: list[str] = []
    appdir = os.environ.get('APPDIR')
    if appdir:
        candidates += [os.path.join(appdir, 'usr', 'share', 'chrome'),
                       os.path.join(appdir, 'opt', 'google', 'chrome')]
    candidates += ['/lzcapp/pkg/content/chrome', '/lzcapp/var/chrome', '/opt/chrome',
                   '/lzcapp/pkg/content/appimage', '/lzcapp/var/apps/chrome']

    for c in candidates:
        for rel in ('chrome', os.path.join('opt', 'google', 'chrome', 'chrome')):
            p = os.path.join(c, rel)
            if os.path.isfile(p) and os.access(p, os.X_OK):
                root = os.path.dirname(p)
                if root.endswith('google/chrome'):
                    root = root[:-len('google/chrome')]
                return p, root

    for c in candidates:
        if not os.path.isdir(c):
            continue
        for f in os.listdir(c):
            p = os.path.join(c, f)
            if f.endswith('.AppImage') and 'chrome' in f.lower():
                return _extract_appimage(p)

    for name in ('google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'):
        w = shutil.which(name)
        if w:
            return w, None

    raise RuntimeError(
        'no usable Chrome binary found; set LPTV_CHROME to an executable or .AppImage'
    )


def _hex_to_rgba(color: str | None):
    if not color:
        return None
    h = color.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    if len(h) != 6:
        return None
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return {'r': r, 'g': g, 'b': b, 'a': 255}


def _xpra_pulse_env() -> dict:
    """Discover xpra's PulseAudio sink so the window's audio reaches the client.

    xpra runs its own pulseaudio and publishes the socket on the X root window
    as ``PULSE_SERVER`` (plus ``PULSE_COOKIE``). Without it Chrome finds no
    audio server at all and plays into the void -- the whole reason "没有声音".
    Sink ``Xpra-Speaker`` is the null-sink xpra encodes over the WebSocket.
    """
    out = {}
    try:
        disp = os.environ.get('DISPLAY') or ':0'
        r = subprocess.run(['xprop', '-display', disp, '-root', 'PULSE_SERVER'],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
        txt = r.stdout.decode('utf-8', 'replace') if r.stdout else ''
        m = re.search(r'unix:/[^\s"]+', txt)
        if m:
            out['PULSE_SERVER'] = m.group(0)
        r2 = subprocess.run(['xprop', '-display', disp, '-root', 'PULSE_COOKIE'],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
        txt2 = r2.stdout.decode('utf-8', 'replace') if r2.stdout else ''
        mc = re.search(r'= "([0-9a-fA-F]{32,})"', txt2)
        if mc:
            path = os.path.join(tempfile.gettempdir(), 'lptv-pulse-cookie')
            try:
                with open(path, 'w') as f:
                    f.write(mc.group(1))
                os.chmod(path, 0o600)
                out['PULSE_COOKIE'] = path
            except Exception:
                pass
    except Exception as e:
        logger.warning('[chromium] pulse discovery failed: %s', e)
        return {}
    if out.get('PULSE_SERVER'):
        logger.info('[chromium] audio routed to %s', out['PULSE_SERVER'])
    return out


def _launch_chrome(window) -> tuple[int, str]:
    url = window.real_url or window.original_url
    port = int(os.environ.get('LPTV_CDP_PORT') or 0) or _free_port()
    user_data = os.environ.get('LPTV_CHROME_PROFILE') or os.path.join(
        tempfile.gettempdir(), 'lptv-chrome-%s' % uuid.uuid1().hex
    )
    os.makedirs(user_data, exist_ok=True)
    binary, chrome_dir = _find_chrome()
    global _CHROME_DIR
    _CHROME_DIR = chrome_dir

    flags = [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        # 翻译提示：央视频页面本身就是中文。--lang=zh-CN 让浏览器 UI 语言与页面
        # 语言一致，翻译器就不会再弹；feature 关闭是第二道保险。
        # UnsupportedFlagWarning：抑制 "You are using an unsupported command-line
        # flag: --no-sandbox" 的顶部警告条（--no-sandbox 是容器内 root 必需）。
        '--disable-features=Translate,TranslateUI,TranslateAutodownload,UnsupportedFlagWarning',
        '--lang=zh-CN',
        '--accept-lang=zh-CN,zh',
        '--disable-background-timer-throttling',
        '--autoplay-policy=no-user-gesture-required',
        '--remote-debugging-port=%d' % port,
        '--user-data-dir=%s' % user_data,
        # WM 列表里的类名。默认 "Google-chrome"，会让远程端看到的应用身份是
        # Chrome 而不是 LPTV。
        '--class=%s' % (os.environ.get('LPTV_WMC_CLASS') or 'LPTV'),
        '--window-size=%d,%d' % (window.initial_width, window.initial_height),
    ]
    cdn = os.environ.get('LPTV_WIDEVINE_CDM')
    if cdn and os.path.exists(cdn):
        flags.append('--widevine-cdm-path=%s' % cdn)
    ua = os.environ.get('LPTV_CHROME_UA')
    if ua:
        flags.append('--user-agent=%s' % ua)
    if os.environ.get('LPTV_IGNORE_SSL') == '1':
        flags.append('--ignore-certificate-errors')
    if window.initial_x is not None and window.initial_y is not None:
        flags.append('--window-position=%d,%d' % (window.initial_x, window.initial_y))
    if window.frameless:
        flags.append('--app=%s' % url)
    else:
        flags.append(url)

    env = dict(os.environ)
    if chrome_dir:
        old = env.get('LD_LIBRARY_PATH', '')
        env['LD_LIBRARY_PATH'] = (chrome_dir + os.sep + old) if old else chrome_dir
    env.update(_xpra_pulse_env())

    logger.info('[chromium] launching %s (port %d, app=%s)', binary, port, bool(window.frameless))
    log_path = os.environ.get('LPTV_CHROME_LOG') or os.path.join(
        tempfile.gettempdir(), 'lptv-chrome-%d.log' % port)
    try:
        err = open(log_path, 'ab')
    except Exception:
        err = subprocess.DEVNULL
    proc = subprocess.Popen(
        [binary] + flags,
        stdout=subprocess.DEVNULL,
        stderr=err,
        env=env,
        start_new_session=True,
    )
    global _BROWSER_PROC
    _BROWSER_PROC = proc
    return port, binary


def _http_json(port: int, path: str, timeout: float = 5.0):
    with urllib.request.urlopen('http://127.0.0.1:%d%s' % (port, path), timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8', 'ignore'))


def _r(resp: dict | None) -> dict:
    """Unwrap a CDP message down to its ``result`` object."""
    return (resp or {}).get('result') or {}


def _wait_devtools(port: int, timeout: float = 90.0) -> None:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            _http_json(port, '/json/version', 3.0)
            return
        except Exception as e:
            last = e
            time.sleep(0.5)
    raise RuntimeError('Chrome DevTools never came up on port %d: %r' % (port, last))


def _browser_ws(port: int, timeout: float = 90.0) -> CDP:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            v = _http_json(port, '/json/version', 3.0)
            ws = v.get('webSocketDebuggerUrl', '')
            if ws:
                return CDP(port, ws, name='chrome-browser')
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError('no browser websocket on port %d' % port)


def _wait_target(cdp: CDP, predicate, timeout: float = 90.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = cdp.call('Target.getTargets', {}, timeout=10.0)
        for t in _r(resp).get('targetInfos', []):
            if predicate(t):
                return t['targetId']
        time.sleep(0.3)
    raise RuntimeError('no target matching predicate within %.0fs' % timeout)


# ---------------------------------------------------------------------------
# pywebview platform API
# ---------------------------------------------------------------------------
def setup_app() -> None:
    os.environ.setdefault('PYTHONUTF8', '1')


def get_screens() -> list[Screen]:
    try:
        out = subprocess.run(
            ['xdpyinfo', '-display', os.environ.get('DISPLAY', ':0')],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for line in out.splitlines():
            if 'dimensions:' in line:
                nums = [int(t) for t in line.split(':')[1].replace(',', ' ').split()]
                if len(nums) >= 2:
                    global _SCREEN
                    _SCREEN = (0, 0, nums[0], nums[1])
                    return [Screen(0, 0, nums[0], nums[1], None, 1.0)]
    except Exception:
        pass
    return [Screen(*_SCREEN[0:4], None, 1.0)]


def get_active_window():
    for rec in WINDOWS.values():
        if rec['window'].events.shown.is_set():
            return rec['window']
    return None


def create_window(window) -> None:
    """Spawn Chrome (first window) and block until it exits."""
    global _BROWSER_PROC
    is_master = window.uid == 'master'

    if is_master:
        _BROWSER_DEAD.clear()
        port, binary = _launch_chrome(window)
        _wait_devtools(port)
        Thread(target=_watch_chrome, daemon=True, name='chrome-watch').start()
    else:
        port = WINDOWS[list(WINDOWS)[0]]['port']

    cdp = _browser_ws(port)

    if is_master:
        target_id = _wait_target(
            cdp, lambda t: t['type'] == 'page' and (t.get('url') == window.real_url
                                                    or 'about:blank' in (t.get('url') or '')),
            timeout=240.0,
        )
    else:
        resp = cdp.call('Target.createTarget',
                        {'url': window.real_url or 'about:blank',
                         'newWindow': bool(window.frameless),
                         'background': False},
                        timeout=30.0)
        target_id = _r(resp).get('targetId')
        if not target_id:
            raise RuntimeError('Target.createTarget failed: %r' % resp)

    resp = cdp.call('Target.attachToTarget', {'targetId': target_id, 'flatten': True}, timeout=20.0)
    session_id = _r(resp).get('sessionId')
    if not session_id:
        raise RuntimeError('Target.attachToTarget failed: %r' % resp)

    rec = {
        'window': window,
        'cdp': cdp,
        'target_id': target_id,
        'session_id': session_id,
        'port': port,
        'bounds': {'width': window.initial_width, 'height': window.initial_height,
                   'left': window.initial_x or 0, 'top': window.initial_y or 0},
        'window_state': 'normal',
        'fullscreen': bool(window.fullscreen),
        'pre_fullscreen': None,
    }
    WINDOWS[window.uid] = rec

    cdp.call('Page.enable', {}, timeout=10.0, session_id=session_id)
    cdp.call('Runtime.enable', {}, timeout=10.0, session_id=session_id)
    rec['_binding'] = cdp.call('Runtime.addBinding',
                               {'name': BINDING_NAME}, timeout=10.0,
                               session_id=session_id)

    color = _hex_to_rgba(window.background_color)
    if color:
        cdp.call('Page.setDocumentBackgroundColorOverride', {'color': color},
                 timeout=10.0, session_id=session_id)

    try:
        cdp.on(_make_event_handler(window, rec))
        _apply_initial_state(window, rec)
        _bootstrap(window, rec)
    except Exception:
        logger.exception('[chromium] window setup failed')

    try:
        if is_master:
            _block_until_closed(window, rec)
    finally:
        try:
            cdp.call('Target.detachFromTarget', {'targetId': target_id}, timeout=5.0)
        except Exception:
            pass
        cdp.close()
        WINDOWS.pop(window.uid, None)


def _watch_chrome() -> None:
    assert _BROWSER_PROC is not None
    rc = _BROWSER_PROC.wait()
    logger.info('[chromium] chrome exited rc=%s', rc)
    _BROWSER_DEAD.set()


def _block_until_closed(window, rec: dict) -> None:
    while not _BROWSER_DEAD.is_set():
        time.sleep(0.2)
    try:
        window.events.closing.set()
    except Exception:
        pass
    try:
        window.events.closed.set()
    except Exception:
        pass


def _on_binding(rec: dict, params: dict) -> None:
    """Handle a Runtime.bindingCalled event coming from the page."""
    payload = params.get('payload')
    if not payload:
        return
    try:
        frame = json.loads(payload)
        func_name, params_json, value_id = frame[0], frame[1], frame[2]
        param = json.loads(params_json) if isinstance(params_json, str) else params_json
    except Exception:
        logger.exception('[chromium] could not decode binding call')
        return
    Thread(target=js_bridge_call,
           args=(rec['window'], func_name, param, value_id),
           daemon=True, name='bridge-%s-%s' % (rec['window'].uid, value_id)).start()


def _make_event_handler(window, rec: dict):
    def _handler(msg: dict) -> None:
        if msg.get('sessionId') != rec['session_id']:
            return
        method = msg.get('method', '')
        if method == 'Page.loadEventFired':
            logger.info('[chromium] page loadEventFired, (re)injecting bridge')
            Thread(target=_inject_bridge, args=(window, rec), daemon=True,
                   name='inject-%s' % window.uid).start()
        elif method == 'Runtime.bindingCalled':
            _on_binding(rec, msg.get('params') or {})

    return _handler


def _page_ready(cdp: CDP, session_id: str, timeout: float = 90.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = cdp.evaluate('document.readyState', session_id=session_id,
                         timeout=5.0, await_promise=False)
        if (r or {}).get('value') == 'complete':
            return True
        time.sleep(0.4)
    return False


def _bootstrap(window, rec: dict) -> None:
    cdp: CDP = rec['cdp']
    if not _page_ready(cdp, rec['session_id']):
        logger.warning('[chromium] page never reached readyState=complete; injecting anyway')

    try:
        window.events.shown.set()
    except Exception:
        pass

    Thread(target=_inject_bridge, args=(window, rec), daemon=True,
           name='bootstrap-%s' % window.uid).start()


# -- bridge injection ------------------------------------------------------
BINDING_NAME = '__lxbBridge'

BRIDGE_SHIM = """
(function(){
  if (window.__lxBridgeWired) return;
  var pv = window.pywebview;
  if (!pv || typeof pv._jsApiCallback !== 'function') return;
  if (typeof window.__lxbBridge !== 'function') return;
  pv._jsApiCallback = function(funcName, params, id){
    try { window.__lxbBridge(JSON.stringify([funcName, pywebview.stringify(params), id])); }
    catch(e){ try{console.log('__lxbErr__'+e)}catch(_){} }
  };
  window.__lxBridgeWired = true;
})()
"""


# -- bridge injection ------------------------------------------------------
def _func_args(func) -> list[str]:
    import inspect
    return list(inspect.getfullargspec(func).args)


def _collect_functions(obj, base_name: str = '', out: dict | None = None,
                       seen: set | None = None) -> dict:
    """Mirror of the discovery logic inside pywebview.util.inject_pywebview."""
    import inspect
    if out is None:
        out = {}
    if seen is None:
        seen = set()
    oid = id(obj)
    if oid in seen:
        return out
    seen.add(oid)
    for name in dir(obj):
        try:
            full_name = f'{base_name}.{name}' if base_name else name
            if name.startswith('_'):
                continue
            attr = getattr(obj, name)
            if not getattr(attr, '_serializable', True):
                continue
            if inspect.ismethod(attr) or inspect.isfunction(attr):
                out[full_name] = _func_args(attr)[1:]
            elif inspect.isclass(attr) or (
                    isinstance(attr, object) and not callable(attr)
                    and hasattr(attr, '__module__')):
                _collect_functions(attr, full_name, out, seen)
        except Exception as e:
            logger.error('Error while processing %s: %s', full_name, e)
    return out


_SPLASH_CACHE: str | None = None


def _splash_source() -> str:
    """Splash config shim + script, evaluated at document-start before site JS.

    Registered via Page.addScriptToEvaluateOnNewDocument so it paints during
    navigation itself -- otherwise the user briefly sees the raw yangshipin
    page before inject.js' bootmask can cover it. Channel switches use the
    official SPA's pushState (not a new document navigation), so the splash
    never reappears.
    """
    global _SPLASH_CACHE
    if _SPLASH_CACHE is not None:
        return _SPLASH_CACHE
    js_path = os.environ.get('LPTV_SPLASH_JS')
    if not js_path or not os.path.isfile(js_path):
        _SPLASH_CACHE = ''
        return ''
    try:
        with open(js_path, 'r', encoding='utf-8') as f:
            src = f.read()
    except Exception as e:
        logger.warning('[chromium] splash js unreadable %s: %s', js_path, e)
        _SPLASH_CACHE = ''
        return ''
    cfg = {'title': 'LPTV'}
    icon = os.environ.get('LPTV_SPLASH_ICON')
    if icon and os.path.isfile(icon):
        try:
            with open(icon, 'rb') as f:
                cfg['icon'] = 'data:image/png;base64,' + base64.b64encode(f.read()).decode()
        except Exception:
            pass
    _SPLASH_CACHE = ('try{window.__LPTV_SPLASH_CFG=%s;}catch(e){}\n'
                     % json.dumps(cfg, ensure_ascii=False) + src)
    logger.info('[chromium] splash registered (%d bytes, favicon=%s)',
                len(src), bool(cfg.get('icon')))
    return _SPLASH_CACHE


# -- window icon (_NET_WM_ICON) -------------------------------------------
# Chrome 决定 --app 窗口图标是在窗口建立的那一刻，之后页面里 <link rel=icon>
# 再怎么改（包括我们注入的 LPTV favicon）都不会更新窗口图标 —— 所以窗口标题
# 已经是 LPTV，图标却还是 Chrome 的默认 16x16。本容器没有 WM 也没有 xdotool，
# 就用 libX11 直接把图标写进 _NET_WM_ICON 属性。
#   注意不能用 `xprop -set`：512² 图标的 cardinal 列表 >128 KiB，超过 Linux
#   单参数上限 MAX_ARG_STRLEN，xprop 会 "Argument list too long"。

def _png_to_argb(path: str, size: int = 256) -> tuple[int, int, list[int]]:
    """纯 Python 解码 PNG → ARGB(0xAARRGGBB) 列表（无 PIL/numpy）。

    应用里的 icon.png 是 512² RGBA 非隔行 PNG，按常见颜色类型处理，
    其它情况失败就放弃（图标不是关键路径）。
    """
    import struct
    import zlib
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
    pos, w, h, bitd, ctype = 8, 0, 0, 0, 0
    plte = trns = b''
    idat = b''
    while pos < len(data):
        ln, typ = struct.unpack('>I4s', data[pos:pos + 8])
        ch = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, bitd, ctype = struct.unpack('>IIBB', ch[:10])
        elif typ == b'IDAT':
            idat += ch
        elif typ == b'PLTE':
            plte = ch
        elif typ == b'tRNS':
            trns = ch
        pos += 12 + ln
    if bitd != 8:
        raise ValueError('bit depth %d' % bitd)
    nch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(idat)
    stride = w * nch
    out = bytearray()
    prev = bytearray(stride)
    i = 0
    for _y in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        if f == 1:
            for x in range(nch, stride):
                line[x] = (line[x] + line[x - nch]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - nch] if x >= nch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - nch] if x >= nch else 0
                b = prev[x]; c = prev[x - nch] if x >= nch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if (pa <= pb and pa <= pc) else (b if pb <= pc else c))) & 255
        out += line
        prev = line
    px = []
    for y in range(h):
        row = out[y * stride:(y + 1) * stride]
        for x in range(w):
            o = x * nch
            if ctype == 6:
                r, g, b, a = row[o:o + 4]
            elif ctype == 2:
                r, g, b = row[o:o + 3]; a = 255
            elif ctype == 4:
                v, a = row[o:o + 2]; r = g = b = v
            elif ctype == 0:
                v = row[o]; r = g = b = v; a = 255
            else:
                idx = row[o]
                r, g, b = plte[idx * 3:idx * 3 + 3]
                a = trns[idx] if idx < len(trns) else 255
            px.append((a << 24) | (r << 16) | (g << 8) | b)
    if w <= size and h <= size:
        return w, h, px
    ds = []
    for y in range(size):
        sy = min(h - 1, int(y * h / size))
        for x in range(size):
            sx = min(w - 1, int(x * w / size))
            ds.append(px[sy * w + sx])
    return size, size, ds


def _client_windows() -> list[int]:
    """当前会话的应用窗口 id（xpra 把真实应用挂到 _NET_CLIENT_LIST）。"""
    try:
        disp = os.environ.get('DISPLAY', ':0')
        r = subprocess.run(['xprop', '-display', disp, '-root', '_NET_CLIENT_LIST'],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
        return [int(x, 16) for x in re.findall(r'0x[0-9a-fA-F]+',
                                               r.stdout.decode('utf-8', 'replace'))]
    except Exception:
        return []


def _icon_helper_path() -> str | None:
    """定位内嵌的 lptv_icon C 助手（AppDir/usr/libexec 或 libexec/）。

    libX11 的 XChangeProperty 把数据当 8 字节 XValue 读，ctypes 数组会错位
    损坏；xprop -set 的解析器只认前 64 个元素（大图标 "List truncated"）。
    只有原生 C 调用可靠，所以内嵌了一个 200 行不到的 C 助手。
    """
    cands = [
        os.environ.get('LPTV_ICON_HELPER') or '',
        os.path.abspath(os.path.join(
            os.path.dirname(__file__), '..', '..', '..', '..', '..',
            'libexec', 'lptv_icon')),
        shutil.which('lptv_icon') or '',
    ]
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def _set_window_icon(icon_path: str | None = None) -> bool:
    """把 LPTV 图标写进窗口的 _NET_WM_ICON 属性。成功返回 True。

    写多尺寸图标（128/64/32/16），WM 按显示尺寸选最合适的一张。数据经
    lptv_icon 助手以二进制流（小端 32 位卡片）传给 XChangeProperty。
    """
    icon_path = icon_path or os.environ.get('LPTV_SPLASH_ICON')
    if not icon_path or not os.path.isfile(icon_path):
        return False
    try:
        card = []
        for s in (128, 64, 32, 16):
            w, h, px = _png_to_argb(icon_path, s)
            card += [w, h] + px
    except Exception as e:
        logger.warning('[chromium] window icon decode failed: %s', e)
        return False
    wins = _client_windows()
    if not wins:
        return False
    helper = _icon_helper_path()
    if not helper:
        logger.warning('[chromium] lptv_icon helper not found')
        return False
    blob = struct.pack('<%dI' % len(card), *card)
    ok = False
    for wid in wins:
        try:
            r = subprocess.run([helper, hex(wid), '_NET_WM_ICON'], input=blob,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=10)
            ok = ok or (r.returncode == 0)
        except Exception as e:
            logger.warning('[chromium] window icon helper failed: %s', e)
    if ok:
        logger.info('[chromium] window icon set on %s (%s)', wins, card[:2])
    return ok


def _retry_window_icon(icon_path: str, attempts: int = 5, delay: float = 2.0) -> None:
    """窗口建立可能晚于页面加载，带重试地写窗口图标。"""
    for i in range(attempts):
        if _set_window_icon(icon_path):
            return
        time.sleep(delay * (i + 1))


def _undecorate_window() -> bool:
    """去掉窗口的 WM 装饰（标题栏/窗口控制按钮）。

    Chrome 的 app 窗口默认带装饰（_MOTIF_WM_HINTS decorations=1），xpra 作为
    WM 会渲染标题栏 + 最小化/最大化/关闭。把 decorations 置 0 后 WM 随即
    移除。属性类型必须用 _MOTIF_WM_HINTS 原子（用 CARDINAL 部分 WM 忽略）。
    """
    wins = _client_windows()
    if not wins:
        return False
    helper = _icon_helper_path()
    if not helper:
        logger.warning('[chromium] lptv_icon helper not found (undecorate)')
        return False
    ok = False
    for wid in wins:
        try:
            r = subprocess.run([helper, 'undecorate', hex(wid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=10)
            ok = ok or (r.returncode == 0)
        except Exception as e:
            logger.warning('[chromium] undecorate helper failed: %s', e)
    if ok:
        logger.info('[chromium] window undecorated on %s', wins)
    return ok


def _retry_undecorate(attempts: int = 5, delay: float = 2.0) -> None:
    """窗口建立可能晚于页面加载，带重试地去装饰。"""
    for i in range(attempts):
        if _undecorate_window():
            return
        time.sleep(delay * (i + 1))


def _inject_bridge(window, rec: dict, register_script: bool = True) -> None:
    """Inject the pywebview JS bridge. Runs synchronously to completion.

    ``pywebview.util.inject_pywebview`` spawns its own thread for the actual
    injection, which would let ``events.loaded`` fire before the bridge exists.
    We reproduce its logic inline so the caller can guarantee ordering.
    """
    cdp: CDP = rec['cdp']
    sid = rec['session_id']

    try:
        window.events.before_load.set()
    except Exception:
        pass

    js_code, finish_script = load_js_files(window, renderer)
    # Splash first: it must paint before the site's own HTML/JS, and it sets
    # the favicon + document.title that Chrome turns into _NET_WM_ICON / _NET_WM_NAME.
    splash = _splash_source()
    head = (splash + '\n') if splash else ''
    injected = head + js_code + '\n' + BRIDGE_SHIM

    if register_script and not rec.get('_script_registered'):
        # Present on every future top-level navigation, before the site's JS.
        cdp.call('Page.addScriptToEvaluateOnNewDocument',
                 {'source': injected, 'runImmediately': True},
                 timeout=15.0, session_id=sid)
        rec['_script_registered'] = True

    try:
        cdp.call('Runtime.addBinding', {'name': BINDING_NAME},
                 timeout=10.0, session_id=sid)
        r = cdp.evaluate(injected,
                        session_id=sid, timeout=30.0, await_promise=False)
        if not r:
            raise RuntimeError('bridge js_code did not evaluate')
        with window._expose_lock:
            functions = _collect_functions(window._js_api) if window._js_api is not None else {}
            if window._functions:
                functions.update({n: _func_args(f) for n, f in window._functions.items()})
            func_list = [{'func': n, 'params': p} for n, p in functions.items()]
        r2 = cdp.evaluate(finish_script % {'functions': json.dumps(func_list)},
                          session_id=sid, timeout=30.0, await_promise=False)
        if not r2:
            raise RuntimeError('bridge finish_script did not evaluate')
    except Exception:
        logger.exception('[chromium] bridge injection failed')
    finally:
        for name in ('_pywebviewready', 'loaded', 'shown'):
            try:
                getattr(window.events, name).set()
            except Exception:
                pass
        # 窗口图标：Chrome 只在窗口建立那一刻取 favicon，之后页面里的
        # <link rel=icon> 怎么改都不再更新窗口图标。所以直接写 _NET_WM_ICON
        # 属性（详见 _set_window_icon 的注释）。
        if os.environ.get('LPTV_SPLASH_ICON') and not rec.get('_icon_done'):
            rec['_icon_done'] = True
            Thread(target=_retry_window_icon,
                   args=(os.environ['LPTV_SPLASH_ICON'],), daemon=True,
                   name='wicon-%s' % window.uid).start()
        # 去掉窗口标题栏/控制按钮（xpra WM 装饰），直接全屏画面。
        if not rec.get('_undecorated'):
            rec['_undecorated'] = True
            Thread(target=_retry_undecorate, daemon=True,
                   name='undecor-%s' % window.uid).start()


def _apply_initial_state(window, rec: dict) -> None:
    if window.hidden:
        return
    if window.fullscreen:
        rec['window_state'] = 'fullscreen'
        rec['pre_fullscreen'] = dict(rec['bounds'])
        rec['fullscreen'] = True
    elif window.maximized:
        rec['window_state'] = 'maximized'
    _set_bounds(window.uid)


def _set_bounds(uid: str) -> None:
    rec = WINDOWS.get(uid)
    if not rec:
        return
    b = dict(rec['bounds'])
    rec['cdp'].call(
        'Browser.setWindowBounds',
        {'windowId': _window_id(rec), 'bounds': b, 'windowState': rec['window_state']},
        timeout=15.0,
    )
    # Chrome echoes back authoritative geometry; keep our record in sync.
    got = _r(rec['cdp'].call('Browser.getWindowForTarget',
                             {'targetId': rec['target_id']}, timeout=15.0)).get('bounds')
    if got:
        for src, dst in (('left', 'left'), ('top', 'top'),
                         ('width', 'width'), ('height', 'height')):
            if got.get(src) is not None:
                b[src] = got[src]
        if got.get('windowState'):
            rec['window_state'] = got['windowState']
    rec['bounds'] = b


def _window_id(rec: dict) -> int:
    wid = rec.get('wid')
    if wid:
        return wid
    resp = rec['cdp'].call('Browser.getWindowForTarget',
                           {'targetId': rec['target_id']}, timeout=15.0)
    wid = _r(resp).get('windowId')
    if not wid and resp.get('error'):
        logger.warning('[chromium] getWindowForTarget: %r', resp['error'])
    if wid:
        rec['wid'] = wid
    return wid or 0


def _window_from_uid(uid: str):
    return WINDOWS.get(uid)


# -- window operations -----------------------------------------------------
def set_title(title: str, uid: str) -> None:
    """In ``--app`` mode the window title tracks document.title; nothing to do."""
    rec = _window_from_uid(uid)
    if not rec:
        return
    try:
        rec['cdp'].call('Page.updateDocumentMetadata', {'title': title},
                        timeout=10.0, session_id=rec['session_id'])
    except Exception:
        pass


def get_current_url(uid: str):
    rec = _window_from_uid(uid)
    if not rec:
        return None
    r = rec['cdp'].evaluate('location.href', session_id=rec['session_id'],
                            timeout=10.0, await_promise=False)
    return (r or {}).get('value')


def load_url(url: str, uid: str) -> None:
    rec = _window_from_uid(uid)
    if not rec:
        return
    rec['cdp'].call('Page.navigate', {'url': url}, timeout=30.0,
                    session_id=rec['session_id'])


def load_html(content: str, base_uri: str, uid: str) -> None:
    rec = _window_from_uid(uid)
    if not rec:
        return
    data = 'data:text/html;base64,' + base64.b64encode(content.encode('utf-8')).decode()
    rec['cdp'].call('Page.navigate', {'url': data}, timeout=30.0,
                    session_id=rec['session_id'])


def clear_cookies(uid: str) -> None:
    rec = _window_from_uid(uid)
    if not rec:
        return
    rec['cdp'].call('Storage.clearDataForOrigin',
                    {'origin': 'http://127.0.0.1', 'storageTypes': 'cookies'},
                    timeout=15.0)


def get_cookies(uid: str):
    rec = _window_from_uid(uid)
    if not rec:
        return []
    return _r(rec['cdp'].call('Storage.getCookies', {}, timeout=15.0)).get('cookies', [])


def destroy_window(uid: str) -> None:
    rec = _window_from_uid(uid)
    if not rec:
        return
    try:
        rec['cdp'].call('Browser.closeWindow', {'windowId': _window_id(rec)}, timeout=10.0)
    except Exception:
        pass
    WINDOWS.pop(uid, None)


def hide(uid: str) -> None:
    rec = _window_from_uid(uid)
    if rec:
        rec['window_state'] = 'minimized'
        _set_bounds(uid)


def show(uid: str) -> None:
    rec = _window_from_uid(uid)
    if not rec:
        return
    rec['window_state'] = 'normal'
    _set_bounds(uid)
    rec['cdp'].call('Page.bringToFront', {}, timeout=10.0, session_id=rec['session_id'])


def maximize(uid: str) -> None:
    rec = _window_from_uid(uid)
    if rec:
        rec['window_state'] = 'maximized'
        _set_bounds(uid)


def minimize(uid: str) -> None:
    rec = _window_from_uid(uid)
    if rec:
        rec['window_state'] = 'minimized'
        _set_bounds(uid)


def restore(uid: str) -> None:
    rec = _window_from_uid(uid)
    if rec:
        rec['window_state'] = 'normal'
        _set_bounds(uid)


def toggle_fullscreen(uid: str) -> None:
    rec = _window_from_uid(uid)
    if not rec:
        return
    if rec['fullscreen']:
        rec['fullscreen'] = False
        rec['window_state'] = 'normal'
        if rec.get('pre_fullscreen'):
            rec['bounds'] = dict(rec['pre_fullscreen'])
    else:
        rec['fullscreen'] = True
        rec['window_state'] = 'fullscreen'
        rec['pre_fullscreen'] = dict(rec['bounds'])
    _set_bounds(uid)


def set_on_top(uid: str, top: bool) -> None:
    """CDP has no stacking-order primitive; fall back to xdotool."""
    rec = _window_from_uid(uid)
    if not rec:
        return
    xid = _xdotool_window()
    if not xid:
        return
    subprocess.run(['xdotool', 'window', xid, 'windowpin' if top else 'windowunpin'],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)


def _xdotool_window() -> str | None:
    if _BROWSER_PROC is None:
        return None
    try:
        out = subprocess.run(['xdotool', 'search', '--pid', str(_BROWSER_PROC.pid)],
                             capture_output=True, text=True, timeout=5).stdout
        ids = out.split()
        return ids[0] if ids else None
    except Exception:
        return None


def resize(width: int, height: int, uid: str, fix_point) -> None:
    rec = _window_from_uid(uid)
    if not rec:
        return
    rec['bounds']['width'] = int(width)
    rec['bounds']['height'] = int(height)
    _set_bounds(uid)


def move(x: int, y: int, uid: str) -> None:
    rec = _window_from_uid(uid)
    if not rec:
        return
    rec['bounds']['left'] = int(x)
    rec['bounds']['top'] = int(y)
    _set_bounds(uid)


def get_position(uid: str):
    rec = _window_from_uid(uid)
    if not rec:
        return None, None
    return rec['bounds'].get('left'), rec['bounds'].get('top')


def get_size(uid: str):
    rec = _window_from_uid(uid)
    if not rec:
        return None, None
    return rec['bounds'].get('width'), rec['bounds'].get('height')


def create_confirmation_dialog(title: str, message: str, uid: str) -> bool:
    rec = _window_from_uid(uid)
    if not rec:
        return True
    r = rec['cdp'].evaluate(
        '(function(){try{return String(window.confirm(%r))}catch(e){return "true"}})()'
        % json.dumps(message),
        session_id=rec['session_id'], timeout=10.0, await_promise=False,
    )
    return (r or {}).get('value') == 'true'


def create_file_dialog(dialog_type: int, directory: str, allow_multiple: bool,
                       save_filename: str, file_types, uid: str):
    """No reliable CDP path for file choosers; bridge this in Python instead."""
    logger.info('[chromium] create_file_dialog unsupported (type=%s)', dialog_type)
    return None


def evaluate_js(script: str, uid: str, parse_json: bool = True,
                unique_id: str | None = None):
    rec = _window_from_uid(uid)
    if not rec:
        return ''
    r = rec['cdp'].evaluate(script, session_id=rec['session_id'], timeout=30.0)
    if not r:
        return ''
    if r.get('subtype') == 'error':
        return ''
    value = r.get('value')
    if value is None:
        return ''
    if parse_json and isinstance(value, str) and value:
        try:
            return json.loads(value)
        except Exception:
            return value
    return value


def add_tls_cert(certfile: str) -> None:
    logger.info('[chromium] add_tls_cert ignored: %s', certfile)


def stop() -> None:
    for uid in list(WINDOWS):
        destroy_window(uid)
