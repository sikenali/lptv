# -*- coding: utf-8 -*-
"""允许 `python -m app` 直接启动（等价于 `python -m app.main`）。"""
from .main import main

if __name__ == "__main__":
    main()
