"""Idempotently patch an installed ``webview/guilib.py`` to accept ``gui='chromium'``.

pywebview's backend selector hard-codes the list of known backends. Rather than
fork the whole package, this mutates the three places that matter and is safe to
re-run.

Usage:
    python3 patch_guilib.py <path-to-site-packages>
"""

from __future__ import annotations

import os
import sys

NEEDLE_TYPE = "Literal['qt', 'gtk', 'cef', 'mshtml', 'edgechromium', 'android', 'cocoa']"
NEEDLE_TYPE_NEW = "Literal['qt', 'gtk', 'cef', 'mshtml', 'edgechromium', 'android', 'cocoa', 'chromium']"

IMPORT_QT_ANCHOR = """    def import_qt():
        global guilib

        try:
            import webview.platforms.qt as guilib

            return True
        except ImportError:
            logger.exception('QT cannot be loaded')
            return False
"""

IMPORT_CHROMIUM = """    def import_chromium():
        global guilib

        try:
            import webview.platforms.chromium as guilib

            logger.debug('Using Chromium')
            return True
        except ImportError:
            logger.exception('Chromium cannot be loaded')
            return False

"""

LINUX_ANCHOR = """    elif platform.system() == 'Linux' or platform.system() == 'OpenBSD':
        if forced_gui == 'qt':"""

LINUX_NEW = """    elif platform.system() == 'Linux' or platform.system() == 'OpenBSD':
        if forced_gui == 'chromium':
            guis = [import_chromium]
            if not try_import(guis):
                raise WebViewException(
                    'The chromium backend was requested but webview.platforms.chromium '
                    'could not be imported.'
                )
            guilib.setup_app()
            return guilib
        if forced_gui == 'qt':"""


def patch_text(src: str) -> tuple[str, list[str]]:
    notes: list[str] = []
    if NEEDLE_TYPE_NEW not in src:
        if NEEDLE_TYPE in src:
            src = src.replace(NEEDLE_TYPE, NEEDLE_TYPE_NEW)
            notes.append('GUIType literal: added chromium')
        else:
            notes.append('WARNING: GUIType literal not found')

    if 'def import_chromium():' not in src:
        if IMPORT_QT_ANCHOR in src:
            src = src.replace(IMPORT_QT_ANCHOR, IMPORT_QT_ANCHOR + IMPORT_CHROMIUM, 1)
            notes.append('added import_chromium()')
        else:
            notes.append('WARNING: import_qt anchor not found')

    if 'forced_gui == \'chromium\':' not in src:
        if LINUX_ANCHOR in src:
            src = src.replace(LINUX_ANCHOR, LINUX_NEW, 1)
            notes.append('added Linux chromium dispatch')
        else:
            notes.append('WARNING: Linux anchor not found')
    elif 'forced_gui == \'chromium\':' in src and 'return guilib' not in src.split("forced_gui == 'chromium'")[1][:400]:
        old_block = (
            "'could not be imported.'\n"
            "                )\n"
            "            return\n"
            "        if forced_gui == 'qt':"
        )
        new_block = (
            "'could not be imported.'\n"
            "                )\n"
            "            guilib.setup_app()\n"
            "            return guilib\n"
            "        if forced_gui == 'qt':"
        )
        if old_block in src:
            src = src.replace(old_block, new_block, 1)
            notes.append('fixed chromium dispatch to return guilib')
        else:
            notes.append('WARNING: could not locate chromium dispatch return')

    return src, notes


def main() -> int:
    sp = sys.argv[1] if len(sys.argv) > 1 else '.'
    path = os.path.join(sp, 'webview', 'guilib.py')
    if not os.path.exists(path):
        print('NOT_FOUND %s' % path)
        return 2
    with open(path, encoding='utf-8') as f:
        src = f.read()
    new, notes = patch_text(src)
    if notes:
        print(' / '.join(notes))
    else:
        print('already patched')
    if new != src:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new)
    compile(new, path, 'exec')
    print('COMPILE_OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
