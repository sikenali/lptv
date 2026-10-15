# LPTV Direct Dockerfile (no VNC, no Xvfb, no bridge)
FROM registry.lazycat.cloud/debian-bookworm:0.0.1

USER root

RUN apt-get update && apt-get install -y chromium fonts-noto-cjk xdg-utils && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /lptv/app/extension /lptv/app/asset /lptv/data

COPY app/ /lptv/app/
COPY entrypoint.sh /lptv/app/entrypoint.sh
RUN chmod +x /lptv/app/entrypoint.sh

ENV LPTV_APP_DIR=/lptv/app
ENV LPTV_DATA_DIR=/lptv/data

ENTRYPOINT ["/lptv/app/entrypoint.sh"]
