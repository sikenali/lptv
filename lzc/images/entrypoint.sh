#!/bin/bash
# LPTV v2 entrypoint: Chromium kiosk direct to 789iptv.com (no VNC, no bridge)
set -e

exec chromium \
  --no-sandbox \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-dev-shm-usage \
  --kiosk \
  --ignore-certificate-errors \
  --load-extension=/lptv/app/extension \
  --user-data-dir=/tmp/chromium-profile \
  --window-size=1920,1080 \
  --start-fullscreen \
  --autoplay-policy=no-user-gesture-required \
  --disable-translate \
  --disable-features=TranslateUI,Notification,PasswordManager \
  --disable-extensions-except=/lptv/app/extension \
  --disable-popup-blocking \
  --disable-infobars \
  --disable-default-apps \
  "https://www.789iptv.com/"
