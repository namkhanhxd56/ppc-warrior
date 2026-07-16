# PPC Warrior Worker — Railway / Docker
# Node 20 + Google Chrome thật + xvfb (chạy HEADFUL trong container không màn hình)
FROM node:20-slim

# Google Chrome + xvfb + fonts (thiếu font cũng là dấu hiệu fingerprint bất thường)
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates xvfb fonts-liberation fonts-noto-color-emoji \
  && wget -q -O- https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Không tải Chromium bundled của Puppeteer — dùng Chrome thật đã cài ở trên
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Dữ liệu bền vững: gắn Railway VOLUME vào /app/data (results, daily-rank, cookies,
# chrome-profile đều nằm trong này — không gắn volume là MẤT SẠCH mỗi lần deploy)
ENV RUN_MODE=queue \
    CHROME_CHANNEL=chrome \
    HEADFUL=1 \
    WORKER_PROFILE=/app/data/chrome-profile \
    COOKIES_PATH=/app/data/cookies.json
# RUN_MODE=queue: server chỉ làm UI + hàng đợi job + lưu kết quả — KHÔNG scrape.
# Agent trên máy cá nhân từng người kéo job về chạy (npm run agent).
# Muốn server tự scrape (không khuyến nghị — IP datacenter): đổi Variables RUN_MODE=local

EXPOSE 3100
CMD ["bash", "-c", "xvfb-run -a --server-args='-screen 0 1366x900x24' node server.js"]
