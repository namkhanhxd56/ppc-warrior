#!/usr/bin/env bash
# ============================================================
# PPC Warrior Worker — Cài đặt VPS (Ubuntu 22.04 / 24.04)
# Chạy: bash setup-vps.sh
# Làm gì: Node 20 + Google Chrome + xvfb (headful ảo) + pm2 (chạy nền, tự khởi động)
# ============================================================
set -e

echo "== [1/5] Node.js 20 =="
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== [2/5] Google Chrome thật + thư viện phụ thuộc =="
if ! command -v google-chrome >/dev/null; then
  wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt-get install -y /tmp/chrome.deb
  rm /tmp/chrome.deb
fi
google-chrome --version

echo "== [3/5] xvfb — màn hình ảo để chạy HEADFUL trên VPS (headless là dấu hiệu bot lớn nhất) =="
sudo apt-get install -y xvfb

echo "== [4/5] npm install =="
npm install

echo "== [5/5] pm2 — chạy nền + tự khởi động cùng VPS =="
sudo npm install -g pm2
pm2 delete ppc-worker 2>/dev/null || true
pm2 start npm --name ppc-worker -- run start:vps
pm2 save
pm2 startup -u "$USER" --hp "$HOME" | tail -1

echo ""
echo "✅ XONG. Kiểm tra:"
echo "   pm2 logs ppc-worker     # xem log (chờ dòng 🚀 PPC Warrior Worker)"
echo "   pm2 restart ppc-worker  # restart sau khi sửa code/.env"
echo ""
echo "⚠️ VIỆC CẦN LÀM TIẾP (bảo mật + cấu hình):"
echo "   1. Đặt mật khẩu UI: thêm WORKER_PASSWORD=matkhaucuaban vào .env rồi pm2 restart ppc-worker"
echo "   2. Mở UI: http://IP_VPS:3100 (user gõ gì cũng được, password = WORKER_PASSWORD)"
echo "      — hoặc an toàn hơn: đừng mở port, dùng SSH tunnel:"
echo "        ssh -L 3100:localhost:3100 user@IP_VPS  → mở http://localhost:3100 trên máy bạn"
echo "   3. Vào UI đặt zip code (VPS US thì IP đã chuẩn US — vẫn nên đặt zip cố định)"
